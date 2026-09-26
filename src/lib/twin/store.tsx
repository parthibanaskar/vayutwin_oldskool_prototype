// @ts-nocheck
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  alertFromCandidate,
  derive,
  estimateRul,
  evaluateAlerts,
  type Derived,
} from "./analytics";
import { appendEntry } from "./blackbox";
import { SCENARIO_BY_KEY } from "./profiles";
import { HEAL_PLAYBOOK } from "./selfheal";
import { HardwareTelemetrySource, SimulatedTelemetrySource } from "./simulator";
import type {
  Alert,
  BlackBoxEntry,
  FlightProfile,
  SelfHealAction,
  Subsystem,
} from "./types";
import { SUBSYSTEMS } from "./types";

const FRAME_CAP = 10000;
const ALERT_COOLDOWN_MS = 2000; // 2 seconds for demo responsiveness

export interface Frame {
  sample: Derived["sample"];
  derived: Derived;
}

interface MissionState {
  isDiverted: boolean;
  missionId: string;
  frames: Frame[];
  live: Derived | null;
  displayed: Derived | null;
  cursor: number | null;
  alerts: Alert[];
  healActions: SelfHealAction[];
  blackbox: BlackBoxEntry[];
  profile: FlightProfile;
  paused: boolean;
  speed: number;
  fuelPath: "primary" | "secondary";
  activeFaults: string[];
  navMode: "gnss" | "inertial";
  focusHotspot: string | null;
  selectedAlertId: string | null;
  resolvedAlerts: Set<string>;
  silentlyResolvedAlerts: Set<string>;
  rul: Partial<Record<Subsystem, number | null>>;
  sourceKind: "simulated" | "hardware";
  sessionId: string | null;
}

interface MissionApi extends MissionState {
  setProfile: (p: FlightProfile) => void;
  injectFault: (key: string) => void;
  clearFault: (key: string) => void;
  reduceThrottle: () => void;
  setThrottle: (throttle: number) => void;
  divert: (lat: number, lon: number) => void;
  calibrate: () => void;
  applyHealAction: (key: string) => void;
  clearAllFaults: () => void;
  setPaused: (p: boolean) => void;
  setSpeed: (s: number) => void;
  setCursor: (index: number | null) => void;
  setFuelPath: (path: "primary" | "secondary") => void;
  setFocusHotspot: (hotspot: string | null) => void;
  selectAlert: (id: string | null) => void;
  setResolvedAlerts: (fn: (prev: Set<string>) => Set<string>) => void;
  commandSafeLanding: (siteName: string) => void;
  log: (kind: string, payload: Record<string, unknown>) => void;
}

const MissionContext = createContext<MissionApi | null>(null);

function makeMissionId() {
  const n = Math.floor(Math.random() * 900 + 100);
  return `SIH26054-${n}`;
}

export function MissionProvider({ children }: { children: ReactNode }) {
  const sourceRef = useRef<HardwareTelemetrySource | null>(null);
  const chainRef = useRef<BlackBoxEntry[]>([]);
  const chainQueue = useRef<Promise<void>>(Promise.resolve());
  const activeAlertKeys = useRef<Set<string>>(new Set());
  const alertCooldowns = useRef<Map<string, number>>(new Map());
  const healthHistory = useRef<Record<string, { t: number; value: number }[]>>(
    {},
  );
  const snapshotQueue = useRef<
    { t: string; flight_profile: string; params: never; health: never }[]
  >([]);
  const sessionIdRef = useRef<string | null>(null);
  const ignoreUntil = useRef<number>(0);

  const [missionId, setMissionId] = useState(makeMissionId);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [live, setLive] = useState<Derived | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [healActions, setHealActions] = useState<SelfHealAction[]>([]);
  const [blackbox, setBlackbox] = useState<BlackBoxEntry[]>([]);
  const [profile, setProfileState] = useState<FlightProfile>("cruise");
  const [paused, setPausedState] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [fuelPath, setFuelPathState] = useState<"primary" | "secondary">(
    "primary",
  );
  const [activeFaults, setActiveFaults] = useState<string[]>([]);
  const [navMode, setNavMode] = useState<"gnss" | "inertial">("gnss");
  const [isDiverted, setIsDiverted] = useState(false);
  const [focusHotspot, setFocusHotspot] = useState<string | null>(null);
  const [selectedAlertId, selectAlert] = useState<string | null>(null);
  const [resolvedAlerts, setResolvedAlerts] = useState<Set<string>>(new Set());
  const [silentlyResolvedAlerts, setSilentlyResolvedAlerts] = useState<
    Set<string>
  >(new Set());
  const [rul, setRul] = useState<Partial<Record<Subsystem, number | null>>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Auto-resolve critical alerts to show the mitigation UI popup automatically
  const resolvingRef = useRef(new Set<string>());
  useEffect(() => {
    if (paused) return;
  }, [alerts, resolvedAlerts, paused]);

  const log = useCallback((kind: string, payload: Record<string, unknown>) => {
    chainQueue.current = chainQueue.current.then(async () => {
      const entry = await appendEntry(chainRef.current, kind, payload);
      chainRef.current = [...chainRef.current, entry].slice(-200);
      setBlackbox(chainRef.current);
      const sid = sessionIdRef.current;
      if (sid) {
        try {
          await supabase.from("blackbox_entries").insert({
            session_id: sid,
            seq: entry.seq,
            kind: entry.kind,
            payload: entry.payload as never,
            prev_hash: entry.prevHash,
            hash: entry.hash,
          });
        } catch {
          /* offline-tolerant: the in-memory chain stays authoritative */
        }
      }
    });
  }, []);

  // --- Session bootstrap ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase
          .from("telemetry_sessions")
          .insert({
            mission_name: missionId,
            flight_profile: "cruise",
            synthetic: true,
          })
          .select("id")
          .single();
        if (!cancelled && data) {
          sessionIdRef.current = data.id;
          setSessionId(data.id);
        }
      } catch {
        /* dashboard runs fine without persistence */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  // --- Telemetry loop ---------------------------------------------------
  useEffect(() => {
    const source = new HardwareTelemetrySource();
    sourceRef.current = source;
    log("mission.start", {
      missionId,
      mode: "HARDWARE_IN_LOOP",
      source: "websocket-edge-v1",
    });

    source.start((sample) => {
      if (Date.now() < ignoreUntil.current) return; // IGNORE old frames from the backend immediately after reset

      const d = derive(sample);
      setLive(d);
      setFrames((prev) => [...prev, { sample, derived: d }].slice(-FRAME_CAP));
      setNavMode(d.gpsErrorMetres > 45 ? "inertial" : "gnss");

      // degradation history for RUL
      for (const sub of SUBSYSTEMS) {
        const list = healthHistory.current[sub] ?? [];
        list.push({ t: sample.t, value: d.health.subsystems[sub] });
        healthHistory.current[sub] = list.slice(-90);
      }
      const nextRul: Partial<Record<Subsystem, number | null>> = {};
      for (const sub of SUBSYSTEMS)
        nextRul[sub] = estimateRul(healthHistory.current[sub] ?? []);
      setRul(nextRul);

      // queue a downsampled snapshot roughly every 8 ticks
      if (Math.round(sample.t / 0.75) % 8 === 0) {
        snapshotQueue.current.push({
          t: new Date(sample.wallClock).toISOString(),
          flight_profile: sample.profile,
          params: sample.params as never,
          health: d.health as never,
        });
      }

      // --- alert engine (edge-triggered) ---
      const currentCandidates = evaluateAlerts(d);
      const newActiveKeys = new Set(currentCandidates.map((c) => c.key));

      // Clear keys that are no longer active so they can trigger again if re-injected
      for (const key of activeAlertKeys.current) {
        if (!newActiveKeys.has(key)) {
          activeAlertKeys.current.delete(key);

          // Auto-resolve any alert that naturally clears (e.g., sensor returns to nominal, or landing mode suppresses it)
          // This ensures the AI automatically resolves minor statistical anomalies and UI doesn't show stale alerts.
          setAlerts((prev) => {
            const target = prev.find((a) => a.key === key);
            if (target) {
              setResolvedAlerts((r) => new Set(r).add(target.id));
              setSilentlyResolvedAlerts((r) => new Set(r).add(target.id));
            }
            return prev;
          });
        }
      }

      const now = Date.now();
      for (const candidate of currentCandidates) {
        if (activeAlertKeys.current.has(candidate.key)) continue;

        // Debounce: prevent rapid re-triggering of the exact same alert within 20 seconds
        const lastTriggered = alertCooldowns.current.get(candidate.key) || 0;
        if (now - lastTriggered < 20000) continue;

        activeAlertKeys.current.add(candidate.key);
        alertCooldowns.current.set(candidate.key, now);

        const alert = alertFromCandidate(
          candidate,
          sample.t,
          nextRul[candidate.subsystem] ?? null,
        );
        setAlerts((prev) => [alert, ...prev].slice(0, 60));
        log("alert.raised", {
          key: alert.key,
          severity: alert.severity,
          confidence: alert.confidence,
          rulMinutes: alert.rulMinutes,
          top: alert.contributions[0]?.label ?? null,
        });
        const sid = sessionIdRef.current;
        if (sid) {
          void supabase
            .from("alerts")
            .insert({
              session_id: sid,
              subsystem: alert.subsystem,
              title: alert.title,
              severity: alert.severity,
              confidence: alert.confidence,
              rul_minutes: alert.rulMinutes,
              contributions: alert.contributions as never,
              narrative: alert.narrative,
            })
            .then(
              () => undefined,
              () => undefined,
            );
        }

        // --- self-healing playbook ---
        const plan = HEAL_PLAYBOOK[candidate.key];
        if (plan) {
          const actions: SelfHealAction[] = plan.map((step, i) => ({
            id: `${candidate.key}-${Math.round(sample.t)}-${i}`,
            at: Date.now() + i,
            triggerKey: candidate.key,
            action: step.action,
            status: step.status,
            detail: step.detail,
          }));
          setHealActions((prev) => {
            if (
              prev.some(
                (a) =>
                  a.triggerKey === candidate.key && a.status === "recommended",
              )
            ) {
              return prev;
            }
            return [...actions.reverse(), ...prev].slice(0, 40);
          });
          log("selfheal.applied", {
            key: candidate.key,
            steps: plan.map((s) => s.action),
          });
          if (sid) {
            void supabase
              .from("self_heal_actions")
              .insert(
                actions.map((a) => ({
                  session_id: sid,
                  trigger_key: a.triggerKey,
                  action: a.action,
                  status: a.status,
                  detail: a.detail,
                })),
              )
              .then(
                () => undefined,
                () => undefined,
              );
          }
        }
      }
    });

    return () => {
      source.stop();
      sourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- batched snapshot flush ------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      const sid = sessionIdRef.current;
      const batch = snapshotQueue.current.splice(
        0,
        snapshotQueue.current.length,
      );
      if (!sid || batch.length === 0) return;
      void supabase
        .from("telemetry_snapshots")
        .insert(batch.map((row) => ({ session_id: sid, ...row })))
        .then(
          () => undefined,
          () => undefined,
        );
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  const setProfile = useCallback(
    (p: FlightProfile) => {
      sourceRef.current?.setProfile(p);
      setProfileState(p);
      log("profile.change", { profile: p });
    },
    [log],
  );

  const injectFault = useCallback(
    (key: string) => {
      sourceRef.current?.injectFault(key);
      setActiveFaults((prev) => (prev.includes(key) ? prev : [...prev, key]));
      const scenario = SCENARIO_BY_KEY[key];
      log("fault.injected", {
        key,
        label: scenario?.label ?? key,
        groundTruth: true,
      });
      const sid = sessionIdRef.current;
      if (sid && scenario) {
        void supabase
          .from("fault_events")
          .insert({
            session_id: sid,
            scenario_key: scenario.key,
            label: scenario.label,
            subsystem: scenario.subsystem,
            severity: scenario.severity,
          })
          .then(
            () => undefined,
            () => undefined,
          );
      }
    },
    [log],
  );

  const clearFault = useCallback(
    (key: string) => {
      sourceRef.current?.clearFault(key);
      setActiveFaults((prev) => prev.filter((k) => k !== key));
      log("fault.clear", { key });
    },
    [log],
  );

  const reduceThrottle = useCallback(() => {
    sourceRef.current?.reduceThrottle();
    log("mission.prescriptive.throttleReduce", {});
  }, [log]);

  const setThrottle = useCallback(
    (throttle: number) => {
      if ("setThrottle" in (sourceRef.current as any)) {
        (sourceRef.current as any).setThrottle(throttle);
      }
      log("mission.setThrottle", { throttle });
    },
    [log],
  );

  const divert = useCallback(
    (lat: number, lon: number) => {
      setIsDiverted(true);
      if ("divert" in (sourceRef.current as any)) {
        (sourceRef.current as any).divert(lat, lon);
      }
      log("mission.divert", { lat, lon });
    },
    [log],
  );

  const calibrate = useCallback(() => {
    if ("calibrate" in (sourceRef.current as any)) {
      (sourceRef.current as any).calibrate();
    }
    log("ai.calibrate", {});
  }, [log]);

  const applyHealAction = useCallback((triggerKey: string) => {
    setHealActions((prev) =>
      prev.map((a) =>
        a.triggerKey === triggerKey ? { ...a, status: "applied" } : a,
      ),
    );
  }, []);

  const clearAllFaults = useCallback(() => {
    ignoreUntil.current = Date.now() + 1500;
    // Flush the async queue so stale blackbox log callbacks don't repopulate after clear
    chainQueue.current = Promise.resolve();
    sourceRef.current?.clearAllFaults();
    sourceRef.current?.setFuelPath("primary");
    setFuelPathState("primary");
    setActiveFaults([]);
    setIsDiverted(false);
    setFrames([]);
    setLive(null);
    setBlackbox([]);
    chainRef.current = [];
    setCursor(null);
    setResolvedAlerts(new Set());
    setSilentlyResolvedAlerts(new Set());
    setHealActions([]);
    setAlerts([]);
    setRul({});
    healthHistory.current = {};
    activeAlertKeys.current.clear();
    alertCooldowns.current.clear();
    resolvingRef.current.clear();
    const newId = makeMissionId();
    setMissionId(newId);

    log("SYSTEM_RESET", { new_mission: newId, status: "nominal" });
  }, [log]);

  const setPaused = useCallback((p: boolean) => {
    setPausedState(p);
    sourceRef.current?.setSpeed(p ? 0 : 1);
  }, []);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    sourceRef.current?.setSpeed(s);
  }, []);

  const setFuelPath = useCallback(
    (path: "primary" | "secondary") => {
      sourceRef.current?.setFuelPath(path);
      setFuelPathState(path);
      log("fuel.pathSwitch", { path });
    },
    [log],
  );

  const commandSafeLanding = useCallback(
    (siteName: string) => {
      log("safeLanding.commanded", { site: siteName, authority: "operator" });
      setHealActions((prev) => [
        {
          id: `landing-${Date.now()}`,
          at: Date.now(),
          triggerKey: "safeLanding",
          action: `Safe-landing sequence to ${siteName}`,
          status: "applied",
          detail:
            "Descent profile and approach path uploaded; power derated for glide reserve.",
        },
        ...prev,
      ]);
    },
    [log],
  );

  const displayed = useMemo(() => {
    if (cursor === null) return live;
    return frames[cursor]?.derived ?? live;
  }, [cursor, frames, live]);

  const value: MissionApi = {
    isDiverted,
    missionId,
    frames,
    live,
    displayed,
    cursor,
    alerts,
    healActions,
    blackbox,
    profile,
    paused,
    speed,
    fuelPath,
    activeFaults,
    navMode,
    focusHotspot,
    selectedAlertId,
    resolvedAlerts,
    silentlyResolvedAlerts,
    rul,
    sourceKind: "simulated",
    sessionId,
    setProfile,
    injectFault,
    clearFault,
    reduceThrottle,
    setThrottle,
    divert,
    calibrate,
    applyHealAction,
    clearAllFaults,
    setPaused,
    setSpeed,
    setCursor,
    setFuelPath,
    setFocusHotspot,
    selectAlert,
    setResolvedAlerts,
    commandSafeLanding,
    log,
  };

  return (
    <MissionContext.Provider value={value}>{children}</MissionContext.Provider>
  );
}

export function useMission() {
  const ctx = useContext(MissionContext);
  if (!ctx) throw new Error("useMission must be used inside MissionProvider");
  return ctx;
}
