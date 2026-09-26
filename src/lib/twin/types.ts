// @ts-nocheck
export type ParamKey =
  | "rpm"
  | "egt"
  | "vibration"
  | "oilPressure"
  | "oilTemp"
  | "fuelFlow"
  | "busVoltage"
  | "cht";

export const PARAM_KEYS: ParamKey[] = [
  "rpm",
  "egt",
  "vibration",
  "oilPressure",
  "oilTemp",
  "fuelFlow",
  "busVoltage",
  "cht",
];

export type Subsystem =
  "engine" | "vibration" | "lubrication" | "fuel" | "electrical" | "nav";

export const SUBSYSTEMS: Subsystem[] = [
  "engine",
  "vibration",
  "lubrication",
  "fuel",
  "electrical",
  "nav",
];

export type FlightProfile =
  "idle" | "takeoff" | "cruise" | "loiter" | "descent" | "shutdown";

export type Severity = "nominal" | "advisory" | "warning" | "critical";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface Sample {
  /** Mission elapsed seconds. */
  t: number;
  wallClock: number;
  profile: FlightProfile;
  params: Record<ParamKey, number>;
  /** Redundant (channel B) sensors for the disagreement detector. */
  redundant: { egt: number; vibration: number; oilPressure: number };
  /** Short vibration waveform window used for the FFT panel. */
  vibWave: number[];
  vibSampleRate: number;
  spectrum?: { freq: number; mag: number }[];
  gps: GeoPoint;
  inertial: GeoPoint;
  gpsSats: number;
  fuelPath: "primary" | "secondary";
  activeFaults: string[];
  /** Real-time physics evaluations based on the MALE UAV digital twin formulas. */
  physics?: {
    rho: number;
    LD: number;
    BSFC: number;
    eta_th: number;
    fatigue_crack_m: number;
    rul_seconds: number;
    hypo_rul_seconds?: number;
    mission_time_seconds?: number;
    mission_distance_km?: number;
    throttle_reduction?: number;
    altitude_ft?: number;
    pitch_deg?: number;
    roll_deg?: number;
    gpsSpoofed: boolean;
    landing_mode?: boolean;
    landed?: boolean;
    crashed?: boolean;
    fault_history_count?: number;
    fault_history?: string[];
    bearing_permanently_damaged?: boolean;
    cumulative_damage_pct?: number;
  };
}

export interface HealthState {
  overall: number;
  subsystems: Record<Subsystem, number>;
}

export interface FeatureContribution {
  key: ParamKey | "redundancy" | "spectral" | "gps";
  label: string;
  /** Signed contribution in percentage points of the risk score. */
  value: number;
  detail: string;
}

export interface Alert {
  id: string;
  key: string;
  raisedAt: number;
  missionTime: number;
  subsystem: Subsystem;
  title: string;
  severity: Severity;
  confidence: number;
  rulMinutes: number | null;
  contributions: FeatureContribution[];
  narrative: string;
  hotspot: string;
}

export interface SelfHealAction {
  id: string;
  at: number;
  triggerKey: string;
  action: string;
  status: "applied" | "monitoring" | "recommended";
  detail: string;
}

export interface BlackBoxEntry {
  seq: number;
  loggedAt: number;
  kind: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Scenario {
  key: string;
  label: string;
  subsystem: Subsystem;
  severity: Severity;
  hotspot: string;
  /** Seconds for the fault to reach full magnitude. */
  rampSeconds: number;
  description: string;
}
