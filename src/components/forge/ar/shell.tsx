"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ForgeScenario } from "@/lib/forge/types";
import { setVoiceEnabled, stopSpeaking, voiceEnabled } from "@/lib/forge/voice-client";
import styles from "./ar.module.css";
import { useRearCamera, type CameraState } from "./camera";
import { ARStage, type StageEvents, type StageMode, type StageStatus } from "./stage";

export { styles };
export const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

// Owns the ARStage instance, the rear-camera fallback stream and WebXR entry for one AR mode.
export function useArStage(scenario: ForgeScenario, mode: StageMode, events: StageEvents) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef(events); eventsRef.current = events;
  const [stage, setStage] = useState<ARStage | null>(null);
  const [status, setStatus] = useState<StageStatus>({ xr: false, placed: false, surface: false, snapId: null, dragging: null, selectedId: null });
  const [xrSupported, setXrSupported] = useState(false);
  const [xrError, setXrError] = useState<string | null>(null);
  const camera = useRearCamera(!status.xr);

  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    const instance = new ARStage(host, scenario, mode, {
      onSelect: (id) => eventsRef.current.onSelect?.(id),
      onDrop: (id, pose) => eventsRef.current.onDrop?.(id, pose) ?? null,
      onStatus: (next) => { setStatus(next); eventsRef.current.onStatus?.(next); },
      onXrEnd: () => eventsRef.current.onXrEnd?.(),
    });
    instance.placeFallback(); setStage(instance);
    return () => { instance.dispose(); setStage(null); };
  }, [scenario, mode]);

  useEffect(() => { void ARStage.arSupported().then(setXrSupported); }, []);

  // Keep the screen-locked view framed inside the region the overlay panels leave free.
  useEffect(() => {
    const root = rootRef.current; if (!root || !stage) return;
    const find = (cls: string) => root.querySelector(`.${cls}`);
    let last: Record<"top" | "right" | "bottom" | "left", number> | null = null;
    const measure = (immediate = false) => {
      const box = root.getBoundingClientRect(), rect = (cls: string) => find(cls)?.getBoundingClientRect() ?? null;
      const top = rect(styles.top), rail = rect(styles.rail), sheet = rect(styles.sheet);
      const insets = { top: top ? top.bottom - box.top : 0, right: 0, bottom: 0, left: 0 };
      if (sheet) { if (sheet.width > box.width * 0.6) insets.bottom = box.bottom - sheet.top; else insets.right = box.right - sheet.left; }
      if (rail) insets.right = Math.max(insets.right, box.right - rail.left);
      // Ignore small panel changes (a feedback line appearing) so the view does not shift under the user's finger.
      const prev = last;
      if (!immediate && prev && (Object.keys(insets) as Array<keyof typeof insets>).every((k) => Math.abs(insets[k] - prev[k]) < 72)) return;
      last = insets; stage.setSafeArea(insets, immediate);
    };
    measure(true);
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    for (const cls of [styles.top, styles.rail, styles.sheet]) { const el = find(cls); if (el) observer.observe(el); }
    return () => observer.disconnect();
  }, [stage]);

  // Taps on overlay controls must not also fire an XR "select" (which would place or grab parts).
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    const guard = (e: Event) => { if ((e.target as Element | null)?.closest?.("[data-xr-ui]")) e.preventDefault(); };
    root.addEventListener("beforexrselect", guard);
    return () => root.removeEventListener("beforexrselect", guard);
  }, []);

  useEffect(() => () => stopSpeaking(), []);

  const enterXR = useCallback(async () => {
    if (!stage || !rootRef.current) return;
    setXrError(null); camera.stop();
    try { if (!(await stage.startXR(rootRef.current))) setXrError("WebXR is not available on this device."); }
    catch (error) { setXrError(error instanceof Error ? error.message : "Could not start AR."); }
  }, [stage, camera]);

  return { hostRef, rootRef, stage, status, xrSupported, xrError, camera, enterXR, exitXR: () => stage?.endXR() };
}

function modeBadge(xr: boolean, camera: CameraState) {
  if (xr) return { text: "WebXR surface AR", warn: false };
  if (camera === "live") return { text: "Screen-locked AR · camera", warn: false };
  if (camera === "starting" || camera === "idle") return { text: "Starting camera", warn: false };
  if (camera === "denied") return { text: "Camera blocked · virtual table", warn: true };
  return { text: "No camera · virtual table", warn: true };
}

type FrameProps = {
  shell: ReturnType<typeof useArStage>;
  title: string; kicker: string; progress: { done: number; total: number };
  onExit: () => void; rail?: ReactNode; center?: ReactNode; sheet: ReactNode;
};

// Full-screen AR layout: camera/grid backdrop, the 3D stage, top bar, side rail and bottom sheet (safe-area aware).
export function ARFrame({ shell, title, kicker, progress, onExit, rail, center, sheet }: FrameProps) {
  const { hostRef, rootRef, status, camera, xrSupported, xrError, enterXR, exitXR } = shell;
  const [voice, setVoice] = useState(true);
  useEffect(() => { setVoice(voiceEnabled()); }, []);
  const badge = modeBadge(status.xr, camera.state);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div ref={rootRef} className={cx(styles.root, status.xr && styles.xr)}>
      <div className={styles.grid} />
      <video ref={camera.videoRef} className={cx(styles.video, camera.state !== "live" && styles.hidden)} playsInline muted autoPlay />
      <div ref={hostRef} className={styles.stage} />
      <div className={styles.vignette} />
      <div className={styles.ui}>
        <div className={styles.top} data-xr-ui>
          <button type="button" className={styles.back} onClick={() => { exitXR(); onExit(); }} aria-label="Back to 3D">← 3D</button>
          <div className={styles.title}><small>{kicker}</small><strong>{title}</strong></div>
          <button type="button" className={cx(styles.back, voice && styles.on)} onClick={() => { const next = !voice; setVoice(next); setVoiceEnabled(next); }} aria-pressed={voice}>Voice {voice ? "on" : "off"}</button>
          <div className={styles.topRow}>
            <span className={cx(styles.badge, badge.warn && styles.warn)}><i className={styles.dot} />{badge.text}</span>
            <span className={styles.progress}>{progress.done}/{progress.total}<span className={styles.bar}><i style={{ width: `${pct}%` }} /></span></span>
            {xrSupported && !status.xr && <button type="button" className={styles.enter} onClick={() => void enterXR()}>Enter surface AR</button>}
            {status.xr && <button type="button" className={styles.enter} onClick={exitXR}>Exit AR</button>}
          </div>
        </div>
        {xrError && <div className={cx(styles.feedback, styles.warn)} data-xr-ui style={{ alignSelf: "center" }}>{xrError} Using the camera view instead.</div>}
        <div className={styles.middle}>{rail && <div className={styles.rail} data-xr-ui>{rail}</div>}</div>
        <div className={styles.sheet} data-xr-ui>{sheet}</div>
      </div>
      {center && <div className={styles.center}>{center}</div>}
    </div>
  );
}

export function FeedbackLine({ feedback }: { feedback: { tone: "ok" | "bad" | "info" | "warn"; text: string; at: number } | null }) {
  if (!feedback) return null;
  const icon = feedback.tone === "ok" ? "✓" : feedback.tone === "bad" ? "✕" : feedback.tone === "warn" ? "!" : "i";
  return <div key={feedback.at} className={cx(styles.feedback, styles[feedback.tone])} role="status" aria-live="polite"><b>{icon}</b><span>{feedback.text}</span></div>;
}
