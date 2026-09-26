// @ts-nocheck
import React, { useState } from "react";
import {
  CheckCircle2,
  ShieldAlert,
  Activity,
  XCircle,
  AlertTriangle,
  PlaneLanding,
  Wrench,
  X,
  Download,
  MapPin,
} from "lucide-react";
import { useMission } from "@/lib/twin/store";
import { cn } from "@/lib/utils";
import { SCENARIO_BY_KEY } from "@/lib/twin/profiles";

function fmt(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function Stat({
  label,
  value,
  alert,
  sub,
}: {
  label: string;
  value: string;
  alert?: boolean;
  sub?: string;
}) {
  return (
    <div
      className={cn(
        "rounded border p-3",
        alert
          ? "border-red-500/40 bg-red-500/10"
          : "border-border/50 bg-muted/10",
      )}
    >
      <p
        className={cn(
          "text-[0.6rem] uppercase tracking-wider",
          alert ? "text-red-400" : "text-muted-foreground",
        )}
      >
        {label}
      </p>
      <p
        className={cn(
          "font-mono text-xl font-bold mt-1 leading-tight",
          alert ? "text-red-300" : "text-white",
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[0.6rem] text-muted-foreground mt-0.5">{sub}</p>
      )}
    </div>
  );
}

export function PostFlightReview() {
  const { displayed, alerts, healActions, isDiverted, blackbox } = useMission();
  const phys = displayed?.sample.physics;
  const [closed, setClosed] = useState(false);

  const exportLog = () => {
    const blob = new Blob([JSON.stringify(blackbox, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flight-blackbox-${displayed?.sample.missionId ?? "export"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const health = displayed?.health;

  // Only show if landed or crashed
  if (!phys?.landed && !phys?.crashed) return null;
  if (closed) return null;

  const isCrashed = phys.crashed && !phys.landed;
  const isLanded = phys.landed;
  const faultHistory: string[] = phys?.fault_history ?? [];
  const damagePct = phys?.cumulative_damage_pct ?? 0;
  const crackMm = (phys?.fatigue_crack_m ?? 0) * 1000;
  const bearingDamaged = phys?.bearing_permanently_damaged ?? false;

  const t = displayed?.sample.t ?? 0;
  const flightTime = `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;

  const majorAlerts = alerts.filter(
    (a) => a.severity === "critical" || a.severity === "warning",
  );

  // Outcome
  const outcome = isCrashed
    ? {
        label: "HULL LOSS — AIRCRAFT CRASHED",
        color: "text-red-500",
        borderTop: "border-red-500",
        icon: XCircle,
        iconColor: "text-red-500",
      }
    : isDiverted
      ? {
          label: "MISSION ABORTED — SAFELY DIVERTED TO FOB",
          color: "text-amber-400",
          borderTop: "border-amber-500",
          icon: AlertTriangle,
          iconColor: "text-amber-400",
        }
      : {
          label: "MISSION COMPLETE — SAFE LANDING",
          color: "text-green-400",
          borderTop: "border-green-500",
          icon: PlaneLanding,
          iconColor: "text-green-400",
        };

  const OutcomeIcon = outcome.icon;

  // Maintenance recommendations
  type Sev = "critical" | "warning" | "ok";
  const recs: { label: string; severity: Sev }[] = [];
  if (isCrashed) {
    recs.push({
      label: "Full hull inspection required before any next flight",
      severity: "critical",
    });
    recs.push({
      label: "Engine shaft fractured — replace engine assembly entirely",
      severity: "critical",
    });
  }
  if (bearingDamaged) {
    recs.push({
      label: "Main bearing race spalled — full bearing replacement mandatory",
      severity: "critical",
    });
    recs.push({
      label: "Oil gallery flush required — metal fragment contamination likely",
      severity: "critical",
    });
  }
  if (damagePct > 75)
    recs.push({
      label: `Shaft at ${damagePct.toFixed(0)}% structural life — engine overhaul required`,
      severity: "critical",
    });
  else if (damagePct > 40)
    recs.push({
      label: `Shaft at ${damagePct.toFixed(0)}% structural life — schedule inspection`,
      severity: "warning",
    });

  faultHistory.forEach((f) => {
    if (f === "oilStarvation")
      recs.push({
        label: "Oil pump inspection and gallery flush required",
        severity: "warning",
      });
    if (f === "bearingWear")
      recs.push({
        label: "Full bearing replacement — mid-flight spalling detected",
        severity: "critical",
      });
    if (f === "fuelBlockage")
      recs.push({
        label: "Primary fuel filter replacement required",
        severity: "warning",
      });
    if (f === "fuelPumpDegrade")
      recs.push({
        label: "Fuel pump impeller replacement recommended",
        severity: "warning",
      });
    if (f === "propImbalance")
      recs.push({
        label: "Propeller blade inspection and static re-balance",
        severity: "warning",
      });
    if (f === "egtOvertemp")
      recs.push({
        label: "Turbine blade and combustion chamber inspection",
        severity: "warning",
      });
    if (f === "icing")
      recs.push({
        label: "Anti-ice system inspection and pitot heat check",
        severity: "warning",
      });
    if (f === "busSag")
      recs.push({
        label: "Alternator output voltage check — ripple anomaly logged",
        severity: "warning",
      });
  });
  if (recs.length === 0)
    recs.push({
      label: "No critical anomalies — standard post-flight check sufficient",
      severity: "ok",
    });

  // Deduplicate
  const seen = new Set<string>();
  const uniqueRecs = recs.filter((r) =>
    seen.has(r.label) ? false : (seen.add(r.label), true),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4 sm:p-6">
      <div
        className={cn(
          "relative w-full max-w-2xl rounded-lg shadow-2xl flex flex-col max-h-[90vh]",
          "bg-[#0a0c10] border border-border/40",
        )}
      >
        {/* Close button */}
        <button
          onClick={() => setClosed(true)}
          className="absolute top-4 right-4 p-2 text-muted-foreground hover:text-white rounded-full hover:bg-white/10 transition-colors"
        >
          <X className="size-5" />
        </button>
        {/* Colored top bar */}
        <div
          className={cn(
            "shrink-0 h-1 rounded-t-lg",
            outcome.borderTop,
            "bg-current opacity-80",
          )}
          style={{
            backgroundColor: isCrashed
              ? "#ef4444"
              : isDiverted
                ? "#f59e0b"
                : "#22c55e",
          }}
        />

        <div className="p-4 sm:p-6 space-y-5 overflow-y-auto custom-scrollbar">
          {/* Header */}
          <div className="flex items-center gap-4">
            <OutcomeIcon
              className={cn("size-12 shrink-0", outcome.iconColor)}
            />
            <div>
              <p className="text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
                Post-Flight Review • Session{" "}
                {displayed?.sample.missionId ?? "—"}
              </p>
              <h2
                className={cn(
                  "text-xl font-bold mt-0.5 leading-tight",
                  outcome.color,
                )}
              >
                {outcome.label}
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Flight duration: {flightTime} • Anomalies logged:{" "}
                {faultHistory.length} • Fleet Health: {health?.overall ?? 0}%
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Flight Duration" value={flightTime} />
            <Stat
              label="Structural Damage"
              value={`${damagePct.toFixed(1)}%`}
              alert={damagePct > 50}
              sub="of shaft life consumed"
            />
            <Stat
              label="Fatigue Crack"
              value={`${crackMm.toFixed(3)} mm`}
              alert={crackMm > 2.0}
              sub="Paris' Law projection"
            />
          </div>

          {/* Bearing status banner */}
          {bearingDamaged && (
            <div className="flex items-center gap-3 rounded border border-red-500/50 bg-red-950/30 px-4 py-3">
              <XCircle className="size-5 text-red-400 shrink-0" />
              <div>
                <p className="text-xs font-bold text-red-300">
                  Main Bearing — Permanently Spalled
                </p>
                <p className="text-[0.65rem] text-red-400/70 mt-0.5">
                  Metal fragments circulated through oil gallery. Full teardown
                  inspection required.
                </p>
              </div>
            </div>
          )}

          {/* Fault timeline */}
          {faultHistory.length > 0 && (
            <div>
              <p className="text-[0.65rem] uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                <ShieldAlert className="size-3.5" />
                Anomaly Timeline ({faultHistory.length} events)
              </p>
              <div className="flex flex-wrap gap-2">
                {faultHistory.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5"
                  >
                    <span className="text-[0.55rem] text-muted-foreground font-mono">
                      #{i + 1}
                    </span>
                    <span className="text-[0.65rem] font-semibold text-amber-300">
                      {SCENARIO_BY_KEY[f]?.label ?? f}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Detailed Threat Timeline */}
          {alerts.length > 0 && (
            <div>
              <p className="text-[0.65rem] uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                <Activity className="size-3.5" /> Detailed Incident Timeline &
                Forensics
              </p>
              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                {alerts.map((a) => (
                  <div
                    key={a.id}
                    className={cn(
                      "rounded-md border p-3",
                      a.severity === "critical"
                        ? "border-red-500/40 bg-red-950/20"
                        : a.severity === "warning"
                          ? "border-amber-500/30 bg-amber-950/20"
                          : a.severity === "info"
                            ? "border-blue-500/30 bg-blue-950/20"
                            : "border-border/40 bg-muted/20",
                    )}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "text-[0.55rem] font-bold uppercase px-1.5 py-0.5 rounded",
                            a.severity === "critical"
                              ? "bg-red-500/20 text-red-400"
                              : a.severity === "warning"
                                ? "bg-amber-500/20 text-amber-400"
                                : "bg-blue-500/20 text-blue-400",
                          )}
                        >
                          {a.severity}
                        </span>
                        <span className="text-xs font-bold text-white">
                          {a.title}
                        </span>
                      </div>
                      <span className="text-[0.65rem] text-muted-foreground font-mono">
                        T+{Math.floor(a.missionTime)}s
                      </span>
                    </div>
                    {a.narrative && (
                      <p className="text-[0.65rem] text-muted-foreground/90 mt-1.5 leading-relaxed">
                        {a.narrative}
                      </p>
                    )}

                    {a.contributions && a.contributions.length > 0 && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        {a.contributions.map((c, i) => (
                          <div
                            key={i}
                            className="flex flex-col bg-black/40 rounded px-2 py-1.5 border border-white/5"
                          >
                            <span className="text-[0.55rem] uppercase text-muted-foreground">
                              {c.label}
                            </span>
                            <span className="text-xs font-mono font-medium text-white">
                              {c.detail || c.value + "% impact"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Faults & heals */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[0.65rem] uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                <AlertTriangle className="size-3.5" /> Active Alerts at
                Termination
              </p>
              <div className="space-y-1">
                {majorAlerts.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">None</p>
                ) : (
                  majorAlerts.slice(0, 4).map((a) => (
                    <div
                      key={a.id}
                      className={cn(
                        "text-xs rounded border px-2 py-1",
                        a.severity === "critical"
                          ? "border-red-500/30 bg-red-500/10 text-red-300"
                          : "border-amber-500/20 bg-amber-500/8 text-amber-300",
                      )}
                    >
                      <span className="font-bold uppercase text-[0.6rem] mr-1">
                        {a.severity}
                      </span>
                      {a.title}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div>
              <p className="text-[0.65rem] uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                <CheckCircle2 className="size-3.5 text-green-400" /> Mitigations
                Executed
              </p>
              <div className="space-y-1">
                {isDiverted && (
                  <div className="text-xs rounded border border-primary/30 bg-primary/10 text-primary px-2 py-1">
                    <span className="font-bold uppercase text-[0.6rem] mr-1">
                      COMMANDED
                    </span>
                    Emergency divert to FOB
                  </div>
                )}
                {healActions.length === 0 && !isDiverted && (
                  <p className="text-xs text-muted-foreground italic">
                    No interventions required
                  </p>
                )}
                {healActions.slice(0, 3).map((h) => (
                  <div
                    key={h.id}
                    className="text-xs rounded border border-green-500/20 bg-green-500/8 text-green-300 px-2 py-1"
                  >
                    <span className="font-bold uppercase text-[0.6rem] mr-1">
                      EXECUTED
                    </span>
                    {h.action}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Maintenance recommendations */}
          <div>
            <p className="text-[0.65rem] uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
              <Wrench className="size-3.5" /> Maintenance Recommendations
            </p>
            <div className="space-y-1.5">
              {uniqueRecs.map((r, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-start gap-2 rounded border px-3 py-2",
                    r.severity === "critical"
                      ? "border-red-500/40 bg-red-500/10"
                      : r.severity === "warning"
                        ? "border-amber-500/30 bg-amber-500/5"
                        : "border-green-500/30 bg-green-500/5",
                  )}
                >
                  {r.severity === "critical" ? (
                    <XCircle className="size-3.5 text-red-400 mt-0.5 shrink-0" />
                  ) : r.severity === "warning" ? (
                    <AlertTriangle className="size-3.5 text-amber-400 mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="size-3.5 text-green-400 mt-0.5 shrink-0" />
                  )}
                  <p
                    className={cn(
                      "text-xs",
                      r.severity === "critical"
                        ? "text-red-300"
                        : r.severity === "warning"
                          ? "text-amber-300"
                          : "text-green-300",
                    )}
                  >
                    {r.label}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex flex-col gap-3 pt-3 border-t border-border/30">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Activity className="size-3.5" />
                <p className="text-[0.6rem]">
                  Flight data committed to Tamper-Evident Black Box • SHA-256
                  verified
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exportLog}
                  className="rounded-sm border border-border px-3 py-1.5 font-mono text-[0.65rem] uppercase hover:bg-white/10 transition-colors bg-white/5 flex items-center gap-2 text-white"
                >
                  <Download className="size-3" /> EXPORT BLACKBOX
                </button>
                <div
                  className={cn(
                    "rounded px-3 py-1.5 text-xs font-bold",
                    isCrashed
                      ? "bg-red-600/30 text-red-300 border border-red-500/40"
                      : "bg-green-600/20 text-green-300 border border-green-500/30",
                  )}
                >
                  {isCrashed
                    ? "🔴 GROUNDED — DO NOT FLY"
                    : "🟢 CLEARED FOR DEBRIEF"}
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 text-[0.65rem] font-mono text-muted-foreground bg-black/40 p-2.5 rounded border border-white/5">
              <div className="flex items-center gap-1.5">
                <MapPin className="size-3.5 text-blue-400" />
                <span className="text-white/40 uppercase tracking-widest mr-1">
                  LAST TRACE:
                </span>
                <span className="text-white">
                  LAT {displayed?.sample.gps?.lat.toFixed(6)}°
                </span>{" "}
                <span className="text-white/30">•</span>{" "}
                <span className="text-white">
                  LON {displayed?.sample.gps?.lon.toFixed(6)}°
                </span>
              </div>
              <div className="hidden sm:block h-3 w-px bg-white/10" />
              <div className="flex items-center gap-1.5 pl-5 sm:pl-0">
                <span className="text-white/40 uppercase tracking-widest mr-1">
                  {isCrashed ? "IMPACT COORDS:" : "LANDING COORDS:"}
                </span>
                <span
                  className={
                    isCrashed
                      ? "text-red-400 font-bold"
                      : "text-green-400 font-bold"
                  }
                >
                  {displayed?.sample.gps?.lat.toFixed(6)},{" "}
                  {displayed?.sample.gps?.lon.toFixed(6)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
