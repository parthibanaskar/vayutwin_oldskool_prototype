// @ts-nocheck
import { AlertTriangle, Info, ShieldCheck, Wrench } from "lucide-react";

import { useMission } from "@/lib/twin/store";
import { hotspotLabel } from "@/lib/twin/analytics";
import { Chip, Panel, severityTone, toneBg, toneText } from "./primitives";
import { cn } from "@/lib/utils";
import { useState } from "react";

export function AlertFeed({ className }: { className?: string }) {
  const {
    alerts,
    setFocusHotspot,
    clearFault,
    reduceThrottle,
    setFuelPath,
    setNavMode,
    applyHealAction,
    resolvedAlerts,
    setResolvedAlerts,
    divert,
    commandSafeLanding,
  } = useMission();
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);

  return (
    <Panel
      title="Autonomous Reasoning Feed"
      subtitle="LIVE XAI EXPLANATIONS"
      className={className}
      bodyClassName="p-2 relative flex flex-col h-full"
    >
      <div className="absolute inset-0 overflow-y-auto p-2 pb-6 space-y-3">
        {alerts.length === 0 && resolvedAlerts.length === 0 ? (
          <p className="text-muted text-sm pt-4 pl-2">
            No telemetry data available.
          </p>
        ) : null}
        {[...alerts]
          .sort((a, b) => {
            const aCrit =
              a.severity === "critical" && !resolvedAlerts.has(a.id);
            const bCrit =
              b.severity === "critical" && !resolvedAlerts.has(b.id);
            if (aCrit && !bCrit) return -1;
            if (!aCrit && bCrit) return 1;

            const aWarn = a.severity === "warning" && !resolvedAlerts.has(a.id);
            const bWarn = b.severity === "warning" && !resolvedAlerts.has(b.id);
            if (aWarn && !bWarn) return -1;
            if (!aWarn && bWarn) return 1;

            return b.raisedAt - a.raisedAt;
          })
          .map((a) => {
            const tone = severityTone(a.severity);
            const open = selectedAlertId === a.id;
            const total =
              a.contributions.reduce((s, c) => s + Math.abs(c.value), 0) || 1;
            const isProblem =
              a.severity === "critical" || a.severity === "warning";
            const Icon = isProblem
              ? AlertTriangle
              : a.severity === "nominal"
                ? ShieldCheck
                : Info;

            return (
              <div
                key={a.id}
                className={cn(
                  "group cursor-pointer rounded border border-panel bg-panel-hover p-2 shadow-sm transition-colors hover:border-border",
                  open && tone === "crit" ? "border-crit shadow-crit/20" : "",
                  open && tone === "warn" ? "border-warn shadow-warn/20" : "",
                  open && tone === "info" ? "border-info shadow-info/20" : "",
                  open && tone === "ok" ? "border-ok shadow-ok/20" : "",
                )}
              >
                <div
                  className="flex items-start gap-2"
                  onClick={() => setSelectedAlertId(open ? null : a.id)}
                >
                  <Icon
                    className={cn(
                      "shrink-0",
                      isProblem
                        ? "size-5 mt-0.5 animate-pulse"
                        : "size-4 mt-0.5",
                      toneText[tone],
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "font-semibold leading-snug",
                        isProblem ? "text-base uppercase" : "text-sm",
                      )}
                    >
                      {a.title}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Chip tone={tone}>{a.severity}</Chip>
                      <Chip tone="info">
                        conf {(a.confidence * 100).toFixed(0)}%
                      </Chip>
                      <Chip
                        tone={
                          a.rulMinutes !== null && a.rulMinutes < 12
                            ? "crit"
                            : "muted"
                        }
                      >
                        RUL{" "}
                        {a.rulMinutes === null
                          ? "stable"
                          : `${a.rulMinutes.toFixed(0)} min`}
                      </Chip>
                      <Chip tone="muted">{hotspotLabel(a.hotspot)}</Chip>
                    </div>
                  </div>
                </div>

                <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {a.narrative}
                  </p>
                  <div className="space-y-1">
                    {a.contributions.map((c) => (
                      <div key={c.key + c.label}>
                        <div className="flex justify-between gap-2 font-mono text-[0.65rem]">
                          <span>{c.label}</span>
                          <span className="text-muted-foreground">
                            {c.detail} · +{c.value.toFixed(1)}
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn("h-full", toneBg[tone])}
                            style={{
                              width: `${(Math.abs(c.value) / total) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-2 mt-2 border-t border-border/30">
                  {resolvedAlerts.has(a.id) &&
                  a.severity !== "info" &&
                  a.severity !== "nominal" ? (
                    <div className="w-full rounded-sm bg-green-500/10 p-2 text-left border border-green-500/30">
                      <p className="text-xs font-bold text-green-400 mb-1">
                        {a.key === "prescriptiveThrottle"
                          ? "RUL EXTENDED"
                          : "SYSTEM RESTORED"}
                      </p>
                      <div className="text-[0.65rem] text-muted-foreground leading-tight whitespace-pre-wrap">
                        {a.resolutionNarrative ||
                          (a.key === "prescriptiveThrottle"
                            ? "Throttle reduced by 15%.\n• Structural stress decreased\n• Crack growth velocity dropped\n• RUL successfully extended to ensure safe arrival at destination."
                            : "Mitigation sequence executed successfully. Fault cleared from edge controller. Subsystem parameters have stabilized and returned to NOMINAL profiles.")}
                      </div>
                    </div>
                  ) : a.severity !== "nominal" &&
                    a.severity !== "info" &&
                    !a.key.startsWith("landing") &&
                    !a.key.startsWith("suddenShift_") &&
                    !a.key.startsWith("auto_advisory_") ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // Map alert keys back to scenario injection keys to clear them
                        const clears: Record<string, string[]> = {
                          propImbalance: ["propImbalance"],
                          oilPressureDrop: ["oilStarvation"],
                          fuelDelivery: ["fuelBlockage", "fuelPumpDegrade"],
                          electricalFault: ["busSag"],
                          egtDrift: ["sensorDrift"],
                          vibSensorFail: ["vibSensorFail"],
                          gpsSpoofing: ["gpsSpoof"],
                          icingLoad: ["icing"],
                          hiddenRedundancy: ["sensorDrift", "vibSensorFail"],
                        };

                        const toClear = clears[a.key] || [a.key];
                        const hasPhysicalFaults = alerts.some(
                          (al) =>
                            ![
                              "prescriptiveDivert",
                              "imminentCrash",
                              "prescriptiveThrottle",
                              "landingApproach",
                              "landingGears",
                              "landingFlare",
                              "landingTouchdown",
                              "crashDetected",
                              "cascadingFailures",
                              "bearingPermanentDamage",
                            ].includes(al.key) && !resolvedAlerts.has(al.id),
                        );

                        if (
                          a.key === "prescriptiveDivert" ||
                          a.key === "imminentCrash" ||
                          a.key === "cascadingFailures" ||
                          a.key === "bearingPermanentDamage" ||
                          a.key === "bearingWear"
                        ) {
                          if (!hasPhysicalFaults) {
                            commandSafeLanding("Safdarjung Airport (VDSJ)");
                            divert(28.58, 77.2);
                          }
                        } else if (a.key === "prescriptiveThrottle") {
                          reduceThrottle();
                        } else if (a.key === "fuelDelivery") {
                          setFuelPath("secondary");
                          toClear.forEach((c) => clearFault(c));
                        } else if (a.key === "gpsSpoof") {
                          setNavMode("inertial");
                          toClear.forEach((c) => clearFault(c));
                        } else {
                          toClear.forEach((c) => clearFault(c));
                        }

                        // Mark as resolved locally so the UI updates to show the impact
                        setResolvedAlerts((prev) => new Set(prev).add(a.id));
                        applyHealAction(a.key);

                        // Also visually deselect it if you want, but we can keep it open so they see the success message
                        // selectAlert(null);
                      }}
                      className="w-full flex items-center justify-center gap-2 rounded-sm bg-primary/10 py-1.5 text-xs font-semibold uppercase tracking-widest text-primary transition-colors hover:bg-primary/20 hover:bg-green-900/40 hover:text-green-400 border border-transparent hover:border-green-500/50"
                    >
                      <Wrench className="size-3" /> Execute Recommended Fixes
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
      </div>
    </Panel>
  );
}
