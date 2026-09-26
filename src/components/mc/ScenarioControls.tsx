// @ts-nocheck
import { useState, useEffect } from "react";
import { Pause, Play, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";

import { useMission } from "@/lib/twin/store";
import { FLIGHT_PROFILES, SCENARIOS } from "@/lib/twin/profiles";
import type { FlightProfile } from "@/lib/twin/types";
import { Chip, Panel, severityTone } from "./primitives";
import { cn } from "@/lib/utils";

const PROFILE_ORDER: FlightProfile[] = [
  "idle",
  "takeoff",
  "cruise",
  "loiter",
  "descent",
];

export function ScenarioControls() {
  const [expanded, setExpanded] = useState(false);
  const [showHint, setShowHint] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShowHint(false), 15000);
    return () => clearTimeout(timer);
  }, []);
  const {
    profile,
    setProfile,
    activeFaults,
    injectFault,
    clearFault,
    clearAllFaults,
    setThrottle,
    calibrate,
    paused,
    setPaused,
    speed,
    setSpeed,
    frames,
    cursor,
    setCursor,
    live,
    isDiverted,
  } = useMission();

  return (
    <Panel
      title="Mission replay & scenario injection"
      subtitle="INJECT CRITICAL SYSTEM FAILURES"
      right={
        <div className="relative flex items-center gap-1">
          {showHint && !expanded && (
            <div className="absolute -top-[3.25rem] right-0 flex flex-col items-end animate-bounce pointer-events-none z-50">
              <span className="bg-primary text-primary-foreground text-xs px-2.5 py-1.5 rounded-sm font-bold whitespace-nowrap shadow-[0_0_20px_rgba(0,255,100,0.4)] border border-primary/50">
                START HERE: INJECT FAULT
              </span>
              <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-primary mr-6"></div>
            </div>
          )}
          <button
            onClick={() => setPaused(!paused)}
            className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 font-mono text-[0.65rem] uppercase hover:bg-accent"
          >
            {paused ? (
              <Play className="size-3" />
            ) : (
              <Pause className="size-3" />
            )}
            {paused ? "resume" : "hold"}
          </button>
          {[1, 2, 4].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn(
                "rounded-sm border px-1.5 py-1 font-mono text-[0.65rem]",
                speed === s && !paused
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {s}x
            </button>
          ))}
          <button
            onClick={clearAllFaults}
            className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 font-mono text-[0.65rem] uppercase hover:bg-accent"
          >
            <RotateCcw className="size-3" /> reset
          </button>
          <div className="mx-1 h-3 w-px bg-border"></div>
          <button
            onClick={() => {
              setExpanded(!expanded);
              setShowHint(false);
            }}
            className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 font-mono text-[0.65rem] uppercase transition-colors hover:bg-accent"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "HIDE SCENARIOS" : "INJECT SCENARIO"}
            {expanded ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
          </button>
        </div>
      }
      bodyClassName={cn("space-y-2 p-3 transition-all", !expanded && "hidden")}
    >
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3 xl:grid-cols-4">
        {SCENARIOS.map((s) => {
          const active = activeFaults.includes(s.key);
          const isGrounded =
            live?.sample?.physics?.landed || live?.sample?.physics?.crashed;
          const disabled = !active && (isDiverted || isGrounded);
          return (
            <button
              key={s.key}
              onClick={() => (active ? clearFault(s.key) : injectFault(s.key))}
              disabled={disabled}
              title={
                disabled
                  ? "Cannot inject faults after diversion or failure"
                  : s.description
              }
              className={cn(
                "rounded-sm border p-1.5 text-left transition-colors",
                disabled
                  ? "opacity-30 cursor-not-allowed border-border/30"
                  : active
                    ? "border-crit/60 bg-crit/10"
                    : "border-border/70 bg-muted/20 hover:border-border",
              )}
            >
              <p className="truncate text-[0.72rem] font-semibold">{s.label}</p>
              <div className="mt-1 flex items-center gap-1">
                <Chip tone={severityTone(s.severity)}>{s.severity}</Chip>
                {active ? <Chip tone="crit">injected</Chip> : null}
              </div>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
