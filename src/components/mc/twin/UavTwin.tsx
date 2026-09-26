import { useCallback, useEffect, useRef, useState } from "react";
import { useMission } from "@/lib/twin/store";
import { HOTSPOTS } from "@/lib/twin/profiles";
import { healthTone } from "../primitives";

const MODEL_UID = "67703aedf76945ce872fc576be6a4321";

const ANNOTATIONS = [
  { id: 2, position: [-2.02, 0.11, -0.46], eye: [-2.72, 3.86, -5.92] },
  { id: 5, position: [0.66, 0.04, -0.09], eye: [-0.64, 4.25, -6.07] },
  { id: 4, position: [1.38, -0.17, -0.13], eye: [0.93, 2.92, -6.64] },
  { id: 6, position: [0.93, 0.17, -0.16], eye: [0.85, 4.41, -5.92] },
  { id: 7, position: [-0.3, -0.37, 0.19], eye: [-1.43, -0.58, 7.2] },
  { id: 8, position: [-1.22, -0.37, 0.11], eye: [-1.86, -0.99, 7.15] },
  { id: 10, position: [2.58, 0.13, 0.2], eye: [2.51, 3.99, 6.13] },
];

const TONE_HEX: Record<string, string> = {
  nominal: "#10b981",
  warning: "#f59e0b",
  critical: "#ef4444",
};

declare global {
  interface Window {
    Sketchfab: any;
  }
}

export function UavTwin() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const apiRef = useRef<any>(null);

  const { displayed, focusHotspot, setFocusHotspot } = useMission();
  const [ready, setReady] = useState(false);
  const idxToId = useRef<Record<number, string>>({});

  const health = displayed?.health;
  const stateRef = useRef(displayed);

  useEffect(() => {
    stateRef.current = displayed;
  }, [displayed]);

  const initViewer = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !window.Sketchfab) return;

    if (apiRef.current) return;

    const client = new window.Sketchfab(iframe);
    client.init(MODEL_UID, {
      success: (api: any) => {
        apiRef.current = api;
        api.start();
        api.addEventListener("viewerready", () => {
          api.setAnnotationCameraTransition(false);
          api.showAnnotationTooltips(false);
          api.setFov(65);

          api.pause();
          api.seekTo(0);
          setReady(true);
        });
      },
      error: () => {
        console.error("Viewer error");
        setReady(true);
      },
      ui_animations: 0,
      animation_autoplay: 0,
      ui_controls: 1,
      ui_loading: 0,
      ui_infos: 0,
      ui_watermark: 0,
      ui_annotations: 1,
      autostart: 1,
      preload: 1,
      camera: 0,
      transparent: 0, // Leaves Sketchfab background transparent so our CSS gradient shows
    });
  }, [setFocusHotspot]);

  useEffect(() => {
    const failsafe = setTimeout(() => setReady(true), 60000);

    if (document.getElementById("sf-sdk")) {
      if (window.Sketchfab && !apiRef.current) initViewer();
      return () => clearTimeout(failsafe);
    }
    const s = document.createElement("script");
    s.id = "sf-sdk";
    s.src = "https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js";
    s.onload = () => initViewer();
    document.head.appendChild(s);

    return () => clearTimeout(failsafe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let timer: number;
    let trackTimer: number;

    const tick = () => {
      timer = requestAnimationFrame(tick);

      const state = stateRef.current;
      const vib = state?.trustedVibration ?? 0;
      const rpm = state?.sample.params.rpm ?? 0;
      const t = performance.now() / 1000;

      const bank = state?.sample.physics?.roll_deg ?? Math.sin(t * 0.5) * 1.5;
      const pitch = state?.sample.physics?.pitch_deg ?? Math.cos(t * 0.3) * 0.5;

      const shakeAmt = Math.max(0, vib - 20) * 0.08;
      const shakeX = (Math.random() - 0.5) * shakeAmt;
      const shakeY = (Math.random() - 0.5) * shakeAmt;

      if (wrapperRef.current) {
        wrapperRef.current.style.transform = `translate(${shakeX}px, ${shakeY}px) rotateZ(${bank}deg) rotateX(${pitch}deg)`;
      }
    };

    // Update native Sketchfab annotations based on REDUX state
    trackTimer = window.setInterval(() => {
      const api = apiRef.current;
      const state = stateRef.current;
      if (!api || !state || !state.health) return;

      ANNOTATIONS.forEach(({ id }) => {
        // Find which subsystem this matches (heuristic mapping for native IDs)
        let subsystemKey = "engine";
        let title = "Component";
        if (id === 2) {
          subsystemKey = "vibration";
          title = "Propeller & Hub";
        }
        if (id === 5) {
          subsystemKey = "propulsion";
          title = "Electric Motor";
        }
        if (id === 4) {
          subsystemKey = "engine";
          title = "Hot Section / Exhaust";
        }
        if (id === 6) {
          subsystemKey = "lubrication";
          title = "Oil Pump & Gallery";
        }
        if (id === 7) {
          subsystemKey = "fuel";
          title = "Fuel Pump & Lines";
        }
        if (id === 8) {
          subsystemKey = "electrical";
          title = "Generator & Bus";
        }
        if (id === 10) {
          subsystemKey = "nav";
          title = "Nav / GNSS Bay";
        }

        const val = state.health.subsystems[subsystemKey] ?? 100;
        const tone = healthTone(val).toUpperCase();

        api.updateAnnotation(id, {
          title: title,
          content: `Health: ${val.toFixed(0)}% [${tone}]`,
        });
      });
    }, 500);

    timer = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(timer);
      clearInterval(trackTimer);
    };
  }, []);

  return (
    <div
      className="absolute inset-0 overflow-hidden flex flex-col bg-[#020813]"
      style={{ perspective: "1000px" }}
    >
      <div
        ref={wrapperRef}
        className="absolute top-[-17.5%] left-[-17.5%] w-[135%] h-[135%] origin-center z-10"
      >
        <iframe
          ref={iframeRef}
          title="UAV Digital Twin"
          allow="autoplay; fullscreen; xr-spatial-tracking"
          className="w-full h-full border-0 outline-none"
        />
      </div>

      <div
        className="absolute inset-0 flex flex-col items-center justify-center z-50 bg-[#030712] transition-opacity duration-1000 pointer-events-none"
        style={{
          opacity: ready ? 0 : 1,
        }}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent shadow-[0_0_15px_rgba(16,185,129,0.5)]" />
          <div className="text-center">
            <h3 className="text-sm font-bold tracking-widest text-emerald-500 mb-1">
              VAYUTWIN ENGINE
            </h3>
            <p className="text-xs text-emerald-500/50 animate-pulse">
              Establishing secure link to 3D asset...
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
