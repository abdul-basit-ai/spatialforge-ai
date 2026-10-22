"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Camera helpers for AR: rear-camera pass-through, frame capture as a 768px JPEG, and photo-file fallback.
export const CAPTURE_EDGE = 768;

export function canvasToJpeg(source: CanvasImageSource, width: number, height: number, edge = CAPTURE_EDGE, quality = 0.82): string {
  const k = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * k)); canvas.height = Math.max(1, Math.round(height * k));
  const ctx = canvas.getContext("2d")!; ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

export function videoFrame(video: HTMLVideoElement | null): string | null {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  return canvasToJpeg(video, video.videoWidth, video.videoHeight);
}

export async function fileToJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    return canvasToJpeg(img, img.naturalWidth, img.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}

// One-shot snapshot when no live stream is running (e.g. right after a WebXR session ends).
export async function snapshotOnce(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
  try {
    const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play(); await new Promise((r) => setTimeout(r, 450)); // let exposure settle
    return videoFrame(video);
  } finally { stream.getTracks().forEach((t) => t.stop()); }
}

export type CameraState = "idle" | "starting" | "live" | "denied" | "unavailable";

// Rear camera stream attached to a <video>; paused while `active` is false (e.g. during a WebXR session).
export function useRearCamera(active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("idle");
  useEffect(() => {
    if (!active) return;
    if (!navigator.mediaDevices?.getUserMedia) { setState("unavailable"); return; }
    let stream: MediaStream | null = null, cancelled = false;
    setState("starting");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s; streamRef.current = s; const video = videoRef.current;
        if (video) { video.srcObject = s; await video.play().catch(() => undefined); }
        setState("live");
      })
      .catch((error: unknown) => { if (!cancelled) setState(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unavailable"); });
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); streamRef.current = null; if (videoRef.current) videoRef.current.srcObject = null; setState("idle"); };
  }, [active]);
  const capture = useCallback(() => videoFrame(videoRef.current), []);
  // Stops the stream synchronously (inside a click handler, before requesting a WebXR session that needs the camera).
  const stop = useCallback(() => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; }, []);
  return { videoRef, state, capture, stop };
}
