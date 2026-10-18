"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { CameraTracker, type HandFrame } from "@/components/CameraTracker";
import { ThreeWorkbench } from "@/components/ThreeWorkbench";
import { MarkerlessAR } from "@/components/MarkerlessAR";
import { getScenario, normalizeRotation, partFor, SCENARIO_IDS, sceneLayout, slotAt, sourceAt, type PartId, type PlacementMethod, type Point, type ScenarioId } from "@/lib/assembly";
import { useAssemblyStore } from "@/lib/store";
import { detectCapabilities, makeSessionId, makeSpatialEvent, validatePlacement } from "@/lib/spatial-engine";
import { queueSpatialEvent } from "@/lib/telemetry";

type Mode = "workbench" | "camera";
type Phase = "searching" | "ready" | "holding" | "over-target" | "wrong-target" | "blocked";

export default function Home() {
  const { operator, scenario, placements, errors, passport, hydrate, setOperator, setScenario, markComplete, unplace, recordError, reset } = useAssemblyStore();
  const definition = getScenario(scenario);
  const ids = definition.parts.map((part) => part.id);
  const completed = useMemo(() => new Set(placements.map((item) => item.partId)), [placements]);
  const [mode, setMode] = useState<Mode>("workbench");
  const [started, setStarted] = useState(false);
  const [cameraStatus, setCameraStatus] = useState("Camera off");
  const [message, setMessage] = useState("Choose a scenario, then pick any visible part.");
  const [phase, setPhase] = useState<Phase>("searching");
  const [selectedId, setSelectedId] = useState<PartId | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [handPoint, setHandPoint] = useState<Point | null>(null);
  const [trackingVisible, setTrackingVisible] = useState(false);
  const [trackingState, setTrackingState] = useState<HandFrame["tracking"]>("lost");
  const [pinchActive, setPinchActive] = useState(false);
  const [parkedWarningSlot, setParkedWarningSlot] = useState<PartId | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceTick, setVoiceTick] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const [allowRework, setAllowRework] = useState(true);
  const [inspection, setInspection] = useState(false);
  const [viewRotation, setViewRotation] = useState({ x: 0, y: 0 });
  const [capabilityNote, setCapabilityNote] = useState("Detecting browser capabilities…");
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const [layout, setLayout] = useState(() => sceneLayout(390, 640, scenario));
  const stageRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<PartId | null>(null);
  const dragPointRef = useRef<Point | null>(null);
  const rotationsRef = useRef<Record<string, number>>({});
  const completedRef = useRef(completed);
  const pinchedRef = useRef(false);
  const draggingRef = useRef(false);
  const touchDraggingRef = useRef(false);
  const touchStartRef = useRef<Point | null>(null);
  const warnedTargetRef = useRef<PartId | null>(null);
  const lastUiUpdateRef = useRef(0);
  const lastPickupWarningRef = useRef(0);
  const lockedTargetRef = useRef<{ id: PartId; seenAt: number; enteredAt: number } | null>(null);
  const trackingLostReportedRef = useRef(false);
  const palmAngleRef = useRef<number | null>(null);
  const sessionRef = useRef(makeSessionId());
  const eventSequenceRef = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  completedRef.current = completed;
  selectedRef.current = selectedId;
  rotationsRef.current = rotations;

  const selectedPart = partFor(scenario, selectedId);
  const progress = Math.round((placements.length / definition.parts.length) * 100);
  const stageWidth = stageRef.current?.clientWidth || 390;
  const stageHeight = stageRef.current?.clientHeight || 640;
  const displayLayout = layout.normalizedSlots[ids[0]] ? layout : sceneLayout(stageWidth, stageHeight, scenario);
  const hoverTarget = handPoint ? slotAt(handPoint, displayLayout.normalizedSlots, stageWidth, stageHeight, selectedPart ? [selectedPart.target] : ids, mode === "camera" ? 1.22 : 1) : null;
  const hoverSource = handPoint && !selectedId && (mode !== "camera" || trackingState === "visible") ? sourceAt(handPoint, displayLayout.normalizedSources, allowRework ? new Set<PartId>() : completed, stageWidth, stageHeight, ids, 1.18) : null;
  const selectedMissingPrerequisite = selectedPart?.prerequisites.find((requirement) => !completed.has(requirement));
  const selectedRotationReady = selectedPart ? normalizeRotation(rotations[selectedPart.id] || 0) === normalizeRotation(selectedPart.requiredRotation) : false;
  const ready = Boolean(selectedPart && draggingRef.current && hoverTarget === selectedPart.target && !selectedMissingPrerequisite && selectedRotationReady);
  const warningSlot = parkedWarningSlot ?? (selectedPart && draggingRef.current && hoverTarget && hoverTarget !== selectedPart.target ? hoverTarget : null);

  useEffect(() => { hydrate(); }, [hydrate]);
  useEffect(() => {
    detectCapabilities().then((report) => setCapabilityNote(report.immersiveAr ? "WebXR surface AR ready" : report.camera ? "Camera overlay ready · surface AR falls back here" : "3D workbench ready"));
  }, []);
  const track = (type: string, payload: Record<string, unknown>, source?: "mouse" | "touch" | "gesture" | "xr-controller" | "xr-hand") => {
    queueSpatialEvent(makeSpatialEvent({ sessionId: sessionRef.current, sequence: ++eventSequenceRef.current, type, at: new Date().toISOString(), mode: modeRef.current === "camera" ? "camera" : "workbench", source, scenario, payload }));
  };
  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setLayout(sceneLayout(host.clientWidth, host.clientHeight, scenario)));
    observer.observe(host);
    setLayout(sceneLayout(host.clientWidth, host.clientHeight, scenario));
    return () => observer.disconnect();
  }, [scenario]);
  useEffect(() => { setSelectedId(null); dragPointRef.current = null; lockedTargetRef.current = null; rotationsRef.current = {}; setDragPoint(null); setParkedWarningSlot(null); setRotations({}); setPhase("ready"); const first = definition.parts[0]; setMessage(scenario === "tray" ? `${definition.name}: choose any available part. ${definition.description}` : `${definition.name}: begin with ${first.short}. ${first.cue}.`); }, [scenario, definition.name, definition.description, definition.parts]);
  useEffect(() => { if (scenario === "pneumatic" && completed.size === ids.length) setInspection(true); else if (scenario !== "pneumatic") setInspection(false); }, [scenario, completed.size, ids.length]);
  useEffect(() => {
    if (!started || !voiceEnabled || !message || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1.04;
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [message, voiceEnabled, started, voiceTick]);

  const setDragPosition = (point: Point | null) => { dragPointRef.current = point; setDragPoint(point); };
  const clearSelection = () => { selectedRef.current = null; dragPointRef.current = null; draggingRef.current = false; touchDraggingRef.current = false; warnedTargetRef.current = null; lockedTargetRef.current = null; setParkedWarningSlot(null); setSelectedId(null); setDragPoint(null); setPhase("ready"); };
  const parkSelection = (point: Point | null, nextPhase: Phase, warning: PartId | null = null) => {
    draggingRef.current = false;
    touchDraggingRef.current = false;
    lockedTargetRef.current = null;
    if (point) setDragPosition(point);
    setParkedWarningSlot(warning);
    setPhase(nextPhase);
  };
  const choosePart = (id: PartId, drag = false, point: Point | null = null) => {
    const wasPlaced = completedRef.current.has(id);
    if (wasPlaced && !allowRework) {
      setMessage(`${partFor(scenario, id)?.short} is already placed. Turn on Rework parts to move it again.`);
      return;
    }
    const required = scenario === "tray" ? null : definition.parts.find((part) => !completedRef.current.has(part.id));
    if (!wasPlaced && required && id !== required.id) {
      setMessage(`Not ${partFor(scenario, id)?.short} yet. Select ${required.short} next. ${required.cue}.`);
      setVoiceTick((value) => value + 1);
      track("out_of_sequence_pick", { attemptedPartId: id, requiredPartId: required.id }, drag ? "gesture" : "touch");
      if (navigator.vibrate) navigator.vibrate([35, 45, 35]);
      return;
    }
    if (wasPlaced) {
      unplace(id);
      setInspection(false);
      setMessage(`${partFor(scenario, id)?.short} removed from ${partFor(scenario, id)?.target}. Move it and release it to place it again.`);
    }
    const part = partFor(scenario, id)!;
    selectedRef.current = id; draggingRef.current = drag; warnedTargetRef.current = null; lockedTargetRef.current = null; setParkedWarningSlot(null); setSelectedId(id); setDragPosition(drag ? point : null); setPhase(drag ? "holding" : "ready");
    if (!wasPlaced) setMessage(`${part.short} selected. Target ${part.target}. ${drag ? "Move it there and release your pinch." : "Tap its target or drag it from the dock."}`);
    track("pickup_started", { partId: id }, drag ? "gesture" : "touch");
  };
  const rotatePart = (id: PartId, delta: number, gesture = false) => {
    const part = partFor(scenario, id);
    if (!part) return;
    const rotation = normalizeRotation((rotationsRef.current[id] || 0) + delta);
    const next = { ...rotationsRef.current, [id]: rotation };
    rotationsRef.current = next;
    setRotations(next);
    setMessage(`${gesture ? "Wrist turn detected. " : ""}${part.short} rotated to ${rotation}°. ${rotation === normalizeRotation(part.requiredRotation) ? "Orientation ready." : `Required orientation is ${part.requiredRotation}°.`}`);
    if (gesture && navigator.vibrate) navigator.vibrate([20, 35, 20]);
  };
  const attemptPlacement = (id: PartId, target: PartId | null, method: PlacementMethod, releasePoint: Point | null = dragPointRef.current) => {
    const part = partFor(scenario, id);
    if (!part) return;
    const rotation = normalizeRotation(rotationsRef.current[id] || 0);
    const validation = validatePlacement({ scenario, installed: completedRef.current, rotations: rotationsRef.current }, id, target, rotation);
    track(validation.accepted ? "placement_accepted" : "placement_rejected", { target, rotation, reason: validation.reason, method }, method === "gesture" ? "gesture" : method === "touch" ? "touch" : "mouse");
    if (validation.accepted) {
      clearSelection(); markComplete(id, rotation, method);
      if (navigator.vibrate) navigator.vibrate(60);
      const next = definition.parts.find((candidate) => candidate.id !== id && !completedRef.current.has(candidate.id));
      setMessage(next ? `${part.short} installed correctly. Select ${next.short} next. ${next.cue}.` : `${definition.name} complete. Your demo passport is ready below.`);
      setVoiceTick((value) => value + 1);
      return;
    }
    if (target !== part.target) {
      parkSelection(releasePoint, target ? "wrong-target" : "ready", target);
      if (target) { recordError(id, "wrong-target", target); setMessage(`Wrong target. ${part.short} stays here so you can correct it. Pinch it and move it to ${part.target}.`); }
      else setMessage(`${part.short} is still selected. Pinch it where it is and release over ${part.target}.`);
      setVoiceTick((value) => value + 1); return;
    }
    const missing = part.prerequisites.find((requirement) => !completedRef.current.has(requirement));
    if (missing) {
      parkSelection(releasePoint, "blocked"); recordError(id, "prerequisite", target || undefined, missing);
      setMessage(`Complete ${partFor(scenario, missing)?.short} before placing ${part.short}. The part remains selected.`); setVoiceTick((value) => value + 1); return;
    }
    if (rotation !== normalizeRotation(part.requiredRotation)) {
      parkSelection(releasePoint, "blocked"); recordError(id, "orientation", target); setMessage(`${part.short} is facing the wrong way. Rotate it to ${part.requiredRotation}° and release it over ${part.target} again.`); setVoiceTick((value) => value + 1); return;
    }
  };
  const warnTarget = (id: PartId, target: PartId | null) => {
    const part = partFor(scenario, id);
    if (!part) return;
    setParkedWarningSlot(null);
    if (target === part.target) {
      const now = performance.now();
      const previousLock = lockedTargetRef.current?.id === target ? lockedTargetRef.current : null;
      if (!previousLock && navigator.vibrate) navigator.vibrate(18);
      lockedTargetRef.current = { id: target, seenAt: now, enteredAt: previousLock?.enteredAt ?? now };
      const missing = part.prerequisites.find((requirement) => !completedRef.current.has(requirement));
      const rotation = normalizeRotation(rotationsRef.current[id] || 0);
      if (missing || rotation !== normalizeRotation(part.requiredRotation)) {
        setParkedWarningSlot(target); setPhase("blocked");
        if (warnedTargetRef.current === target) return;
        warnedTargetRef.current = target;
        setMessage(missing ? `Placement blocked. Complete ${partFor(scenario, missing)?.short} before ${part.short}.` : `Placement blocked. Rotate ${part.short} to ${part.requiredRotation}° first.`);
        setVoiceTick((value) => value + 1); return;
      }
      warnedTargetRef.current = null; setPhase("over-target"); return;
    }
    if (!target) { warnedTargetRef.current = null; setPhase("holding"); return; }
    lockedTargetRef.current = null;
    setPhase("wrong-target");
    if (warnedTargetRef.current === target) return;
    warnedTargetRef.current = target;
    setMessage(`${target} is the wrong target for ${part.short}. Move it to ${part.target}.`); setVoiceTick((value) => value + 1);
  };

  const handleHandFrame = (frame: HandFrame) => {
    const now = performance.now();
    if (frame.visible !== trackingVisible) setTrackingVisible(frame.visible);
    if (frame.tracking !== trackingState) setTrackingState(frame.tracking);
    if (frame.pinched !== pinchActive) setPinchActive(frame.pinched);
    if (scenario === "pneumatic" && inspection && frame.openPalm && frame.tracking === "visible" && !frame.pinched) {
      if (palmAngleRef.current !== null) { let delta = frame.palmAngle - palmAngleRef.current; if (delta > Math.PI) delta -= Math.PI * 2; if (delta < -Math.PI) delta += Math.PI * 2; if (Math.abs(delta) > 0.008) setViewRotation((value) => { const y = Math.max(-180, Math.min(180, value.y + delta * 180 / Math.PI)); setRotations((current) => ({ ...current, __viewY: y })); return { ...value, y }; }); }
      palmAngleRef.current = frame.palmAngle;
    } else if (!frame.openPalm) palmAngleRef.current = null;
    if (now - lastUiUpdateRef.current > 34 || frame.pinched !== pinchedRef.current) { setHandPoint(frame.point); lastUiUpdateRef.current = now; }
    if (modeRef.current !== "camera" || !started || completedRef.current.size === ids.length) { pinchedRef.current = frame.pinched; return; }
    if (frame.tracking === "recovering") return;
    if (frame.tracking === "lost") {
      pinchedRef.current = false;
      setPinchActive(false);
      if (draggingRef.current && selectedRef.current) {
        const id = selectedRef.current;
        const locked = lockedTargetRef.current;
        if (locked && now - locked.seenAt < 700 && now - locked.enteredAt >= 180) {
          attemptPlacement(id, locked.id, "gesture", dragPointRef.current);
          trackingLostReportedRef.current = false;
          return;
        }
        parkSelection(dragPointRef.current, "searching");
        if (!trackingLostReportedRef.current) recordError(id, "tracking-lost");
        trackingLostReportedRef.current = true;
        setMessage(`${partFor(scenario, id)?.short} is held in place. Show your hand and pinch it to continue.`);
      }
      return;
    }
    trackingLostReportedRef.current = false;
    if (frame.rotationStep && draggingRef.current && selectedRef.current) {
      const part = partFor(scenario, selectedRef.current);
      const rotation = normalizeRotation(rotationsRef.current[selectedRef.current] || 0);
      if (part && rotation !== normalizeRotation(part.requiredRotation)) rotatePart(selectedRef.current, frame.rotationStep, true);
    }
    const began = frame.pinched && !pinchedRef.current; const ended = !frame.pinched && pinchedRef.current; pinchedRef.current = frame.pinched;
    if (began && frame.point && !draggingRef.current) {
      const width = stageRef.current?.clientWidth || 390; const height = stageRef.current?.clientHeight || 640;
      const parked = dragPointRef.current;
      const parkedDistance = parked ? Math.hypot((frame.point.x - parked.x) * width, (frame.point.y - parked.y) * height) : Infinity;
      if (selectedRef.current && parked && parkedDistance < Math.min(96, Math.max(68, width * 0.2))) {
        draggingRef.current = true; lockedTargetRef.current = null; setParkedWarningSlot(null); setDragPosition(frame.point); setPhase("holding");
        setMessage(`${partFor(scenario, selectedRef.current)?.short} grabbed again. Move to its highlighted target and open your fingers.`);
        return;
      }
      const targetPart = slotAt(frame.point, displayLayout.normalizedSlots, width, height, ids, 1.22);
      if (allowRework && targetPart && completedRef.current.has(targetPart)) { choosePart(targetPart, true, frame.point); return; }
      const picked = sourceAt(frame.point, displayLayout.normalizedSources, allowRework ? new Set<PartId>() : completedRef.current, width, height, ids, 1.16);
      if (picked) choosePart(picked, true, frame.point); else if (now - lastPickupWarningRef.current > 1400) { setMessage(scenario === "pneumatic" ? "Pinch directly on a valve component in the parts library." : "Pinch directly on an available shape in the dock to pick it up."); lastPickupWarningRef.current = now; }
      return;
    }
    if (!draggingRef.current || !selectedRef.current) { if (!selectedRef.current) setPhase("ready"); return; }
    const id = selectedRef.current;
    if (!frame.point) { parkSelection(dragPointRef.current, "searching"); setMessage("Tracking paused. The part is held in place until you pinch it again."); return; }
    setDragPosition(frame.point);
    const width = stageRef.current?.clientWidth || 390; const height = stageRef.current?.clientHeight || 640;
    const target = slotAt(frame.point, displayLayout.normalizedSlots, width, height, [id], ended ? 1.32 : 1.22);
    if (ended) {
      const locked = lockedTargetRef.current;
      const releaseTarget = target ?? (locked && now - locked.seenAt < 600 ? locked.id : null);
      attemptPlacement(id, releaseTarget, "gesture", frame.point);
    } else warnTarget(id, target);
  };
  const pointFromPointer = (event: PointerEvent<HTMLDivElement>): Point => { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!started || (event.target as HTMLElement).closest("button")) return;
    const point = pointFromPointer(event);
    const parked = dragPointRef.current;
    const parkedDistance = parked ? Math.hypot((point.x - parked.x) * stageWidth, (point.y - parked.y) * stageHeight) : Infinity;
    if (mode === "workbench" && selectedRef.current && parked && parkedDistance < Math.min(96, Math.max(68, stageWidth * 0.2))) {
      event.currentTarget.setPointerCapture(event.pointerId); touchDraggingRef.current = true; draggingRef.current = true; touchStartRef.current = point; lockedTargetRef.current = null; setParkedWarningSlot(null); setHandPoint(point); setDragPosition(point); setPhase("holding"); return;
    }
    const targetPart = slotAt(point, displayLayout.normalizedSlots, stageWidth, stageHeight, ids, 1.14);
    if (allowRework && targetPart && completedRef.current.has(targetPart)) { event.currentTarget.setPointerCapture(event.pointerId); touchDraggingRef.current = true; touchStartRef.current = point; setHandPoint(point); choosePart(targetPart, mode === "workbench", point); return; }
    const source = sourceAt(point, displayLayout.normalizedSources, allowRework ? new Set<PartId>() : completedRef.current, stageWidth, stageHeight, ids, 1.08);
    if (source) { if (mode === "workbench") { event.currentTarget.setPointerCapture(event.pointerId); touchDraggingRef.current = true; touchStartRef.current = point; setHandPoint(point); } choosePart(source, mode === "workbench", point); return; }
    const target = slotAt(point, displayLayout.normalizedSlots, stageWidth, stageHeight, ids, 1.12); if (target && selectedRef.current) attemptPlacement(selectedRef.current, target, "touch", point); else if (target) setMessage(`Select ${partFor(scenario, target)?.short} before placing it in ${target}.`);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => { if (!touchDraggingRef.current || !selectedRef.current) return; const point = pointFromPointer(event); setDragPosition(point); setHandPoint(point); warnTarget(selectedRef.current, slotAt(point, displayLayout.normalizedSlots, stageWidth, stageHeight, [selectedRef.current], 1.12)); };
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!touchDraggingRef.current || !selectedRef.current) return;
    const point = pointFromPointer(event); const start = touchStartRef.current; touchStartRef.current = null;
    if (start && Math.hypot((point.x - start.x) * stageWidth, (point.y - start.y) * stageHeight) < 18) { touchDraggingRef.current = false; draggingRef.current = false; setDragPosition(start); setHandPoint(null); setPhase("ready"); setMessage(`${partFor(scenario, selectedRef.current)?.short} selected. Tap its target ${partFor(scenario, selectedRef.current)?.target}.`); return; }
    setHandPoint(null); attemptPlacement(selectedRef.current, slotAt(point, displayLayout.normalizedSlots, stageWidth, stageHeight, [selectedRef.current], 1.18), "touch", point);
  };
  const beginSession = async (nextMode: "workbench" | "camera") => {
    sessionRef.current = makeSessionId();
    eventSequenceRef.current = 0;
    const capabilities = await detectCapabilities();
    fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sessionRef.current, operator, scenario, mode: nextMode, capabilities }) }).catch(() => undefined);
    track("session_started", { capabilities }, nextMode === "camera" ? "gesture" : "mouse");
  };
  const startCamera = () => { clearSelection(); pinchedRef.current = false; trackingLostReportedRef.current = false; setTrackingState("lost"); setPinchActive(false); setMode("camera"); setStarted(true); setImmersive(true); const next = definition.parts.find((part) => !completedRef.current.has(part.id)); setMessage(scenario === "tray" ? "Pinch any available shape in the dock, move it to its matching target, then open your fingers." : next ? `Select ${next.short} first. ${next.cue}. Pinch it in the parts library and follow the insertion arrow.` : `${definition.name} is complete.`); void beginSession("camera"); };
  const startWorkbench = () => { clearSelection(); pinchedRef.current = false; setMode("workbench"); setStarted(true); setImmersive(false); const next = definition.parts.find((part) => !completedRef.current.has(part.id)); setMessage(scenario === "tray" ? "Drag any available shape to its target." : next ? `Select ${next.short} first. ${next.cue}.` : `${definition.name} is complete.`); void beginSession("workbench"); };
  const rotateSelected = (delta: number) => { if (selectedRef.current) rotatePart(selectedRef.current, delta); };
  const readInstruction = async () => { try { const response = await fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message }) }); if (response.ok && response.headers.get("content-type")?.includes("audio/mpeg")) { const url = URL.createObjectURL(await response.blob()); const audio = new Audio(url); audio.onended = () => URL.revokeObjectURL(url); await audio.play(); return; } } catch { /* Browser speech fallback. */ } if ("speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(message)); } };

  const stageHint = !started ? "Choose a scenario and start a workbench" : completed.size === ids.length ? "Assembly complete. Passport ready." : mode === "camera" && trackingState === "recovering" ? "Hold steady — recovering hand tracking" : mode === "camera" && trackingState === "lost" && selectedPart ? "Part held safely — show your hand and pinch it again" : phase === "blocked" ? selectedMissingPrerequisite ? `Place ${partFor(scenario, selectedMissingPrerequisite)?.short} first` : selectedPart && !selectedRotationReady ? `Keep pinching and twist your wrist to ${selectedPart.requiredRotation}°` : "Correction required — the part remains selected" : phase === "wrong-target" ? "Wrong target — pinch the parked part to correct it" : phase === "over-target" ? "Target locked — open your fingers to place" : phase === "holding" ? selectedPart && !selectedRotationReady ? `Twist your wrist clockwise for +90° or counterclockwise for −90°` : `Move ${selectedPart?.short || "the part"} to ${selectedPart?.target || "its target"}` : selectedPart ? `Selected ${selectedPart.short} — pinch it to continue toward ${selectedPart.target}` : hoverSource ? `Pinch to grab ${partFor(scenario, hoverSource)?.short}` : mode === "camera" && !trackingVisible ? "Show one hand, then pinch a dock shape" : "Choose any available part";
  return <div className="app-shell">
    <header className="topbar"><Link href="/" className="brand"><span className="brand-mark">◇</span><span>SPATIAL<span className="brand-accent">FORGE</span></span><span className="brand-ai">AI</span></Link><div className="top-actions"><span className="top-version">ASSEMBLY LAB / V1.1</span><label className="operator-pill">OPERATOR <select aria-label="Operator identity" value={operator} onChange={(event) => { clearSelection(); setOperator(event.target.value); }}>{Array.from({ length: 10 }, (_, digit) => <option key={digit} value={digit}>{digit}</option>)}</select></label><Link className="admin-link" href="/admin">Admin</Link></div></header>
    <main className="main">
      <section className="intro"><div><div className="eyebrow"><span className="eyebrow-line" /> SPATIAL ASSEMBLY TRAINING</div><h1>Build with your hands.<br/><span>Know every part is in place.</span></h1><p className="lede">{definition.description} Every part stays accessible; the co-pilot explains wrong targets, prerequisites, and orientation corrections.</p></div><div className="intro-stat"><strong>{String(placements.length).padStart(2, "0")}<span>/{String(ids.length).padStart(2, "0")}</span></strong><small>PARTS PLACED</small><div className="intro-progress"><i style={{ width: `${progress}%` }} /></div></div></section>
      <section className="scenario-tabs" aria-label="Assembly scenario">{SCENARIO_IDS.map((id) => <button type="button" key={id} className={scenario === id ? "selected" : ""} onClick={() => { clearSelection(); setScenario(id); setStarted(false); setImmersive(false); }}>{getScenario(id).name}<small>{id === "tray" ? "Practice / free order" : "Prerequisites / orientation"}</small></button>)}</section>
      <section className="workspace" aria-label="Assembly workspace"><div className={`stage-column ${immersive ? "is-immersive" : ""}`}><div className="mode-bar"><div className="mode-tabs"><button type="button" className={mode === "workbench" && started ? "selected" : ""} onClick={startWorkbench}>3D workbench</button><button type="button" className={mode === "camera" ? "selected" : ""} onClick={startCamera}>Camera AR</button></div><span className="mode-note">{mode === "camera" ? cameraStatus : capabilityNote}</span><button type="button" className={`rework-toggle ${allowRework ? "is-on" : ""}`} aria-pressed={allowRework} onClick={() => { setAllowRework((value) => !value); clearSelection(); }}>{allowRework ? "Rework parts: ON" : "Rework parts: OFF"}</button><MarkerlessAR onStatus={setCameraStatus} />{mode === "camera" && <button type="button" className="immersive-toggle" onClick={() => setImmersive((value) => !value)}>{immersive ? "Exit view" : "Expand view"}</button>}</div>
        <div ref={stageRef} className={`stage ${mode === "camera" ? "is-camera" : ""}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>{mode === "camera" && <CameraTracker onFrame={handleHandFrame} onStatus={setCameraStatus} />}<div className="stage-backdrop" /><ThreeWorkbench scenario={scenario} current={selectedId} completed={placements.map((item) => item.partId)} dragged={dragPoint} ready={ready} warningSlot={warningSlot} rotations={rotations} /><div className="stage-topline"><span className="live-label"><i />{mode === "camera" ? "LIVE CAMERA" : "DIGITAL TWIN"}</span><span className="stage-step">{completed.size} / {ids.length} PLACED · {scenario === "valve" ? "SEQUENCE" : "ANY ORDER"}</span></div>{mode === "camera" && <div className="stage-part-card"><span>{selectedPart ? "IN YOUR HAND" : "PICK ANY PART"}</span><strong>{selectedPart?.short || "Choose a shape"}</strong><small>{selectedPart ? `Target ${selectedPart.target} · ${selectedPart.cue}` : "Pinch a shape in the dock"}</small></div>}{ids.map((id) => { const point = displayLayout.normalizedSlots[id]; const part = partFor(scenario, id)!; return <div key={id} className={`slot-caption ${selectedPart?.target === id ? "is-active" : ""} ${completed.has(id) ? "is-complete" : ""} ${warningSlot === id ? "is-wrong" : ""} ${phase === "over-target" && selectedPart?.target === id ? "is-ready" : ""}`} style={{ left: `${point.x * 100}%`, top: `${(point.y + 0.084) * 100}%` }}>{completed.has(id) ? "✓" : id}<span>{part.short}</span></div>; })}<div className="parts-label">PICK FROM DOCK <span>{scenario === "valve" ? "ALL PARTS VISIBLE" : "ANY ORDER"}</span></div>{definition.parts.map((part) => { const point = displayLayout.normalizedSources[part.id]; return <div key={part.id} className={`source-caption ${selectedId === part.id ? "is-selected" : ""} ${hoverSource === part.id ? "is-hovered" : ""} ${completed.has(part.id) ? "is-complete" : ""}`} style={{ left: `${point.x * 100}%`, top: `${(point.y - 0.064) * 100}%` }}>{completed.has(part.id) ? "✓" : part.short}</div>; })}{handPoint && mode === "camera" && trackingState !== "lost" && <div className={`tracking-cursor ${pinchActive ? "is-pinched" : ""} ${trackingState === "recovering" ? "is-recovering" : ""} ${phase === "over-target" ? "is-ready" : ""} ${phase === "wrong-target" ? "is-wrong" : ""}`} style={{ left: `${handPoint.x * 100}%`, top: `${handPoint.y * 100}%` }} />}{mode === "camera" && started && <button type="button" className={`stage-voice ${voiceEnabled ? "is-on" : ""}`} onClick={() => setVoiceEnabled((value) => !value)}>{voiceEnabled ? "Voice on" : "Voice off"}</button>}{mode === "camera" && selectedPart && <div className="stage-rotate"><button type="button" onClick={() => rotateSelected(-90)}>↶ −90°</button><button type="button" onClick={() => rotateSelected(90)}>↷ +90°</button></div>}<div className={`stage-hint ${phase === "over-target" ? "is-ready" : ""} ${phase === "wrong-target" || phase === "blocked" ? "is-wrong" : ""}`}><span className="hint-icon">{phase === "over-target" ? "✓" : phase === "wrong-target" || phase === "blocked" ? "!" : "✦"}</span><span>{stageHint}</span>{phase === "over-target" && <i className="dwell-line" />}</div></div><div className="stage-footer"><span><i className={`footer-dot ${mode === "camera" && trackingState === "visible" ? "online" : ""}`} />{mode === "camera" ? trackingState === "recovering" ? "Recovering tracking" : trackingState === "lost" ? cameraStatus : pinchActive ? "Pinch held" : "Hand visible" : "Workbench ready"}</span><span>Camera frames stay on your device</span></div></div>
        <aside className="control-panel"><div className="panel-heading"><span className="eyebrow">{selectedPart ? "PICKED PART" : scenario === "valve" ? "VALVE ASSEMBLY" : "FREE CHOICE"}</span><span className="part-counter">{placements.length} / {ids.length} PLACED</span></div>{selectedPart ? <div className="active-part"><div className={`part-symbol symbol-${selectedPart.id.toLowerCase()}`} /><div><span className="part-slot">TARGET {selectedPart.target} · ROTATION {normalizeRotation(rotations[selectedPart.id] || 0)}°</span><h2>{selectedPart.name}</h2><p>{selectedPart.cue}</p><div className="rotate-actions"><button type="button" onClick={() => rotateSelected(-90)}>↶ Rotate −90°</button><button type="button" onClick={() => rotateSelected(90)}>↷ Rotate +90°</button></div></div></div> : <div className="active-part"><span className="choose-icon">✦</span><div><span className="part-slot">{scenario === "valve" ? "ALL PARTS ACCESSIBLE" : "NO ORDER REQUIRED"}</span><h2>Choose any part</h2><p>{scenario === "valve" ? "Prerequisites block placement, not pickup." : "Complete the tray in any order."}</p></div></div>}<div className="coach-card"><div className="coach-title"><span className="coach-orb">✦</span> CO-PILOT <span className="coach-state">{phase === "wrong-target" || phase === "blocked" ? "CORRECTION" : phase === "over-target" ? "RELEASE TO PLACE" : "READY"}</span></div><p aria-live="polite">{message}</p><div className="coach-actions"><button type="button" onClick={readInstruction}>▶ Hear guidance</button><button type="button" onClick={() => setVoiceEnabled((value) => !value)}>{voiceEnabled ? "Auto voice on" : "Auto voice off"}</button></div></div><div className="sequence-heading"><h3>{scenario === "valve" ? "Valve sequence" : "Parts and destinations"}</h3><span>{progress}% COMPLETE</span></div><div className="sequence-list">{definition.parts.map((part) => <button type="button" className={`sequence-item ${selectedId === part.id ? "is-current" : ""} ${completed.has(part.id) ? "is-done" : ""}`} key={part.id} disabled={!started || (completed.has(part.id) && !allowRework)} onClick={() => choosePart(part.id)}><span className="sequence-number">{completed.has(part.id) ? "↻" : part.id}</span><span><strong>{part.short}</strong><small>{part.target} · {part.prerequisites.length ? `After ${part.prerequisites.map((id) => partFor(scenario, id)?.short).join(", ")}` : part.cue}</small></span><span className="sequence-state">{completed.has(part.id) ? allowRework ? "REMOVE" : "PLACED" : selectedId === part.id ? "PICKED" : "AVAILABLE"}</span></button>)}</div><div className="panel-actions"><span className="panel-tip">{allowRework ? "Rework is enabled: select a placed part to remove and place it again." : "Rework is disabled: placed parts are locked for this run."}</span><button className="reset-button" type="button" onClick={() => { reset(); clearSelection(); setAllowRework(true); setStarted(false); setImmersive(false); setMessage("Run reset. Choose any part to begin."); }}>Reset run</button></div></aside></section>
      <section className="bottom-grid"><div className="information-card"><div className="card-kicker">HOW TO INTERACT</div><h3>{scenario === "valve" ? "Pick freely. Build safely." : "Pick freely. Match precisely."}</h3><p>{scenario === "valve" ? "Every valve part stays visible and pickable. Place it only after its prerequisite parts are complete, with the correct rotation selected." : "Choose any shape from the dock and place it in its matching target. There is no required order."}</p><div className="mini-steps"><span>01 <b>Pick</b></span><span className="mini-arrow">→</span><span>02 <b>Orient</b></span><span className="mini-arrow">→</span><span>03 <b>Release</b></span></div></div><div className="information-card record-card"><div className="card-kicker">RUN RECORD</div><h3>{passport ? "Passport created" : "Evidence in progress"}</h3><p>{passport ? `The ${definition.name.toLowerCase()} passport includes placements, rotations, and correction events.` : `${placements.length} placements and ${errors.length} correction events in this run.`}</p>{passport ? <code className="hash">SHA-256 · {passport}</code> : <div className="record-placeholder">{ids.map((id) => <span key={id} className={completed.has(id) ? "filled" : ""} />)}</div>}</div></section>
    </main>
  </div>;
}
