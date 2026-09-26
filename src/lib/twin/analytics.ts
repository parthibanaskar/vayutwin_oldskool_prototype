// @ts-nocheck
import { bandEnergy, magnitudeSpectrum } from "./fft";
import { FLIGHT_PROFILES, HOTSPOTS, PARAM_SPECS } from "./profiles";
import type {
  Alert,
  FeatureContribution,
  HealthState,
  ParamKey,
  Sample,
  Severity,
  Subsystem,
} from "./types";
import { PARAM_KEYS, SUBSYSTEMS } from "./types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 0 = at nominal, 1 = at the soft limit, >1 = beyond limit. */
export function deviation(
  key: ParamKey,
  value: number,
  nominal: number,
): number {
  const spec = PARAM_SPECS[key];
  const span = Math.abs(spec.limit - nominal);
  if (span <= 0) return 0;

  // Make limits bilateral so massive drops in RPM or spikes in Oil Pressure turn red!
  let excess = 0;
  if (spec.worseWhen === "high") {
    excess = value > nominal ? value - nominal : (nominal - value) * 0.85;
  } else {
    excess = value < nominal ? nominal - value : (value - nominal) * 0.85;
  }
  return Math.max(0, excess / span);
}

export interface RedundancyRow {
  channel: string;
  a: number;
  b: number;
  delta: number;
  tolerance: number;
  status: "ok" | "drift" | "fail";
  unit: string;
}

export interface Derived {
  sample: Sample;
  deviations: Record<ParamKey, number>;
  health: HealthState;
  spectrum: { freq: number; mag: number }[];
  rotHz: number;
  imbalanceEnergy: number;
  bearingEnergy: number;
  broadbandEnergy: number;
  redundancy: RedundancyRow[];
  gpsErrorMetres: number;
  trustedVibration: number;
}

export function derive(sample: Sample): Derived {
  const nominal = { ...FLIGHT_PROFILES[sample.profile].nominal };

  // If the edge controller intentionally commanded a throttle reduction to conserve RUL,
  // we must lower the nominal RPM target so the digital twin doesn't wrongly penalize Fleet Health.
  if (
    sample.physics?.throttle_reduction &&
    sample.physics.throttle_reduction < 1.0
  ) {
    nominal.rpm = nominal.rpm * sample.physics.throttle_reduction;
  }

  const deviations = {} as Record<ParamKey, number>;
  for (const key of PARAM_KEYS)
    deviations[key] = deviation(key, sample.params[key], nominal[key]);

  const spectrum =
    sample.spectrum || magnitudeSpectrum(sample.vibWave, sample.vibSampleRate);
  const rotHz = Math.max(4, sample.params.rpm / 60);
  const imbalanceEnergy = bandEnergy(spectrum, rotHz * 0.85, rotHz * 1.15);
  const bearingEnergy =
    bandEnergy(spectrum, rotHz * 3.2, rotHz * 3.95) +
    bandEnergy(spectrum, rotHz * 6.8, rotHz * 7.5);
  const broadbandEnergy = bandEnergy(
    spectrum,
    rotHz * 8,
    sample.vibSampleRate / 2,
  );

  const redundancy: RedundancyRow[] = [
    row("EGT", sample.params.egt, sample.redundant.egt, 18, "\u00b0C"),
    row(
      "Vibration",
      sample.params.vibration,
      sample.redundant.vibration,
      0.9,
      "mm/s",
    ),
    row(
      "Oil pressure",
      sample.params.oilPressure,
      sample.redundant.oilPressure,
      0.35,
      "bar",
    ),
  ];

  const trustedVibration =
    redundancy[1]!.status === "fail"
      ? sample.redundant.vibration
      : sample.params.vibration;

  const gpsErrorMetres = haversine(sample.gps, sample.inertial);

  const health = computeHealth(
    deviations,
    redundancy,
    gpsErrorMetres,
    bearingEnergy,
    rotHz,
    sample.physics,
  );

  return {
    sample,
    deviations,
    health,
    spectrum,
    rotHz,
    imbalanceEnergy,
    bearingEnergy,
    broadbandEnergy,
    redundancy,
    gpsErrorMetres,
    trustedVibration,
  };
}

function row(
  channel: string,
  a: number,
  b: number,
  tolerance: number,
  unit: string,
): RedundancyRow {
  const delta = Math.abs(a - b);
  const relative =
    a === 0 || b === 0 ? Infinity : Math.abs(a - b) / Math.max(Math.abs(a), 1);
  const status: RedundancyRow["status"] =
    relative > 0.6 && delta > tolerance * 2
      ? "fail"
      : delta > tolerance
        ? "drift"
        : "ok";
  return { channel, a, b, delta, tolerance, status, unit };
}

function computeHealth(
  deviations: Record<ParamKey, number>,
  redundancy: RedundancyRow[],
  gpsErrorMetres: number,
  bearingEnergy: number,
  rotHz: number,
  physics: any,
): HealthState {
  const worst: Record<Subsystem, number> = {
    engine: 0,
    vibration: 0,
    lubrication: 0,
    fuel: 0,
    electrical: 0,
    nav: 0,
  };
  for (const key of PARAM_KEYS) {
    const sub = PARAM_SPECS[key].subsystem;
    worst[sub] = Math.max(worst[sub], deviations[key]);
  }
  worst.vibration = Math.max(worst.vibration, clamp01(bearingEnergy / 2.6));
  worst.nav = Math.max(worst.nav, clamp01(gpsErrorMetres / 260));
  if (redundancy.some((r) => r.status === "fail")) {
    worst.engine = Math.max(worst.engine, 0.3);
  }

  if (physics?.fatigue_crack_m) {
    // Crack starts at 0.001 (baseline healthy) and snaps at 0.0025 (100% damage).
    const crackDamage = clamp01(
      (physics.fatigue_crack_m - 0.001) / (0.0025 - 0.001),
    );
    worst.engine = Math.max(worst.engine, crackDamage);
  }

  void rotHz;

  const subsystems = {} as Record<Subsystem, number>;
  for (const sub of SUBSYSTEMS) {
    subsystems[sub] = Math.round(100 * (1 - clamp01(worst[sub] * 0.95)));
  }
  const overall = Math.round(
    SUBSYSTEMS.reduce((min, sub) => Math.min(min, subsystems[sub]), 100) * 0.6 +
      (SUBSYSTEMS.reduce((sum, sub) => sum + subsystems[sub], 0) /
        SUBSYSTEMS.length) *
        0.4,
  );
  return { overall, subsystems };
}

function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Remaining useful life: least-squares slope of a subsystem's degradation
 * history extrapolated to the failure threshold (health = 20).
 */
export function estimateRul(
  history: { t: number; value: number }[],
): number | null {
  const window = history.slice(-60);
  if (window.length < 12) return null;
  const n = window.length;
  const meanT = window.reduce((s, p) => s + p.t, 0) / n;
  const meanV = window.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of window) {
    num += (p.t - meanT) * (p.value - meanV);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) return null;
  const slopePerSecond = num / den; // health points per second
  if (slopePerSecond > -0.005) return null; // not degrading meaningfully
  const current = window[n - 1]!.value;
  const seconds = (current - 20) / -slopePerSecond;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(600, seconds / 60);
}

export interface AlertCandidate {
  key: string;
  subsystem: Subsystem;
  title: string;
  severity: Severity;
  confidence: number;
  contributions: FeatureContribution[];
  narrative: string;
  resolutionNarrative?: string;
  hotspot: string;
}

function contribution(
  key: FeatureContribution["key"],
  label: string,
  value: number,
  detail: string,
): FeatureContribution {
  return { key, label, value: Math.round(value * 10) / 10, detail };
}

function fmt(key: ParamKey, value: number) {
  const spec = PARAM_SPECS[key];
  return `${value.toFixed(spec.decimals)} ${spec.unit}`;
}

/**
 * Emits only landing-stage and crash alerts.
 * Called when the UAV is in landing_mode, landed, or crashed.
 * All diagnostic / sensor / RUL alerts are suppressed.
 */
function evaluateLandingAlerts(
  d: Derived,
  phys: Sample["physics"],
  out: AlertCandidate[],
  push: (c: AlertCandidate) => void,
): AlertCandidate[] {
  if (!phys) return out;

  // Crash sequence
  if (phys.crashed) {
    push({
      key: "crashDetected",
      subsystem: "engine",
      title: "Hull Loss Detected — UAV Crashed",
      severity: "critical",
      confidence: 1.0,
      hotspot: "engine",
      contributions: [],
      narrative: `HULL LOSS: The UAV has suffered a catastrophic structural failure and crashed.\n\n• Cause: Engine failure led to uncontrolled descent.\n• Status: All systems offline. Post-flight review generating.`,
      resolutionNarrative: `POST-FLIGHT REVIEW INITIATED`,
    });
    return out;
  }

  const dist = phys.mission_distance_km ?? 0;

  // Landed (after successful divert)
  if (phys.landed) {
    push({
      key: "landingTouchdown",
      subsystem: "nav",
      title: "Touchdown Confirmed — Spoilers Deployed",
      severity: "nominal",
      confidence: 1.0,
      hotspot: "avionics",
      contributions: [],
      narrative: `TOUCHDOWN CONFIRMED: UAV has safely landed at the FOB.\n\n• Spoilers deployed. Engine spooling down to idle.\n• Post-flight review is generating...`,
      resolutionNarrative: `MISSION COMPLETE`,
    });
    return out;
  }

  // Active landing sequence stages
  if (phys.landing_mode) {
    if (dist > 2.0) {
      push({
        key: "landingApproach",
        subsystem: "nav",
        title: "Divert: Autonomous Approach Initiated",
        severity: "advisory",
        confidence: 1.0,
        hotspot: "avionics",
        contributions: [
          contribution("gps", "Distance to FOB", 100, `${dist.toFixed(1)} km`),
        ],
        narrative: `DIVERT ACKNOWLEDGED: Flight computer has accepted the divert order.\n\n• Heading: Rerouting to FOB. Engine transitioning to descent power.\n• Status: Altitude hold at 2000 ft. Awaiting final approach corridor.`,
        resolutionNarrative: `APPROACH COMPLETE: UAV has entered the final approach corridor.`,
      });
      // Contextual auto-fixes for previous faults
      if (
        d.sample.activeFaults.includes("bearingWear") ||
        phys.bearing_permanently_damaged
      ) {
        push({
          key: "autoFixOilPressure",
          subsystem: "engine",
          title: "Oil Scavenge Pump Activated (Auto-fixed)",
          severity: "nominal",
          confidence: 0.95,
          hotspot: "engine",
          contributions: [],
          narrative: `Due to main bearing wear, oil pressure dropped during descent. AI has automatically engaged the auxiliary oil scavenge pump to maintain minimum safe lubrication until touchdown.`,
        });
      }
    } else if (dist <= 2.0 && dist > 0.5) {
      push({
        key: "landingGears",
        subsystem: "nav",
        title: "Landing Gear Deployed — Final Approach",
        severity: "advisory",
        confidence: 1.0,
        hotspot: "avionics",
        contributions: [
          contribution(
            "gps",
            "Distance to Threshold",
            100,
            `${dist.toFixed(2)} km`,
          ),
          contribution(
            "rpm",
            "Altitude",
            80,
            `${phys.altitude_ft?.toFixed(0) ?? "—"} ft`,
          ),
        ],
        narrative: `FINAL APPROACH: UAV is on the 3-degree glide slope to the FOB.\n\n• Action: Landing gear deployed. Flaps extended to 30°.\n• Status: Airspeed bleeding off. Descending through ${phys.altitude_ft?.toFixed(0) ?? "—"} ft.`,
        resolutionNarrative: `GEAR DOWN: Gear locked and confirmed. Flare initiated.`,
      });
      // Contextual auto-fixes for previous faults
      if (d.sample.activeFaults.includes("egtOvertemp") || phys.egt_C > 600) {
        push({
          key: "autoFixCooling",
          subsystem: "engine",
          title: "Cowl Flaps 100% (Auto-fixed)",
          severity: "nominal",
          confidence: 0.96,
          hotspot: "hotSection",
          contributions: [],
          narrative: `Residual heat from the hot section overtemp caused cowl temperatures to spike. AI automatically opened cowl flaps to 100% to flush hot air and prevent composite airframe damage during low-speed glide.`,
        });
      }
    } else if (dist <= 0.5 && dist > 0.0) {
      push({
        key: "landingFlare",
        subsystem: "nav",
        title: "Flare Initiated — Throttle Cut",
        severity: "advisory",
        confidence: 1.0,
        hotspot: "avionics",
        contributions: [
          contribution(
            "rpm",
            "Altitude",
            100,
            `${phys.altitude_ft?.toFixed(0) ?? "—"} ft`,
          ),
          contribution(
            "gps",
            "Distance to Runway",
            80,
            `${(dist * 1000).toFixed(0)} m`,
          ),
        ],
        narrative: `FLARE SEQUENCE: UAV is in the final 500m. Throttle cut to idle.\n\n• Elevator pitched up to arrest descent rate.\n• Wheels loading down. Expect touchdown in seconds.`,
        resolutionNarrative: `TOUCHDOWN: Wheels on ground. Spoilers deployed.`,
      });
      // Generic auto-fix for end of flight
      push({
        key: "autoFixHydraulics",
        subsystem: "nav",
        title: "Hydraulic Load Balanced (Auto-fixed)",
        severity: "nominal",
        confidence: 0.99,
        hotspot: "avionics",
        contributions: [],
        narrative: `Gear deployment and flare caused a transient hydraulic pressure drop. AI auto-balanced the actuators to ensure all control surfaces remain responsive for touchdown.`,
      });
    }
  }

  return out;
}

/** Rule + evidence engine. Contributions are computed from live deviations. */
export function evaluateAlerts(d: Derived): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const p = d.sample.params;
  const dev = d.deviations;
  const push = (c: AlertCandidate) => out.push(c);

  const phys = d.sample.physics;
  const isLanding = phys?.landing_mode === true;
  const isGrounded = phys?.landed === true || phys?.crashed === true;

  // ── Landing / post-landing gate ──────────────────────────────────────────
  // When the UAV is in an active landing sequence OR has already touched down,
  // skip ALL sensor/diagnostic alerts. Only landing-stage and post-flight alerts
  // are emitted below (they have their own block that explicitly checks landing_mode).
  if (isLanding || isGrounded) {
    // Jump directly to the landing stage alert block at the bottom.
    // Return early after emitting only those alerts.
    return evaluateLandingAlerts(d, phys, out, push);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // 1. PyTorch PINN Fatigue Crack Sensing
  if (
    d.sample.physics?.fatigue_crack_m &&
    d.sample.physics.fatigue_crack_m > 0.0012
  ) {
    const mm = d.sample.physics.fatigue_crack_m * 1000;
    push({
      key: "aeCrack",
      subsystem: "engine",
      title: "Micro-crack detected by PyTorch Physics-Informed Neural Network",
      severity: mm > 2.0 ? "critical" : "warning",
      confidence: 0.98,
      hotspot: "bearing",
      contributions: [
        contribution(
          "spectral",
          "Crack length (PINN inferred)",
          Math.min(100, (mm / 2.5) * 100),
          `${mm.toFixed(3)} mm`,
        ),
        contribution(
          "vibration",
          "Vibration RMS stress",
          clamp01(d.trustedVibration / 5) * 100,
          fmt("vibration", d.trustedVibration),
        ),
      ],
      narrative: `The physics-informed neural network (PINN) has detected that current vibration levels are rapidly accelerating fatigue crack propagation (currently ${mm.toFixed(3)} mm). The Remaining Useful Life (RUL) is crashing.`,
    });
  }

  // 2. Alternator Misfire Sensing
  if (p.alternatorV !== undefined && p.alternatorV < 13.5 && dev.rpm > 0.2) {
    push({
      key: "alternatorMisfire",
      subsystem: "electrical",
      title:
        "Alternator Misfire Sensing: High electrical ripple indicating misfires",
      severity: "warning",
      confidence: 0.88,
      hotspot: "alternator",
      contributions: [],
    });
  }

  // 3. Hidden Redundancy Check
  if (d.redundancy.some((r) => r.status === "fail")) {
    push({
      key: "hiddenRedundancy",
      subsystem: "electrical",
      title: "Hidden Redundancy Check: Shared power / backup failure isolated",
      severity: "warning",
      confidence: 0.98,
      hotspot: "redundancy",
      contributions: [],
    });
  }

  // 4. Sudden Parameter Surges / Purges (Generic XAI detection)
  for (const [k, v] of Object.entries(dev)) {
    // Ignore vibration here because we have dedicated FFT rules for it
    // Threshold increased to 0.75 to prevent minor jitter from spamming alerts
    // Suppress during landing mode, since rapid parameter shifts (RPM drops) are intentional
    if (k !== "vibration" && v > 0.75 && !d.sample.physics?.landing_mode) {
      const spec = PARAM_SPECS[k as ParamKey];
      push({
        key: `suddenShift_${k}`,
        subsystem: spec.subsystem,
        title: `Sudden exponential deviation in ${spec.label}`,
        severity: v > 0.85 ? "critical" : "warning",
        confidence: clamp01(0.5 + v / 2),
        hotspot: "crank",
        contributions: [
          contribution(
            "rpm",
            "Deviation Magnitude",
            clamp01(v) * 100,
            `${(v * 100).toFixed(0)}% divergence from nominal`,
          ),
          contribution(
            "vibration",
            "Rate of change",
            85,
            "Exponential growth/decay signature detected",
          ),
        ],
        narrative: `Explainable AI has detected a sudden surge or purge in ${spec.label}. The parameter is rising or falling exponentially beyond expected safe flight profile limits.`,
      });
    }
  }

  // 5. Prescriptive AI: RUL Conservation Recommendation
  // (phys already declared at top of function)

  // Helper for formatting time
  const formatTime = (sec: number) =>
    sec > 7200
      ? (sec / 3600).toFixed(1) + " hours"
      : (sec / 60).toFixed(1) + " mins";

  if (
    phys?.rul_seconds !== undefined &&
    phys.hypo_rul_seconds !== undefined &&
    phys.mission_time_seconds !== undefined &&
    phys.rul_seconds > 0
  ) {
    const gainedMins = (phys.hypo_rul_seconds - phys.rul_seconds) / 60;
    // Trigger if RUL collides with Mission Time, OR if "rulAdvisory" is manually injected
    const shouldAdvise =
      phys.rul_seconds < phys.mission_time_seconds ||
      d.sample.activeFaults.includes("rulAdvisory");

    if (shouldAdvise && !phys.crashed) {
      if (phys.hypo_rul_seconds > phys.mission_time_seconds) {
        push({
          key: "prescriptiveThrottle",
          subsystem: "engine",
          title: "Prescriptive AI: Reduce Throttle to extend RUL",
          severity: "critical",
          confidence: 0.99,
          hotspot: "engine",
          contributions: [
            contribution(
              "rpm",
              "Current RUL",
              100,
              formatTime(phys.rul_seconds),
            ),
            contribution(
              "rpm",
              "Projected RUL (-15% RPM)",
              100,
              `${formatTime(phys.hypo_rul_seconds)} (+${(gainedMins > 120 ? gainedMins / 60 : gainedMins).toFixed(1)} ${gainedMins > 120 ? "hours" : "mins"})`,
            ),
          ],
          narrative: `CRITICAL: Engine shaft fatigue crack is actively propagating due to elevated mechanical stress.\n\n• Root Cause: High rotational vibration accelerating Paris Law crack growth.\n• Physical Impact: The Remaining Useful Life (RUL) is plunging and will expire before reaching the mission destination (currently at ${formatTime(phys.rul_seconds)}).\n• AI Prescription: Reducing throttle/fuel flow by exactly 15% will exponentially reduce cubic rotational stress, boosting RUL to ${formatTime(phys.hypo_rul_seconds)} (a gain of +${(gainedMins > 120 ? gainedMins / 60 : gainedMins).toFixed(1)} ${gainedMins > 120 ? "hours" : "minutes"}).`,
          resolutionNarrative: `ACTION EXECUTED: Fly-by-wire controller throttle physically reduced by 15%.\n\n• Hardware Response: Fuel flow and RPM have physically dropped by -15%.\n• Physical Mitigation: The cubic stress load on the engine shaft has drastically decreased.\n• Outcome: The crack growth velocity has been successfully arrested. RUL extended by +${(gainedMins > 120 ? gainedMins / 60 : gainedMins).toFixed(1)} ${gainedMins > 120 ? "hours" : "minutes"}. Safe arrival at divert destination is now mathematically viable.`,
        });
      }

      // Only demand a divert if the mission is fundamentally unachievable even after trying potential fixes (activeFaults.length === 0)
      // AND even if we were to reduce throttle (hypo_rul_seconds < mission_time_seconds)
      if (
        phys.rul_seconds < phys.mission_time_seconds &&
        phys.hypo_rul_seconds < phys.mission_time_seconds &&
        d.sample.activeFaults.length === 0 &&
        !phys.crashed &&
        !phys.landed &&
        !phys.landing_mode &&
        (phys.fatigue_crack_m || 0) < 0.0025
      ) {
        push({
          key: "prescriptiveDivert",
          subsystem: "nav",
          title: "Prescriptive AI: Mission unachievable – Divert Required",
          severity: "critical",
          confidence: 0.99,
          hotspot: "avionics",
          contributions: [
            contribution(
              "rpm",
              "Current RUL",
              100,
              formatTime(phys.rul_seconds),
            ),
            contribution(
              "gps",
              "Time to Destination",
              100,
              formatTime(phys.mission_time_seconds),
            ),
          ],
          narrative: `MISSION COMPROMISED: Remaining Useful Life (RUL) has fallen below the required time to reach the primary destination.\n\n• Analysis: The digital twin projects a catastrophic failure before arrival.\n• AI Prescription: Abort primary mission and divert to the nearest landing base immediately.`,
          resolutionNarrative: `ACTION EXECUTED: Divert trajectory engaged.\n\n• Software Mitigation: Primary mission waypoints discarded. Flight director commanded to execute shortest-path intercept to divert base.\n• Hardware Mitigation: Ailerons and rudder deployed for coordinated turn.\n• Outcome: UAV safely descending towards alternate landing zone.`,
        });
      }
    }
  }

  const vibDev = deviation(
    "vibration",
    d.trustedVibration,
    FLIGHT_PROFILES[d.sample.profile].nominal.vibration,
  );
  const bearingRatio = d.bearingEnergy / Math.max(d.imbalanceEnergy, 0.05);

  if (vibDev > 0.45 && bearingRatio > 0.55) {
    const total =
      vibDev * 46 + clamp01(d.bearingEnergy / 2.6) * 34 + dev.oilTemp * 20;

    // Wire RUL/physics into the XAI for Bearing Wear
    const contributions = [
      contribution(
        "vibration",
        "Vibration RMS",
        vibDev * 46,
        `${fmt("vibration", d.trustedVibration)} vs profile nominal`,
      ),
      contribution(
        "spectral",
        "BPFO band energy",
        clamp01(d.bearingEnergy / 2.6) * 34,
        `${d.bearingEnergy.toFixed(2)} @ ~${(d.rotHz * 3.57).toFixed(0)} Hz (3.57x shaft)`,
      ),
    ];
    if (dev.oilTemp > 0.3)
      contributions.push(
        contribution(
          "oilTemp",
          "Oil temperature",
          dev.oilTemp * 20,
          fmt("oilTemp", p.oilTemp),
        ),
      );

    push({
      key: "bearingWear",
      subsystem: "vibration",
      title: "Main bearing degradation predicted",
      severity: vibDev > 0.95 ? "critical" : "warning",
      confidence: clamp01(
        0.42 + vibDev * 0.4 + clamp01(bearingRatio - 0.55) * 0.3,
      ),
      hotspot: "bearing",
      contributions,
      narrative: `HARDWARE ANOMALY DETECTED: Imminent failure of the main engine shaft bearing.\n\n• Where: Engine shaft main bearing race.\n• What: FFT spectral analysis detects massive energy spikes at the Ball Pass Frequency Outer-race (BPFO) harmonic (~${(d.rotHz * 3.57).toFixed(0)} Hz).\n• Hardware Impact: Physical pitting/spalling on the bearing surface is generating violent mechanical vibrations (RMS +${(vibDev * 100).toFixed(0)}% over baseline).\n• Threat: The severe vibration is multiplying the shaft stress load, causing the PINN physics engine to plummet the Remaining Useful Life (RUL). Current RUL dropped to ${(d.sample.physics?.rul_seconds ? d.sample.physics.rul_seconds / 60 : 0).toFixed(1)} mins at an accelerated decay rate.`,
      resolutionNarrative: `ACTION EXECUTED: Emergency physical mitigation applied via Edge Controller.\n\n• Hardware Mitigation: Variable-pitch propeller feathered to offload shaft torsion. Active vibration dampeners engaged.\n• Software Mitigation: Engine timing retarded to smooth combustion pulses.\n• Outcome: The 3.57x BPFO spectral peak has been eliminated. Vibration RMS reduced by ${(vibDev * 100).toFixed(0)}%. RUL recovered by averting a loss of over 100 minutes of structural life.`,
    });
  }

  if (d.imbalanceEnergy > 2.4 && bearingRatio < 0.6) {
    push({
      key: "propImbalance",
      subsystem: "vibration",
      title: "Propeller imbalance detected",
      severity: d.imbalanceEnergy > 4 ? "warning" : "advisory",
      confidence: clamp01(0.4 + d.imbalanceEnergy / 12),
      hotspot: "propeller",
      contributions: [
        contribution(
          "spectral",
          "1x shaft-order peak",
          clamp01(d.imbalanceEnergy / 6) * 58,
          `${d.imbalanceEnergy.toFixed(2)} @ ${d.rotHz.toFixed(0)} Hz`,
        ),
        contribution(
          "vibration",
          "Vibration RMS",
          vibDev * 30,
          fmt("vibration", d.trustedVibration),
        ),
        contribution(
          "rpm",
          "RPM hunting",
          clamp01(dev.rpm) * 12,
          fmt("rpm", p.rpm),
        ),
      ],
      narrative: `HARDWARE ANOMALY DETECTED: Severe mass imbalance on the propeller hub or blade.\n\n• Where: Main forward propeller assembly.\n• What: FFT spectral analysis isolates massive vibration energy entirely concentrated at the 1x shaft rotational frequency (${d.rotHz.toFixed(0)} Hz), with no bearing noise.\n• Hardware Impact: A blade has likely suffered a bird strike or lost an icing boot, shifting the center of mass. This is injecting +${d.imbalanceEnergy.toFixed(1)}G of imbalance stress into the airframe.\n• Threat: Centrifugal tearing forces are severely degrading the main engine shaft, actively wiping out ~${(d.imbalanceEnergy * 15).toFixed(0)} minutes of RUL capacity.`,
      resolutionNarrative: `ACTION EXECUTED: Dynamic imbalance compensation engaged.\n\n• Hardware Mitigation: Propeller RPM synchro-phasing altered to minimize harmonic resonance, compensating for the ${d.imbalanceEnergy.toFixed(1)}G load.\n• Software Mitigation: Digital notch filters applied to the flight controller to ignore the 1x wobble frequency, preventing control surface oscillation.\n• Outcome: Shaft-order vibration peak neutralized. Flight stability restored. Saved ${(d.imbalanceEnergy * 15).toFixed(0)} minutes of RUL.`,
    });
  }

  if (dev.oilPressure > 0.4 || dev.oilTemp > 0.6) {
    push({
      key: "oilStarvation",
      subsystem: "lubrication",
      title: "Lubrication pressure loss",
      severity: dev.oilPressure > 0.85 ? "critical" : "warning",
      confidence: clamp01(0.45 + dev.oilPressure * 0.45),
      hotspot: "oilSystem",
      contributions: [
        contribution(
          "oilPressure",
          "Oil pressure",
          dev.oilPressure * 55,
          fmt("oilPressure", p.oilPressure),
        ),
        contribution(
          "oilTemp",
          "Oil temperature",
          dev.oilTemp * 33,
          fmt("oilTemp", p.oilTemp),
        ),
        contribution(
          "vibration",
          "Vibration RMS",
          vibDev * 12,
          fmt("vibration", d.trustedVibration),
        ),
      ],
      narrative: `HARDWARE ANOMALY DETECTED: Critical loss of engine lubrication pressure.\n\n• Where: Engine oil pump and internal cooling galleries.\n• What: Telemetry indicates plummeting oil pressure (-${(dev.oilPressure * 100).toFixed(0)}% drop) intersecting with rapidly rising oil temperatures (+${(dev.oilTemp * 100).toFixed(0)}% spike).\n• Hardware Impact: Metal-to-metal friction is occurring inside the cylinders and main bearings due to fluid starvation.\n• Threat: Thermal expansion and friction will rapidly seize the engine block, plunging the RUL to zero. Engine will fail in approximately ${(30 - dev.oilPressure * 20).toFixed(0)} minutes if unmitigated.`,
      resolutionNarrative: `ACTION EXECUTED: Emergency lubrication protocol activated.\n\n• Hardware Mitigation: Auxiliary electric oil scavenger pump engaged to bypass the primary mechanical pump leak.\n• Software Mitigation: Thermal protection limits actively clamped to prevent RPM surges.\n• Outcome: Oil gallery pressure restored to nominal. Temperatures cooling. Catastrophic engine seizure averted, saving ${(30 - dev.oilPressure * 20).toFixed(0)} minutes of flight time and full RUL.`,
    });
  }

  if (dev.egt > 0.55 || dev.cht > 0.6) {
    const sensorSuspect = d.redundancy[0]!.status !== "ok";
    push({
      key: sensorSuspect ? "sensorDrift" : "egtOvertemp",
      subsystem: "engine",
      title: sensorSuspect
        ? "EGT channel disagreement — sensor suspect"
        : "Hot section overtemperature",
      severity: sensorSuspect
        ? "advisory"
        : dev.egt > 0.95
          ? "critical"
          : "warning",
      confidence: sensorSuspect ? 0.55 : clamp01(0.5 + dev.egt * 0.45),
      hotspot: "hotSection",
      contributions: [
        contribution(
          "egt",
          "Exhaust gas temp",
          dev.egt * 48,
          fmt("egt", p.egt),
        ),
        contribution(
          "cht",
          "Cylinder head temp",
          dev.cht * 32,
          fmt("cht", p.cht),
        ),
        contribution(
          "redundancy",
          "Channel A/B agreement",
          (sensorSuspect ? 1 : 0) * 20,
          `${d.redundancy[0]!.delta.toFixed(1)} \u00b0C split`,
        ),
      ],
      narrative: sensorSuspect
        ? `SENSOR ANOMALY DETECTED: Instrumentation drift on Exhaust Gas Temp (EGT) Probe A.\n\n• Where: Exhaust manifold EGT Channel A thermocouple.\n• What: Channel A is reading dangerously hot (+${(dev.egt * 100).toFixed(0)}% deviation), but Channel B remains at profile nominal, and the Cylinder Head Temp (CHT) has not changed.\n• Software Impact: The digital twin has isolated this as a false positive sensor ghost.\n• Threat: Unmitigated, the flight controller might unnecessarily derate the engine based on false data, causing a -20% drop in thrust.`
        : `HARDWARE ANOMALY DETECTED: Genuine hot section overtemperature.\n\n• Where: Engine combustion chamber and exhaust manifold.\n• What: Both EGT thermal channels agree, and CHT is tracking upward synchronously (+${(dev.cht * 100).toFixed(0)}% over baseline).\n• Hardware Impact: The engine is running dangerously lean, driving exhaust temps +${(dev.egt * 100).toFixed(0)}% above baseline.\n• Threat: Sustained overtemp will melt the turbine blades or warp the cylinder head, costing ~45 minutes of RUL.`,
      resolutionNarrative: sensorSuspect
        ? `ACTION EXECUTED: Sensor fusion logic reconfigured.\n\n• Software Mitigation: The AI has dynamically completely excised Channel A from the voting pool.\n• Hardware Mitigation: Flight controller telemetry seamlessly switched entirely to redundant Channel B.\n• Outcome: The false temperature reading is purged from the dashboard. Unnecessary 20% thrust derating prevented.`
        : `ACTION EXECUTED: Thermal protection intervention.\n\n• Hardware Mitigation: Fuel mixture artificially enriched by +12% to cool the combustion chamber via latent heat of vaporization.\n• Outcome: Exhaust Gas Temperatures and Cylinder Head Temperatures successfully driven back into the safe green threshold. Averted a 45-minute drop in structural RUL.`,
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Bearing Permanently Damaged — Non-Repairable, Divert Immediately
  // ---------------------------------------------------------------------------------------------------------

  // --- Healthy AI Logs ---
  if (
    d.sample.activeFaults.length === 0 &&
    !phys?.landing_mode &&
    !phys?.landed &&
    !phys?.crashed &&
    d.sample.profile === "cruise" &&
    Math.random() < 0.005
  ) {
    const msgs = [
      "PINN model: Combustion efficiency optimal (99.8%)",
      "Vibration signature matching baseline harmonic.",
      "Paris Law prediction: RUL stable at cruise conditions.",
      "Thermal gradients within nominal safety margins.",
    ];
    push({
      key: "healthy_log_" + Math.floor(Math.random() * 1000),
      subsystem: "engine",
      title: msgs[Math.floor(Math.random() * msgs.length)],
      severity: "info",
      confidence: 0.99,
      hotspot: "propeller",
      contributions: [],
      narrative:
        "The Digital Twin physics engine confirms all structural and thermodynamic parameters are nominal. Fatigue crack growth is mathematically stabilized.",
      resolutionNarrative: "",
    });
  }

  if (phys?.bearing_permanently_damaged && !phys?.crashed && !phys?.landed) {
    push({
      key: "bearingPermanentDamage",
      subsystem: "engine",
      title:
        "CRITICAL: Main Bearing Spalling — Non-Repairable — Immediate Divert",
      severity: "critical",
      confidence: 1.0,
      hotspot: "bearing",
      contributions: [
        contribution(
          "vibration",
          "Spall fragments on race",
          100,
          "Irreversible",
        ),
      ],
      narrative: `CATASTROPHIC STRUCTURAL FAILURE: Main shaft bearing has spalled mid-flight.\n\n• Why it's non-repairable: Metal fragments from the spalled bearing race are circulating in the oil gallery. This causes progressive erosion of the shaft journal, crankcase, and oil pump — compounding with every rotation.\n• Permanent damage: Even with the alert "resolved", the bearing raceway is permanently damaged. Background vibration is elevated for the rest of this flight.\n• AI Prescription: DIVERT IMMEDIATELY. No fix can restore airframe health above 50%. Mission abort is mandatory.`,
      resolutionNarrative: `DIVERT COMMANDED: Aircraft rerouting to nearest Forward Operating Base.\n\n⚠️ Note: Bearing spalling is PERMANENT. Fleet Health is capped at 60% for the remainder of this flight.\n• Recommendation: Full bearing and shaft inspection before next flight. Do NOT re-fly without ground inspection.`,
    });
  }
  // ---------------------------------------------------------------------------------------------------------

  // ---------------------------------------------------------------------------------------------------------
  // Cascading Failure AI Logic
  // ---------------------------------------------------------------------------------------------------------
  if (
    (phys?.fault_history_count || 0) >= 2 &&
    !phys?.crashed &&
    !phys?.landed &&
    !phys?.landing_mode &&
    !phys?.bearing_permanently_damaged
  ) {
    push({
      key: "cascadingFailures",
      subsystem: "nav",
      title: "Prescriptive AI: Cascading Failures — Divert Required",
      severity: "critical",
      confidence: 0.99,
      hotspot: "avionics",
      contributions: [
        contribution(
          "vibration",
          "Historical Faults",
          100,
          `${phys?.fault_history_count} anomalies`,
        ),
      ],
      narrative: `CRITICAL: The aircraft has experienced ${phys?.fault_history_count} critical anomalies this mission. Structural life consumed: ${phys?.cumulative_damage_pct?.toFixed(0) || "?"}%\n\n• Analysis: Sequential failures indicate systemic unreliability. Even if current RUL is nominally sufficient, the probability of a 3rd failure within mission completion is statistically unacceptable (>85%).\n• Cumulative Damage: The airframe has consumed ${phys?.cumulative_damage_pct?.toFixed(1) || "?"}% of its structural life. This is non-recoverable.\n• AI Prescription: Abort primary mission and divert to nearest FOB immediately.`,
      resolutionNarrative: `ACTION EXECUTED: Aircraft diverted to nearest Forward Operating Base.\n\n• Cumulative structural damage: ${phys?.cumulative_damage_pct?.toFixed(1) || "?"}% of shaft life consumed.\n• Outcome: Airframe survival prioritized over mission completion.`,
    });
  }
  // ---------------------------------------------------------------------------------------------------------

  if (dev.fuelFlow > 0.35) {
    push({
      key: "fuelDelivery",
      subsystem: "fuel",
      title: d.sample.activeFaults.includes("fuelBlockage")
        ? "Fuel delivery restriction"
        : "Fuel pump performance loss",
      severity: dev.fuelFlow > 0.8 ? "critical" : "warning",
      confidence: clamp01(0.45 + dev.fuelFlow * 0.4),
      hotspot: "fuelSystem",
      contributions: [
        contribution(
          "fuelFlow",
          "Fuel flow",
          dev.fuelFlow * 52,
          fmt("fuelFlow", p.fuelFlow),
        ),
        contribution(
          "rpm",
          "RPM shortfall",
          clamp01(dev.rpm) * 26,
          fmt("rpm", p.rpm),
        ),
        contribution(
          "egt",
          "EGT (lean shift)",
          dev.egt * 22,
          fmt("egt", p.egt),
        ),
      ],
      narrative: `HARDWARE ANOMALY DETECTED: Fuel starvation on the primary delivery path.\n\n• Where: ${d.sample.fuelPath === "primary" ? "Primary" : "Secondary"} fuel pump and injection lines.\n• What: Telemetry reveals the commanded fuel flow for ${FLIGHT_PROFILES[d.sample.profile].label} is undershooting by -${(dev.fuelFlow * 100).toFixed(0)}%, forcing a -${(dev.rpm * 100).toFixed(0)}% RPM drop.\n• Hardware Impact: The mechanical pump impeller is cavitating or the primary fuel filter is severely clogged.\n• Threat: Engine will flame out imminently due to lean mixture starvation, plunging RUL to 0.`,
      resolutionNarrative: `ACTION EXECUTED: Redundant fuel cross-feed engaged.\n\n• Hardware Mitigation: Primary fuel pump deactivated. Electronically-actuated solenoid valves switched to the secondary backup fuel pump.\n• Software Mitigation: Fuel mapping tables reset to compensate for the momentary pressure drop.\n• Outcome: Volumetric fuel flow (+${(dev.fuelFlow * 100).toFixed(0)}%) instantly restored to the nominal profile. RPM recovered. Averted complete mission failure.`,
    });
  }

  if (dev.busVoltage > 0.4) {
    push({
      key: "busSag",
      subsystem: "electrical",
      title: "Main bus voltage sag",
      severity: dev.busVoltage > 0.85 ? "critical" : "warning",
      confidence: clamp01(0.5 + dev.busVoltage * 0.4),
      hotspot: "electrical",
      contributions: [
        contribution(
          "busVoltage",
          "Bus voltage",
          dev.busVoltage * 74,
          fmt("busVoltage", p.busVoltage),
        ),
        contribution(
          "rpm",
          "Generator drive RPM",
          clamp01(dev.rpm) * 26,
          fmt("rpm", p.rpm),
        ),
      ],
      narrative: `HARDWARE ANOMALY DETECTED: Uncommanded electrical bus voltage sag.\n\n• Where: Main 28V DC Electrical Bus and Alternator/Generator.\n• What: The main bus voltage is steadily decaying (-${(dev.busVoltage * 100).toFixed(0)}% under baseline) independently of engine RPM.\n• Hardware Impact: The generator field coils are weakening or the voltage regulator diode bridge has failed.\n• Threat: Avionics, servos, and the flight computer will brown-out and reboot if voltage drops below 22.0V (currently at ${p.busVoltage.toFixed(1)}V). Loss of control will instantly drop RUL to 0.`,
      resolutionNarrative: `ACTION EXECUTED: Emergency electrical load shedding protocol.\n\n• Hardware Mitigation: Non-essential payload sensors (EO/IR gimbal, radar) physically isolated from the main bus via solid-state relays.\n• Software Mitigation: Alternator exciter current boosted to compensate for the decaying field.\n• Outcome: Bus voltage stabilized back to nominal 28.1V (+${(dev.busVoltage * 100).toFixed(0)}% recovery). Avionics brown-out averted, preventing hull loss.`,
    });
  }

  if (dev.rpm > 0.5 && dev.fuelFlow < 0.3) {
    push({
      key: "icingLoad",
      subsystem: "engine",
      title: "Airframe structural icing",
      severity: "critical",
      confidence: clamp01(0.6 + dev.rpm * 0.4),
      hotspot: "propeller",
      contributions: [
        contribution("rpm", "RPM drag sag", dev.rpm * 60, fmt("rpm", p.rpm)),
        contribution(
          "egt",
          "EGT compensation",
          dev.egt * 40,
          fmt("egt", p.egt),
        ),
      ],
      narrative: `ENVIRONMENTAL ANOMALY DETECTED: Severe structural icing.\n\n• Where: Leading edges and propeller blades.\n• What: Ice accumulation is destroying aerodynamic lift and adding massive drag, dragging engine RPM down.\n• Hardware Impact: Engine is overloading to maintain speed, driving up exhaust temps.\n• Threat: Imminent stall and loss of altitude if unmitigated.`,
      resolutionNarrative: `ACTION EXECUTED: De-icing sequence initiated.\n\n• Hardware Mitigation: Propeller and wing de-ice boots activated. Engine RPM surge commanded to shed ice centrifugally.\n• Outcome: Ice shed successfully. RPM and temperatures returned to nominal. Lift restored.`,
    });
  }

  if (d.gpsErrorMetres > 45) {
    push({
      key: "gpsSpoof",
      subsystem: "nav",
      title: "GNSS spoofing suspected",
      severity: d.gpsErrorMetres > 140 ? "critical" : "warning",
      confidence: clamp01(0.5 + d.gpsErrorMetres / 400),
      hotspot: "avionics",
      contributions: [
        contribution(
          "gps",
          "Position Error",
          clamp01(d.gpsErrorMetres / 260) * 70,
          `${d.gpsErrorMetres.toFixed(0)} m divergence`,
        ),
        contribution(
          "redundancy",
          "Attitude Error",
          40,
          `${(d.gpsErrorMetres / 10).toFixed(1)}° induced roll`,
        ),
      ],
      narrative: `CRITICAL SECURITY ALERT: Foreign electronic warfare signals detected manipulating GNSS bands.\n\n? Root Cause: Malicious RF interference attempting to hijack positional awareness.\n? Physical Impact: Flight computer is aggressively banking (up to 45°) to chase a phantom coordinate. Path deviation is currently ${d.gpsErrorMetres.toFixed(1)} meters.\n? Action: Execute XAI fix immediately to switch to pure inertial/odometry navigation.`,
      resolutionNarrative: `ACTION EXECUTED: Secure Nav Mode Engaged.\n\n? Mitigation: AI flight controller dynamically dropped the spoofed GNSS feed and fell back to dead-reckoning and secondary IMU sensors.\n? Outcome: Erroneous banking counteracted. The aircraft has returned to nominal flight path and leveled its attitude (0° roll).`,
    });
  }

  if (d.redundancy[1]!.status === "fail") {
    push({
      key: "vibSensorFail",
      subsystem: "vibration",
      title: "Vibration channel A failure",
      severity: "advisory",
      confidence: 0.88,
      hotspot: "bearing",
      contributions: [
        contribution(
          "redundancy",
          "Channel A/B disagreement",
          78,
          `A ${d.sample.params.vibration.toFixed(2)} vs B ${d.sample.redundant.vibration.toFixed(2)} mm/s`,
        ),
        contribution(
          "vibration",
          "Channel A amplitude",
          22,
          "flatlined near zero",
        ),
      ],
      narrative: `HARDWARE ANOMALY DETECTED: Catastrophic failure of Vibration Sensor Channel A.\n\n• Where: Main engine block piezoelectric vibration sensor (Channel A).\n• What: The data stream from Channel A has abruptly flatlined to near-zero amplitude, while Channel B continues to report a plausible mechanical baseline.\n• Hardware Impact: The sensor crystal has likely shattered or the wiring harness has severed due to thermal cycling.\n• Threat: The digital twin and AI diagnostic engine will be blinded to physical fatigue if they rely on the dead sensor.`,
      resolutionNarrative: `ACTION EXECUTED: Autonomous redundancy failover.\n\n• Software Mitigation: The flight controller's voting logic has dynamically demoted and ignored the dead Channel A.\n• Hardware Mitigation: All Edge AI inference and FFT spectral analytics have been seamlessly rerouted to use redundant Channel B exclusively.\n• Outcome: Digital Twin visibility fully restored. Diagnostics are operating flawlessly on the backup sensor.`,
    });
  }

  if (phys && phys.mission_distance_km !== undefined) {
    if (phys.crashed) {
      push({
        key: "hullLoss",
        subsystem: "engine",
        title: "CATASTROPHIC HULL LOSS",
        severity: "critical",
        confidence: 1.0,
        hotspot: "engine",
        contributions: [
          contribution("rpm", "Altitude", 100, `0 ft (IMPACT)`),
          contribution("vibration", "Structural Integrity", 100, `0% (FAILED)`),
        ],
        narrative: `CRITICAL FAILURE: The aircraft has suffered a catastrophic structural failure and crashed.\n\n• Root Cause: Unmitigated mechanical fault led to complete structural shearing of the engine shaft.\n• Physical Impact: Complete loss of thrust and aerodynamics. The vehicle plummeted to the ground.\n• Action: Mission Terminated. Dispatch search and rescue.`,
        resolutionNarrative: `ACTION EXECUTED: Emergency Search and Rescue Deployed.\n\n• Mitigation: Flight computer wiped cryptographic keys to secure military intelligence.\n• Outcome: Recovery teams dispatched to the final transmitted coordinates (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}).`,
      });
    } else if (
      phys.rul_seconds <= 0 &&
      phys.altitude_ft &&
      phys.altitude_ft > 0
    ) {
      push({
        key: "plummeting",
        subsystem: "engine",
        title: "CRITICAL: AIRCRAFT IN FREEFALL",
        severity: "critical",
        confidence: 1.0,
        hotspot: "engine",
        contributions: [
          {
            key: "rpm",
            label: "Altitude",
            value: 100,
            detail: phys.altitude_ft.toFixed(0) + " ft and dropping",
          },
        ],
        narrative:
          "Remaining Useful Life exhausted. Engine shaft has sheared. Aircraft has lost all thrust and is plummeted towards terrain.",
        resolutionNarrative: "",
      });
    } else if (phys.rul_seconds < 60 && !phys.crashed) {
      push({
        key: "imminentCrash",
        subsystem: "engine",
        title: "IMMINENT CRASH WARNING",
        severity: "critical",
        confidence: 1.0,
        hotspot: "engine",
        contributions: [
          contribution(
            "rpm",
            "Time to Failure",
            100,
            `${phys.rul_seconds.toFixed(0)} seconds`,
          ),
        ],
        narrative: `CRITICAL WARNING: Structural failure is imminent in less than 60 seconds!\n\n• Threat: The fatigue crack has grown past critical thresholds. The shaft will snap momentarily.\n• Action: Immediately execute recommended fixes or commit to an emergency landing! If no action is taken, the UAV will suffer a complete hull loss.`,
        resolutionNarrative: `ACTION EXECUTED: Emergency Autoland Sequence Initiated.\n\n• Mitigation: Flight computer seized control from operator to execute a hard autonomous landing at the nearest clear terrain.\n• Outcome: Aircraft sustained severe gear damage but averted complete catastrophic structural shearing and hull loss.`,
      });
    }
    // Landing stage alerts are handled by evaluateLandingAlerts() above
    // (called via the isLanding guard at the top of evaluateAlerts)

    if (
      phys.fatigue_crack_m > 0.0012 &&
      d.sample.activeFaults.length === 0 &&
      !phys.crashed
    ) {
      push({
        key: "structural_healing",
        subsystem: "engine",
        title: "XAI Structural Healing Active",
        severity: "nominal",
        confidence: 0.99,
        hotspot: "engine",
        contributions: [
          contribution(
            "rpm",
            "Paris Law Reversal",
            100,
            "Stress reduction applied",
          ),
        ],
        narrative: `All acute physical faults have been cleared. Operating well below nominal stress thresholds.\n\n• Physics Outcome: The Paris Law fatigue crack is systematically arresting and healing over time.\n• Prognostic Impact: Remaining Useful Life (RUL) will now continually recover towards baseline.`,
      });
    }

    const rulMargin = phys.rul_seconds - phys.mission_time_seconds;
    if (
      d.sample.activeFaults.length === 0 &&
      !phys.crashed &&
      !phys.landed &&
      phys.rul_seconds < 10000 // RUL has been compromised by a previous fault
    ) {
      if (rulMargin > 0 && rulMargin < 20 * 60) {
        push({
          key: "prescriptiveDivert",
          subsystem: "engine",
          title: "RUL MARGIN CRITICAL: DIVERT ADVISED",
          severity: "warning",
          confidence: 1.0,
          hotspot: "engine",
          contributions: [
            contribution(
              "rpm",
              "RUL Margin",
              100,
              `${(rulMargin / 60).toFixed(1)} mins`,
            ),
          ],
          narrative: `CRITICAL ADVISORY: Fault fixed, but Remaining Useful Life is dangerously close to remaining mission time. \n\n? Threat: A safety margin of +20 mins is required. Current margin is only ${(rulMargin / 60).toFixed(1)} mins.\n? Action: Proceed with extreme caution or divert immediately to the nearest safe landing site.`,
          resolutionNarrative: `ACTION EXECUTED: Emergency Divert Initiated.\n\n? Mitigation: Flight computer plotting new trajectory to Safdarjung Airport (VDSJ).\n? Outcome: Aircraft is proceeding to safe landing site to ensure vehicle recovery.`,
        });
      }
    }

    // PROCEDURAL NARRATIVE GENERATOR
    const t = d.sample.t;
    if (!phys.crashed && phys.rul_seconds > 60) {
      // 1. Initial Boot Sequence
      if (t === 2) {
        push({
          key: "ambient_boot",
          subsystem: "engine",
          title: "Engine Spool-Up Nominal",
          severity: "nominal",
          confidence: 1.0,
          hotspot: "engine",
          contributions: [],
          narrative: `Pre-flight checks completed. Engine RPM stable. Oil pressure within bounds.`,
        });
      }
      if (t === 8) {
        push({
          key: "ambient_takeoff",
          subsystem: "nav",
          title: "Takeoff Successful",
          severity: "nominal",
          confidence: 1.0,
          hotspot: "avionics",
          contributions: [],
          narrative: `UAV has successfully cleared the runway. Landing gears locked and stowed. Commencing climb to cruise altitude.`,
        });
      }
      if (t === 18) {
        push({
          key: "ambient_cruise",
          subsystem: "nav",
          title: "Cruise Altitude Reached",
          severity: "nominal",
          confidence: 1.0,
          hotspot: "avionics",
          contributions: [],
          narrative: `Target altitude of ${phys.altitude_ft?.toFixed(0)} ft reached. Leveling off. Trim surfaces neutralized.`,
        });
      }

      // 2. Constant Ambient Info (Every 15s = ~20 frames)
      if (t > 20 && t % 20 === 0) {
        const ambients = [
          {
            title: "Network Link Stable",
            text: "Encrypted telemetry downlink maintaining 99.9% packet success rate.",
          },
          {
            title: "Payload Thermal Check",
            text: "Optics and IR payload temperatures are nominal. Peltier cooling active.",
          },
          {
            title: "Airspace Deconfliction",
            text: "No conflicting traffic detected within 50 km radius via ADS-B.",
          },
          {
            title: "Battery Balance",
            text: "Avionics backup battery cells balanced within 0.02V delta.",
          },
          {
            title: "Fuel Transfer Pump",
            text: "Wing tank to header tank transfer pump cycled successfully.",
          },
          {
            title: "GNSS Differential Active",
            text: "Receiving differential corrections from 12 orbital satellites. Navigation uncertainty < 0.5 meters.",
          },
          {
            title: "Atmospheric Telemetry",
            text: `Current atmospheric density: ${phys.air_density_kgm3?.toFixed(3)} kg/m³. ISA Deviation: nominal. Clear skies reported.`,
          },
        ];
        const idx = Math.floor(t / 20) % ambients.length;
        push({
          key: `ambient_spam_${t}`,
          subsystem: "electrical",
          title: ambients[idx].title,
          severity: "nominal",
          confidence: 1.0,
          hotspot: "redundancy",
          contributions: [],
          narrative: ambients[idx].text,
        });
      }

      // 3. Procedural Minor Advisories (Every 30s = ~40 frames)
      // Only inject if no manual faults are active and no critical issues exist
      if (
        t > 25 &&
        t % 40 === 0 &&
        d.sample.activeFaults.length === 0 &&
        !phys.crashed &&
        !phys.landed &&
        phys.mission_distance_km > 10.0 &&
        phys.rul_seconds > 3600
      ) {
        const advisories = [
          {
            title: "Minor Thermal Fluctuation",
            text: "Exhaust gas temperature showing minor instability (+2%). ECU automatically adjusting mixture. No pilot action required at this time.\n\n⚠️ Prognostic Note: Such minor operational stress anomalies marginally accelerate Paris Law fatigue crack growth, continuously lowering Remaining Useful Life (RUL) by a fraction of a percent.",
          },
          {
            title: "Transient Vibration Detected",
            text: "Short burst of mechanical resonance detected on the prop shaft. Likely a wind gust or minor turbulence. Monitoring closely.\n\n⚠️ Prognostic Note: Accumulated micro-vibrations slowly degrade engine shaft integrity, directly contributing to the gradual reduction of system RUL over the mission.",
          },
          {
            title: "GNSS HDOP Spike",
            text: "Navigation uncertainty temporarily spiked to 2.1 meters due to satellite geometry. Multipath mitigation active.",
          },
          {
            title: "CAN Bus Retries",
            text: "Minor packet collision on the secondary CAN bus. Flight controller successfully requested retry. Zero data loss.",
          },
        ];
        const idx = Math.floor(t / 40) % advisories.length;
        push({
          key: `auto_advisory_${t}`,
          subsystem: "engine",
          title: advisories[idx].title,
          severity: "advisory",
          confidence: 0.85,
          hotspot: "engine",
          contributions: [],
          narrative: advisories[idx].text,
        });
      }
    }
  }

  return out;
}

export function hotspotLabel(hotspot: string) {
  return HOTSPOTS[hotspot]?.label ?? hotspot;
}

export function severityRank(severity: Severity) {
  return { nominal: 0, advisory: 1, warning: 2, critical: 3 }[severity];
}

export function alertFromCandidate(
  candidate: AlertCandidate,
  missionTime: number,
  rulMinutes: number | null,
): Alert {
  return {
    id: `${candidate.key}-${Math.round(missionTime)}`,
    key: candidate.key,
    raisedAt: Date.now(),
    missionTime,
    subsystem: candidate.subsystem,
    title: candidate.title,
    severity: candidate.severity,
    confidence: Math.round(candidate.confidence * 100) / 100,
    rulMinutes,
    contributions: [...candidate.contributions].sort(
      (a, b) => b.value - a.value,
    ),
    narrative: candidate.narrative,
    hotspot: candidate.hotspot,
  };
}
