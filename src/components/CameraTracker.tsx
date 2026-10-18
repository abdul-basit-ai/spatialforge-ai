"use client";

import { useEffect, useRef } from "react";
import type { Point } from "@/lib/assembly";

export type HandFrame = {
  point: Point | null;
  pinched: boolean;
  visible: boolean;
  tracking: "visible" | "recovering" | "lost";
  pinchStrength: number;
  rotationStep: -90 | 0 | 90;
  openPalm: boolean;
  palmAngle: number;
};

type Props = {
  onFrame: (frame: HandFrame) => void;
  onStatus: (status: string) => void;
};

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export function CameraTracker({ onFrame, onStatus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(onFrame);
  const statusRef = useRef(onStatus);
  frameRef.current = onFrame;
  statusRef.current = onStatus;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let landmarker: { detectForVideo: (video: HTMLVideoElement, timestamp: number) => { landmarks: Array<Array<{ x: number; y: number }>> }; close: () => void } | null = null;
    let raf = 0;
    let stopped = false;
    let lastSample = 0;
    let lastVideoTime = -1;
    let pinched = false;
    let pinchFrames = 0;
    let releaseFrames = 0;
    let gripRatio = 0.44;
    let missingFrames = 0;
    let smooth: Point | null = null;
    let pinchStrength = 0;
    let rotationAnchor: number | null = null;
    let lastRotationAt = 0;
    let rotationStep: HandFrame["rotationStep"] = 0;
    let palmAngle = 0;

    const emit = (point: Point | null, visible: boolean, tracking: HandFrame["tracking"]) => {
      const emittedRotation = rotationStep;
      rotationStep = 0;
      frameRef.current({ point, pinched, visible, tracking, pinchStrength, rotationStep: emittedRotation, openPalm: false, palmAngle });
    };

    const draw = (landmarks: Array<{ x: number; y: number }> | null, point: Point | null) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(rect.width * dpr);
      const pixelHeight = Math.round(rect.height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (landmarks) {
        const map = (landmark: { x: number; y: number }) => videoPointToStage(landmark, video, rect.width, rect.height);
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = "rgba(137,255,216,.83)";
        ctx.shadowColor = "#59ffd0";
        ctx.shadowBlur = 9;
        for (const [a, b] of BONES) {
          const start = map(landmarks[a]);
          const end = map(landmarks[b]);
          ctx.beginPath();
          ctx.moveTo(start.x * rect.width, start.y * rect.height);
          ctx.lineTo(end.x * rect.width, end.y * rect.height);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        for (const index of [0, 4, 8, 12, 16, 20]) {
          const joint = map(landmarks[index]);
          ctx.beginPath();
          ctx.fillStyle = index === 4 || index === 8 ? "#dfff86" : "#b8ffec";
          ctx.arc(joint.x * rect.width, joint.y * rect.height, index === 4 || index === 8 ? 5 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (point) {
        ctx.beginPath();
        ctx.strokeStyle = pinched ? "#dfff86" : "#a4ffe3";
        ctx.lineWidth = 3;
        ctx.arc(point.x * rect.width, point.y * rect.height, pinched ? 18 : 24, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    const start = async () => {
      try {
        if (!window.isSecureContext) throw new Error("Open this page through HTTPS to use the camera.");
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable in this browser.");
        statusRef.current("Opening rear camera…");
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        const video = videoRef.current;
        if (!video || stopped) return;
        video.srcObject = stream;
        await video.play();
        statusRef.current("Camera ready. Loading hand tracking…");
        const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
        const resolver = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm");
        const options = {
          baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" },
          runningMode: "VIDEO" as const,
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        };
        try {
          landmarker = await HandLandmarker.createFromOptions(resolver, { ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } });
        } catch {
          landmarker = await HandLandmarker.createFromOptions(resolver, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } });
        }
        if (stopped) { landmarker.close(); return; }
        statusRef.current("Show one hand to the camera");
        const loop = (time: number) => {
          if (stopped) return;
          raf = requestAnimationFrame(loop);
          if (!videoRef.current || !landmarker || time - lastSample < 30 || videoRef.current.currentTime === lastVideoTime) return;
          lastSample = time;
          lastVideoTime = videoRef.current.currentTime;
          const result = landmarker.detectForVideo(videoRef.current, time);
          const hand = result.landmarks?.[0];
          if (!hand) {
            missingFrames++;
            if (missingFrames <= 10 && smooth) {
              emit(smooth, false, "recovering");
              draw(null, smooth);
            } else if (missingFrames === 11) {
              pinched = false;
              pinchFrames = 0;
              releaseFrames = 0;
              gripRatio = 0.44;
              pinchStrength = 0;
              rotationAnchor = null;
              emit(smooth, false, "lost");
              draw(null, null);
            }
            return;
          }
          missingFrames = 0;
          const rect = videoRef.current.getBoundingClientRect();
          const midpoint = { x: (hand[4].x + hand[8].x) / 2, y: (hand[4].y + hand[8].y) / 2 };
          const mapped = videoPointToStage(midpoint, videoRef.current, rect.width, rect.height);
          if (smooth) {
            const movement = Math.hypot(mapped.x - smooth.x, mapped.y - smooth.y);
            const alpha = movement > 0.055 ? 0.72 : movement > 0.022 ? 0.54 : 0.34;
            smooth = { x: smooth.x + (mapped.x - smooth.x) * alpha, y: smooth.y + (mapped.y - smooth.y) * alpha };
          } else smooth = mapped;
          const palmSize = Math.max(
            (Math.hypot(hand[0].x - hand[9].x, hand[0].y - hand[9].y) + Math.hypot(hand[5].x - hand[17].x, hand[5].y - hand[17].y)) / 2,
            0.001,
          );
          const pinchDistance = Math.hypot(hand[4].x - hand[8].x, hand[4].y - hand[8].y);
          const pinchRatio = pinchDistance / palmSize;
          const palmAngle = Math.atan2(hand[17].y - hand[5].y, hand[17].x - hand[5].x);
          const openPalm = [8, 12, 16, 20].every((index) => Math.hypot(hand[index].x - hand[0].x, hand[index].y - hand[0].y) > palmSize * 1.25);
          const wasPinched = pinched;
          pinchStrength = Math.max(0, Math.min(1, (0.68 - pinchRatio) / 0.34));
          if (!pinched) {
            pinchFrames = pinchRatio < 0.43 ? pinchFrames + 1 : 0;
            releaseFrames = 0;
            if (pinchFrames >= 2) {
              pinched = true;
              gripRatio = pinchRatio;
              pinchFrames = 0;
            }
          } else {
            gripRatio = Math.min(gripRatio, pinchRatio);
            const releaseRatio = Math.max(0.5, Math.min(0.58, gripRatio + 0.2));
            const fingersClearlyOpen = pinchRatio > releaseRatio || pinchDistance > 0.075;
            releaseFrames = fingersClearlyOpen ? releaseFrames + 1 : 0;
            if (releaseFrames >= 2) {
              pinched = false;
              releaseFrames = 0;
              gripRatio = 0.44;
            }
          }
          if (!wasPinched && pinched) rotationAnchor = palmAngle;
          if (!pinched) rotationAnchor = null;
          else if (rotationAnchor !== null && time - lastRotationAt > 320) {
            const turn = normalizedAngleDelta(palmAngle, rotationAnchor);
            if (Math.abs(turn) >= Math.PI / 5.6) {
              rotationStep = turn > 0 ? 90 : -90;
              rotationAnchor = palmAngle;
              lastRotationAt = time;
            }
          }
          const emittedRotation = rotationStep;
          rotationStep = 0;
          frameRef.current({ point: smooth, pinched, visible: true, tracking: "visible", pinchStrength, rotationStep: emittedRotation, openPalm, palmAngle });
          draw(hand, smooth);
        };
        raf = requestAnimationFrame(loop);
      } catch (error) {
        statusRef.current(error instanceof Error ? error.message : "Camera tracking failed. Use touch controls.");
        pinched = false;
        pinchStrength = 0;
        rotationAnchor = null;
        emit(null, false, "lost");
      }
    };
    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      landmarker?.close();
      stream?.getTracks().forEach((track) => track.stop());
      pinched = false;
      pinchStrength = 0;
      rotationAnchor = null;
      emit(null, false, "lost");
    };
  }, []);

  return <>
    <video ref={videoRef} className="ar-video" playsInline muted autoPlay aria-hidden="true" />
    <canvas ref={canvasRef} className="hand-overlay" aria-hidden="true" />
  </>;
}

function normalizedAngleDelta(current: number, anchor: number): number {
  let delta = current - anchor;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function videoPointToStage(point: Point, video: HTMLVideoElement, width: number, height: number): Point {
  const videoWidth = video.videoWidth || width;
  const videoHeight = video.videoHeight || height;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const shownWidth = videoWidth * scale;
  const shownHeight = videoHeight * scale;
  const offsetX = (width - shownWidth) / 2;
  const offsetY = (height - shownHeight) / 2;
  return {
    x: Math.max(0, Math.min(1, (point.x * shownWidth + offsetX) / width)),
    y: Math.max(0, Math.min(1, (point.y * shownHeight + offsetY) / height)),
  };
}
