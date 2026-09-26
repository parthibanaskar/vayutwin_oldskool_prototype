// @ts-nocheck
import { FLIGHT_PROFILES, PARAM_SPECS } from "./profiles";
import type { FlightProfile, ParamKey, Sample } from "./types";
import {
  getAtmosphere,
  getAeroDynamics,
  getThermodynamics,
  integrateParisLaw,
  estimateRUL,
  checkGPSconsistency,
} from "./physics";

/**
 * Ingestion boundary. The dashboard only ever reads from a TelemetrySource, so a
 * real hardware feed (serial / CAN / MQTT bridge) can replace the simulator
 * without touching any panel code.
 */
export interface TelemetrySource {
  readonly kind: "simulated" | "hardware";
  start(onSample: (sample: Sample) => void): void;
  stop(): void;
}

const VIB_WINDOW = 256;
const VIB_FS = 1024;
const BASE_LAT = 28.6139;
const BASE_LON = 77.209;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimulatorOptions {
  intervalMs?: number;
}

export class SimulatedTelemetrySource implements TelemetrySource {
  readonly kind = "simulated" as const;

  private timer: ReturnType<typeof setInterval> | undefined;
  private onSample: ((s: Sample) => void) | undefined;
  private t = 0;
  private readonly intervalMs: number;
  private profile: FlightProfile = "cruise";
  private faults = new Map<string, number>(); // key -> seconds active
  private fuelPath: "primary" | "secondary" = "primary";
  private smoothed: Partial<Record<ParamKey, number>> = {};
  private track = 0.9;
  private gpsBias = { lat: 0, lon: 0 };
  private inertial = { lat: BASE_LAT, lon: BASE_LON };
  private vibPhase = 0;
  private speedMultiplier = 1;
  private fatigueCrackMeters = 0.001; // Initial flaw size of 1mm
  private faultHistory = new Set<string>();
  private simulatedRulSeconds = 3.5 * 3600; // 3.5 hours base
  private hadFaults = false;

  constructor(options: SimulatorOptions = {}) {
    this.intervalMs = options.intervalMs ?? 750;
  }

  start(onSample: (s: Sample) => void) {
    this.onSample = onSample;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setProfile(profile: FlightProfile) {
    this.profile = profile;
  }

  setSpeed(multiplier: number) {
    this.speedMultiplier = multiplier;
  }

  setFuelPath(path: "primary" | "secondary") {
    this.fuelPath = path;
  }

  getFuelPath() {
    return this.fuelPath;
  }

  private isDiverting = false;
  private divertStartT = 0;
  private engineFailT = 0;

  divert(lat: number, lon: number) {
    this.isDiverting = true;
    this.divertStartT = this.t;
    this.setProfile("descent");
  }

  injectFault(key: string) {
    if (!this.faults.has(key)) this.faults.set(key, 0);
    this.faultHistory.add(key);
  }

  clearFault(key: string) {
    this.faults.delete(key);
    if (key === "gpsSpoof") this.gpsBias = { lat: 0, lon: 0 };
  }

  clearAllFaults() {
    this.faults.clear();
    this.gpsBias = { lat: 0, lon: 0 };
    this.faultHistory.clear();
    this.simulatedRulSeconds = 3.5 * 3600;
    this.hadFaults = false;
    this.t = 0;
    this.fatigueCrackMeters = 0.001;
    this.history = [];
    this.isDiverting = false;
    this.divertStartT = 0;
    this.engineFailT = undefined;
    this.smoothed = {};
    this.profile = "cruise";
    this.inertial = {
      lat: BASE_LAT,
      lon: BASE_LON,
      vLat: 0,
      vLon: 0,
    };
  }

  activeFaults() {
    return [...this.faults.keys()];
  }

  private progress(key: string, rampSeconds: number) {
    const age = this.faults.get(key);
    if (age === undefined) return 0;
    return clamp(age / rampSeconds, 0, 1);
  }

  private tick() {
    const dt = (this.intervalMs / 1000) * this.speedMultiplier;
    const isLandedLoc =
      this.isDiverting && (this.t - this.divertStartT) * 0.046 >= 4.0;
    let isCrashedLoc = false;
    if (this.engineFailT) {
      if (Math.max(0, 2000.0 - (this.t - this.engineFailT) * 300) <= 0)
        isCrashedLoc = true;
    }
    if (!isLandedLoc && !isCrashedLoc) {
      this.t += dt;
    }
    for (const k of Array.from(this.faults.keys())) {
      this.faults.set(k, (this.faults.get(k) || 0) + dt);
    }

    const spec = FLIGHT_PROFILES[this.profile];
    const raw: Record<ParamKey, number> = { ...spec.nominal };

    // ---- Fault physics -------------------------------------------------
    const bearing = this.progress("bearingWear", 2);
    const imbalance = this.progress("propImbalance", 2);
    const oilStarve = this.progress("oilStarvation", 2);
    const overtemp = this.progress("egtOvertemp", 2);
    const pumpDegrade = this.progress("fuelPumpDegrade", 2);
    const blockage = this.progress("fuelBlockage", 2);
    const drift = this.progress("sensorDrift", 2);
    const vibFail = this.progress("vibSensorFail", 2);
    const busSag = this.progress("busSag", 2);
    const spoof = this.progress("gpsSpoof", 2);
    const icing = this.progress("icing", 2);

    const fuelPathPenalty = this.fuelPath === "secondary" ? 0.04 : 0;
    const effectiveStarve =
      this.fuelPath === "secondary" ? blockage * 0.25 : blockage;
    const effectivePump =
      this.fuelPath === "secondary" ? pumpDegrade * 0.2 : pumpDegrade;

    raw.vibration += bearing * 7.4 + imbalance * 5.8 + icing * 0.9;
    raw.oilTemp += bearing * 22 + oilStarve * 34 + overtemp * 9;
    raw.oilPressure -= oilStarve * 2.6 + bearing * 0.35;
    raw.egt +=
      overtemp * 190 + effectiveStarve * 70 + icing * 26 - effectivePump * 20;
    raw.cht += overtemp * 62 + icing * 38 + bearing * 8;
    raw.fuelFlow -= effectivePump * 7.2 + effectiveStarve * 9.4;
    raw.fuelFlow -= raw.fuelFlow * fuelPathPenalty;
    raw.rpm -= effectivePump * 620 + effectiveStarve * 1350 + icing * 520;
    raw.rpm += imbalance * 40 * Math.sin(this.t / 3);
    raw.busVoltage -= busSag * 5.1;

    // ---- Smoothing + measurement noise ---------------------------------
    const params = {} as Record<ParamKey, number>;
    for (const key of Object.keys(raw) as ParamKey[]) {
      const target = raw[key];
      const prev = this.smoothed[key] ?? target;
      const alpha = 1 - Math.exp(-dt / 1.6);
      const next = prev + (target - prev) * alpha;
      this.smoothed[key] = next;
      const s = PARAM_SPECS[key];
      params[key] = clamp(next + gauss() * spec.noise[key], s.min, s.max);
    }

    // ---- Redundant channel B -------------------------------------------
    const redundant = {
      egt: clamp(params.egt - drift * 74 + gauss() * 4, 200, 950),
      vibration: clamp(params.vibration + gauss() * 0.14, 0, 22),
      oilPressure: clamp(params.oilPressure + gauss() * 0.05, 0, 7),
    };
    if (vibFail > 0.3) params.vibration = 0.05 + Math.random() * 0.03; // dead channel A
    if (drift > 0) params.egt = clamp(params.egt, 200, 950);

    // ---- Vibration waveform for the FFT --------------------------------
    const rotHz = Math.max(4, params.rpm / 60);
    const bpfo = rotHz * 3.57;
    const vibWave: number[] = [];
    for (let i = 0; i < VIB_WINDOW; i++) {
      const tt = this.vibPhase + i / VIB_FS;
      const amp1 = 0.55 + imbalance * 4.6;
      const ampB = 0.12 + bearing * 3.1;
      vibWave.push(
        amp1 * Math.sin(2 * Math.PI * rotHz * tt) +
          0.3 * Math.sin(2 * Math.PI * rotHz * 2 * tt) +
          ampB * Math.sin(2 * Math.PI * bpfo * tt) +
          ampB * 0.5 * Math.sin(2 * Math.PI * bpfo * 2 * tt + 1.1) +
          (0.18 + bearing * 0.5) * gauss(),
      );
    }
    this.vibPhase += VIB_WINDOW / VIB_FS;

    // ---- Navigation -----------------------------------------------------
    const metresPerDeg = 111_320;
    const speed = spec.airspeed;
    this.track += dt * 0.02;
    this.inertial = {
      lat:
        this.inertial.lat + (Math.cos(this.track) * speed * dt) / metresPerDeg,
      lon:
        this.inertial.lon +
        (Math.sin(this.track) * speed * dt) /
          (metresPerDeg * Math.cos((this.inertial.lat * Math.PI) / 180)),
    };
    if (spoof > 0) {
      this.gpsBias = {
        lat: this.gpsBias.lat + dt * 0.00028 * spoof,
        lon: this.gpsBias.lon + dt * 0.00021 * spoof,
      };
    }
    const gps = {
      lat: this.inertial.lat + this.gpsBias.lat + gauss() * 0.00002,
      lon: this.inertial.lon + this.gpsBias.lon + gauss() * 0.00002,
    };

    // --- Physics Engine Integration ---
    const altitude = this.profile === "cruise" ? 6000 : 1000;
    const { rho } = getAtmosphere(altitude);
    const aero = getAeroDynamics(rho, speed);

    // Convert kg/h to kg/s for the thermodynamics equation
    const fuelFlowKgS = params.fuelFlow / 3600;
    const airFlowKgS = fuelFlowKgS * 14.7; // simplified
    const thermo = getThermodynamics(params.rpm, fuelFlowKgS, airFlowKgS);

    // Fatigue and RUL: deltaSigma is proxy for engine stress, increases with vibration and rpm
    const stress_MPa = 40 + params.vibration * 2 + (params.rpm / 5000) * 10;
    const cycles_this_tick = (params.rpm / 60) * dt;
    this.fatigueCrackMeters = integrateParisLaw(
      this.fatigueCrackMeters,
      stress_MPa,
      cycles_this_tick,
    );
    // Base usage decay
    this.simulatedRulSeconds -= dt;

    if (this.faults.size > 0 && !this.isDiverting) {
      this.hadFaults = true;
      let maxAge = 0;
      for (const k of Array.from(this.faults.keys())) {
        const a = this.faults.get(k) || 0;
        if (a > maxAge) maxAge = a;
      }

      // If newly faulted, drop to ~70 mins
      if (this.simulatedRulSeconds > 70 * 60) {
        this.simulatedRulSeconds = 70 * 60;
      }

      // Exponential decrease based on fault age (drops faster the longer the fault exists)
      this.simulatedRulSeconds -= dt * Math.min(200, Math.exp(maxAge / 30));
    } else if (this.hadFaults) {
      // Faults were fixed. Recover slightly to ~75-80 mins, but no more.
      if (this.simulatedRulSeconds < 78 * 60) {
        this.simulatedRulSeconds += dt * 50; // fast recovery to 78 mins
        if (this.simulatedRulSeconds > 78 * 60)
          this.simulatedRulSeconds = 78 * 60;
      }
    }

    if (this.simulatedRulSeconds < 0) this.simulatedRulSeconds = 0;
    let rul_seconds = this.simulatedRulSeconds;

    // Anti-spoofing check
    const spoofCheck = checkGPSconsistency(
      gps.lat,
      gps.lon,
      this.inertial.lat,
      this.inertial.lon,
    );

    // Engine failure / Crash sequence if RUL is exhausted
    let isCrashed = false;
    let engineFailed = false;
    if (rul_seconds <= 0 && !this.isDiverting) {
      engineFailed = true;
      this.profile = "idle";
      params.rpm = 0;
      params.vibration = 0;
      params.fuelFlow = 0;
    }

    let currentAlt = 2000.0;
    if (this.isDiverting) {
      currentAlt = Math.max(0, 2000.0 - (this.t - this.divertStartT) * 23.0);
    } else if (engineFailed) {
      if (!this.engineFailT) this.engineFailT = this.t;
      currentAlt = Math.max(0, 2000.0 - (this.t - this.engineFailT) * 300);
      if (currentAlt <= 0) {
        isCrashed = true;
      }
    }

    if (this.isDiverting && (this.t - this.divertStartT) * 0.046 >= 4.0) {
      this.faults.clear();
      this.profile = "idle";
      params.rpm = 0;
      params.vibration = 0;
      params.fuelFlow = 0;
      params.oilPressure = 0;
      params.egt = 25;
      params.busVoltage = 0;
      params.cht = 25;
      params.oilTemp = 25;
    }
    if (isCrashed) {
      params.rpm = 0;
      params.vibration = 0;
      params.fuelFlow = 0;
      params.oilPressure = 0;
      params.egt = 25;
      params.busVoltage = 0;
      params.cht = 25;
      params.oilTemp = 25;
    }

    const sample: Sample = {
      t: this.t,
      wallClock: Date.now(),
      profile: this.profile,
      params,
      redundant,
      vibWave,
      vibSampleRate: VIB_FS,
      gps,
      inertial: { ...this.inertial },
      gpsSats:
        spoof > 0.4
          ? 14 + Math.round(Math.random())
          : 11 + Math.round(Math.random() * 2),
      fuelPath: this.fuelPath,
      activeFaults: this.activeFaults(),
      physics: {
        rho,
        Cl: aero.Cl,
        Cd: aero.Cd,
        LD: aero.LD,
        BSFC: thermo.BSFC,
        eta_th: thermo.eta_th,
        fatigue_crack_m: this.fatigueCrackMeters,
        rul_seconds,
        gpsSpoofed: spoofCheck.spoofed,
        pitch_deg:
          Math.cos(this.t * 0.3) * 0.5 +
          (spoof > 0.1 ? spoof * 25 * Math.sin(this.t * 2.1) : 0),
        roll_deg:
          Math.sin(this.t * 0.5) * 1.5 +
          (spoof > 0.1 ? spoof * 45 * Math.sin(this.t * 1.7) : 0),
        altitude_ft: currentAlt,
        mission_distance_km: this.isDiverting
          ? Math.max(0, 4.0 - (this.t - this.divertStartT) * 0.046)
          : Math.max(0, 300.0 - this.t * 0.046),
        mission_time_seconds: this.isDiverting
          ? Math.max(0, 4.0 - (this.t - this.divertStartT) * 0.046) / 0.046
          : Math.max(0, 300.0 - this.t * 0.046) / 0.046,
        cumulative_damage_pct: (this.fatigueCrackMeters / 0.0025) * 100.0,
        landing_mode:
          this.isDiverting && (this.t - this.divertStartT) * 0.046 < 4.0,
        landed: this.isDiverting && (this.t - this.divertStartT) * 0.046 >= 4.0,
        crashed: isCrashed,
      },
    };
    this.onSample?.(sample);
  }
}

export class HardwareTelemetrySource implements TelemetrySource {
  readonly kind = "hardware" as const;

  private ws: WebSocket | null = null;
  private onSampleCallback: ((s: Sample) => void) | null = null;
  private currentActiveFaults: string[] = [];
  private currentProfile: "idle" | "takeoff" | "cruise" | "loiter" | "descent" =
    "cruise";
  private fuelPath: "primary" | "secondary" = "primary";

  start(onSample: (s: Sample) => void) {
    this.onSampleCallback = onSample;
    // Connect to the GCS API Gateway (Express).
    // In production (Vercel), VITE_GCS_WS_URL should be set to a deployed backend.
    // If it is not set, we fall back to localhost for local dev.
    let wsUrl =
      (import.meta.env.VITE_GCS_WS_URL as string | undefined) ??
      "ws://localhost:3001";
    if (
      typeof window !== "undefined" &&
      window.location.search.includes("local=true")
    ) {
      wsUrl = "ws://localhost:3001";
    }

    let connectionAttempt: WebSocket;
    try {
      connectionAttempt = new WebSocket(wsUrl);
    } catch {
      // URL was completely invalid – jump straight to sim mode
      this._startSimFallback(onSample);
      return;
    }
    this.ws = connectionAttempt;

    // ---- Fallback timer: if not connected within 3 s, use sim mode ----
    const fallbackTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        console.warn(
          "[VayuTwin] Backend unreachable – switching to simulation mode",
        );
        this.ws.close();
        this.ws = null;
        this._startSimFallback(onSample);
      }
    }, 3000);

    this.ws.onopen = () => {
      clearTimeout(fallbackTimer);
      console.info("[VayuTwin] Connected to GCS backend at", wsUrl);
    };

    this.ws.onerror = () => {
      clearTimeout(fallbackTimer);
      console.warn("[VayuTwin] WS error – switching to simulation mode");
      this.ws = null;
      this._startSimFallback(onSample);
    };

    this.ws.onclose = (ev) => {
      if (ev.code !== 1000) {
        // Abnormal close (backend went away) – restart sim fallback
        clearTimeout(fallbackTimer);
        console.warn(
          "[VayuTwin] WS closed unexpectedly – switching to simulation mode",
        );
        this.ws = null;
        this._startSimFallback(onSample);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Sometimes React receives the echo of its own command from the broadcast server
        if (data.type) return;

        if (data.activeFaults) {
          this.currentActiveFaults = data.activeFaults;
        }

        const f = data.features || {};

        // Generate dynamic vibration waveform for the FFT Spectrum panel
        const rotHz = data.rpm / 60.0;
        const vibWave = new Float32Array(256);
        const t_start = data.t;
        const dt = 1.0 / 1024.0;

        let mag1x = 1.0; // Imbalance
        let magBPFO = 0.05; // Bearing

        if (this.currentActiveFaults.includes("propImbalance")) mag1x = 8.0;
        if (this.currentActiveFaults.includes("bearingWear")) magBPFO = 5.0;

        for (let i = 0; i < 256; i++) {
          const time = t_start + i * dt;
          let val = mag1x * Math.sin(2 * Math.PI * rotHz * time);
          val += magBPFO * Math.sin(2 * Math.PI * rotHz * 3.57 * time);
          val += (Math.random() - 0.5) * 0.5; // broadband noise
          vibWave[i] = val;
        }

        const nom = FLIGHT_PROFILES[this.currentProfile].nominal;

        const sample: Sample = {
          t: data.t,
          wallClock: Date.now(),
          profile: this.currentProfile,
          params: {
            rpm: data.rpm ?? nom.rpm,
            vibration: data.vibration ?? nom.vibration,
            oilPressure: f.oil_press_kPa
              ? f.oil_press_kPa / 100
              : nom.oilPressure,
            oilTemp: f.oil_temp_C ?? nom.oilTemp,
            egt: f.egt_C ?? nom.egt,
            cht: f.cht_C ?? nom.cht,
            fuelFlow: f.fuel_flow_kgph ?? nom.fuelFlow,
            busVoltage:
              nom.busVoltage + ((f.alternator_ripple_mV || 50) - 50) / 1000.0,
          },
          redundant: {
            egt:
              (f.egt_C ?? nom.egt) +
              (this.currentActiveFaults.includes("sensorDrift")
                ? -60
                : Math.random() - 0.5),
            vibration: this.currentActiveFaults.includes("vibSensorFail")
              ? nom.vibration
              : data.vibration,
            oilPressure:
              (f.oil_press_kPa ? f.oil_press_kPa / 100 : nom.oilPressure) +
              (Math.random() - 0.5) * 0.1,
          },
          vibWave: Array.from(vibWave),
          vibSampleRate: 1024,
          spectrum: data.spectrum,
          gps: {
            lat:
              (data.lat ?? 28.6) +
              (this.currentActiveFaults.includes("gpsSpoof") ? 0.002 : 0),
            lon: data.lon ?? 77.2,
          },
          inertial: { lat: data.lat ?? 28.6, lon: data.lon ?? 77.2 },
          gpsSats: this.currentActiveFaults.includes("gpsSpoof") ? 15 : 12,
          fuelPath: this.fuelPath,
          activeFaults: this.currentActiveFaults,
          physics: {
            rho: data.physics?.rho ?? f.air_density_kgm3 ?? 1.225,
            LD: data.physics?.ld_ratio ?? 16.6,
            BSFC: data.physics?.bsfc ?? 280,
            eta_th: data.physics?.eta_th ?? 0.35,
            fatigue_crack_m: data.physics?.fatigue_crack_m ?? 0.001,
            rul_seconds: data.physics?.rul_seconds ?? 3600,
            hypo_rul_seconds: data.physics?.hypo_rul_seconds ?? 3600,
            mission_time_seconds: data.physics?.mission_time_seconds ?? 0,
            mission_distance_km: data.physics?.mission_distance_km ?? 0,
            throttle_reduction: data.physics?.throttle_reduction ?? 1.0,
            altitude_ft: data.physics?.altitude_ft ?? 2000,
            gpsSpoofed: data.physics?.gpsSpoofed ?? false,
            pitch_deg: data.physics?.pitch_deg ?? 0,
            roll_deg: data.physics?.roll_deg ?? 0,
          },
        };

        if (this.onSampleCallback) this.onSampleCallback(sample);
      } catch (e) {
        console.error("Telemetry parse error", e);
      }
    };
  }

  private _simFallback: SimulatedTelemetrySource | null = null;

  /** Start a local browser simulation when no backend is reachable */
  private _startSimFallback(onSample: (s: Sample) => void) {
    if (this._simFallback) return; // already running
    this._simFallback = new SimulatedTelemetrySource({ intervalMs: 750 });
    this._simFallback.start(onSample);
  }

  stop() {
    if (this.ws) {
      this.ws.close(1000); // clean close
      this.ws = null;
    }
    if (this._simFallback) {
      this._simFallback.stop();
      this._simFallback = null;
    }
  }

  private _ws_send(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  injectFault(key: string) {
    this._ws_send({ type: "inject_fault", fault: key });
    this._simFallback?.injectFault(key);
  }

  clearFault(key: string) {
    this._ws_send({ type: "clear_fault", fault: key });
    this._simFallback?.clearFault(key);
  }

  reduceThrottle() {
    this._ws_send({ type: "reduce_throttle" });
  }

  setThrottle(throttle: number) {
    this._ws_send({ type: "set_throttle", throttle });
  }

  divert(lat: number, lon: number) {
    this._ws_send({ type: "set_divert", lat, lon });
    this._simFallback?.divert?.(lat, lon);
  }

  calibrate() {
    this._ws_send({ type: "calibrate" });
  }

  clearAllFaults() {
    this._ws_send({ type: "clear_all" });
    this._simFallback?.clearAllFaults();
  }

  setProfile(p: any) {
    this.currentProfile = p;
    this._ws_send({ type: "set_profile", profile: p });
    this._simFallback?.setProfile(p);
  }

  setFuelPath(path: "primary" | "secondary") {
    this.fuelPath = path;
    if (path === "secondary") {
      this._ws_send({ type: "clear_fault", fault: "fuelBlockage" });
      this._simFallback?.clearFault("fuelBlockage");
    }
  }
}
