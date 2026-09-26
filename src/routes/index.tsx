import { createFileRoute } from "@tanstack/react-router";

import { MissionProvider, useMission } from "@/lib/twin/store";
import { HOTSPOTS } from "@/lib/twin/profiles";
import { TopBar } from "@/components/mc/TopBar";
import { ParamGrid } from "@/components/mc/ParamGrid";
import { PhysicsPanel } from "@/components/mc/PhysicsPanel";
import { TrendChart } from "@/components/mc/TrendChart";
import { SpectrumPanel } from "@/components/mc/SpectrumPanel";
import { RedundancyPanel } from "@/components/mc/RedundancyPanel";
import { AlertFeed } from "@/components/mc/AlertFeed";
import { PostFlightReview } from "@/components/mc/PostFlightReview";

import { ScenarioControls } from "@/components/mc/ScenarioControls";
import { SafeLanding } from "@/components/mc/SafeLanding";
import { BlackBoxPanel } from "@/components/mc/BlackBoxPanel";
import { MasterAlarmBanner } from "@/components/mc/MasterAlarmBanner";
import { ThreatAssessment } from "@/components/mc/ThreatAssessment";
import { UavTwin } from "@/components/mc/twin/UavTwin";
import { WeatherWidget } from "@/components/mc/WeatherWidget";
import { Chip, Panel, healthTone, toneText } from "@/components/mc/primitives";
import { cn } from "@/lib/utils";
import { FixProgressModal } from "@/components/mc/FixProgressModal";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "UAV Engine Mission Control — Digital Twin & Fault Prediction" },
      {
        name: "description",
        content:
          "Single-screen mission control for UAV engine health: live telemetry, FFT diagnostics, explainable AI alerts, 3D digital twin, self-healing and tamper-evident logging.",
      },
      {
        property: "og:title",
        content: "UAV Engine Mission Control — Digital Twin & Fault Prediction",
      },
      {
        property: "og:description",
        content:
          "Live engine telemetry, predictive fault diagnosis with explanations, 3D twin hotspots, self-healing actions and safe-landing planning.",
      },
    ],
  }),
  component: MissionControl,
});

function TwinPanel() {
  const { focusHotspot, displayed, rul, sourceKind } = useMission();
  const hotspot = focusHotspot ? HOTSPOTS[focusHotspot] : null;
  const value = hotspot
    ? (displayed?.health.subsystems[hotspot.subsystem] ?? 100)
    : null;
  const hotspotRul = hotspot ? (rul[hotspot.subsystem] ?? null) : null;

  return (
    <Panel
      title="UAV digital twin"
      subtitle="LIVE SENSOR FUSION & FLIGHT TELEMETRY"
      right={
        <Chip tone="info">
          {sourceKind === "simulated"
            ? "DATALINK: SIMULATED"
            : "DATALINK: LIVE"}
        </Chip>
      }
      className="h-[26rem] shrink-0"
      bodyClassName="min-h-0 flex-1 p-0 relative overflow-hidden"
    >
      <div className="absolute inset-0">
        <UavTwin />
      </div>
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-wrap items-end justify-between gap-2">
        {hotspot && value !== null ? (
          <div className="panel-surface pointer-events-auto max-w-[19rem] p-2">
            <p className="label-xs">{hotspot.subsystem} subsystem</p>
            <p className="text-sm font-semibold">{hotspot.label}</p>
            <p
              className={cn(
                "font-mono text-lg leading-none",
                toneText[healthTone(value)],
              )}
            >
              {value}
              <span className="text-xs text-muted-foreground">/100</span>
            </p>
            <p className="label-xs mt-1">
              RUL{" "}
              {hotspotRul === null ? "stable" : `${hotspotRul.toFixed(0)} min`}
            </p>
          </div>
        ) : displayed?.sample ? (
          <div className="panel-surface pointer-events-auto p-2 flex gap-6">
            <div>
              <p className="label-xs text-muted-foreground">COORDINATES</p>
              <p className="font-mono text-[0.8rem] leading-tight">
                {Math.abs(displayed.sample.gps.lat).toFixed(4)}°{" "}
                {displayed.sample.gps.lat >= 0 ? "N" : "S"}
                <br />
                {Math.abs(displayed.sample.gps.lon).toFixed(4)}°{" "}
                {displayed.sample.gps.lon >= 0 ? "E" : "W"}
              </p>
            </div>
            <div>
              <p className="label-xs text-muted-foreground">GPS</p>
              <p className="font-mono text-[0.8rem] text-ok">
                {displayed.sample.gpsSats} SATS
              </p>
            </div>
            <div>
              <p className="label-xs text-muted-foreground">PHASE</p>
              <p className="font-mono text-[0.8rem] uppercase">
                {displayed.sample.profile.replace("_", " ")}
              </p>
            </div>
          </div>
        ) : null}

        {displayed?.sample && (
          <WeatherWidget
            lat={displayed.sample.gps.lat}
            lon={displayed.sample.gps.lon}
          />
        )}
      </div>
    </Panel>
  );
}

function FooterReplayBar() {
  const { frames, cursor, setCursor } = useMission();

  return (
    <footer className="flex items-center gap-2 px-1 pb-1">
      <span className="label-xs shrink-0">Replay</span>
      <input
        type="range"
        min={0}
        max={Math.max(0, frames.length - 1)}
        value={cursor ?? Math.max(0, frames.length - 1)}
        onChange={(e) => setCursor(Number(e.target.value))}
        className="h-1 flex-1 accent-primary"
      />
      <button
        onClick={() => setCursor(null)}
        className={cn(
          "rounded-sm border px-2 py-1 font-mono text-[0.65rem] uppercase transition-colors",
          cursor === null
            ? "border-ok/50 bg-ok/10 text-ok"
            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50",
        )}
      >
        {cursor === null ? "live" : "go live"}
      </button>
    </footer>
  );
}

function MissionDashboard() {
  const { missionId } = useMission();
  return (
    <main className="flex h-screen flex-col gap-2 overflow-hidden p-2">
      <TopBar />
      <MasterAlarmBanner />
      <PostFlightReview />
      <FixProgressModal />

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,23rem)]">
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5 [&>section]:shrink-0">
          <ParamGrid />
          <PhysicsPanel />
          <TrendChart />
          <SpectrumPanel />
          <RedundancyPanel />
        </div>

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5 [&_section]:shrink-0">
          <TwinPanel />
          <div className="grid shrink-0 gap-2 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <SafeLanding key={missionId} />
              <ThreatAssessment />
            </div>
            <BlackBoxPanel key={missionId} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
          <AlertFeed className="flex-1 min-h-0" key={missionId} />
        </div>
      </div>

      <ScenarioControls />

      <FooterReplayBar />
    </main>
  );
}

function MissionControl() {
  return (
    <MissionProvider>
      <MissionDashboard />
    </MissionProvider>
  );
}
