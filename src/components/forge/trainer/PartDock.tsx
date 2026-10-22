"use client";

import { useEffect, useRef, useState } from "react";
import { CameraTracker, type HandFrame } from "@/components/CameraTracker";
import { useForgeRun } from "@/lib/forge/run-store";
import type { ForgeScenario } from "@/lib/forge/types";

// Pump-style guided placement over the 3D stage: a dock of parts not yet installed and a drop zone over the assembly.
// Tap a part card, then tap "Seat it here"; or with hand tracking, pinch on a card, move to the assembly, open the fingers.
// The part is offered at its assembled pose; engine.attemptPlace (via the run store) decides if it is the right part now.
type Props = { scenario: ForgeScenario; selectedPartId: string | null; onSelect: (partId: string | null) => void };

export default function PartDock({ scenario, selectedPartId, onSelect }: Props) {
  const run = useForgeRun((state) => state.run);
  const [hands, setHands] = useState(false);
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<{ x: number; y: number; pinched: boolean } | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const heldRef = useRef<string | null>(null);
  const wasPinched = useRef(false);
  const open = scenario.parts.filter((part) => !scenario.baseParts.includes(part.id) && !run?.installed.includes(part.id));

  const seat = (partId: string | null) => {
    if (!partId) return;
    const part = scenario.parts.find((item) => item.id === partId);
    if (part) useForgeRun.getState().place(part.id, part.assembled);
    onSelect(null);
  };

  // Hand frames: point is normalised (0..1) over the camera view, mapped onto this overlay.
  const onFrame = (frame: HandFrame) => {
    const el = root.current;
    if (!el || !frame.point || !frame.visible) { setCursor(null); return; }
    const rect = el.getBoundingClientRect();
    const x = frame.point.x * rect.width, y = frame.point.y * rect.height;
    setCursor({ x, y, pinched: frame.pinched });
    const target = document.elementFromPoint(rect.left + x, rect.top + y)?.closest<HTMLElement>("[data-dock-part], [data-dock-drop]");
    if (frame.pinched && !wasPinched.current) {
      const partId = target?.dataset.dockPart ?? null;
      if (partId) { heldRef.current = partId; setHeld(partId); onSelect(partId); }
    }
    if (!frame.pinched && wasPinched.current && heldRef.current) {
      if (target?.dataset.dockDrop !== undefined) seat(heldRef.current);
      heldRef.current = null; setHeld(null);
    }
    wasPinched.current = frame.pinched;
  };

  useEffect(() => { if (!hands) { setCursor(null); heldRef.current = null; setHeld(null); } }, [hands]);

  const selected = scenario.parts.find((part) => part.id === (held ?? selectedPartId));
  return (
    <div ref={root} className="forge-dock-layer">
      <button type="button" data-dock-drop className={`forge-dock-drop${selected ? " is-armed" : ""}`} onClick={() => seat(selectedPartId)} disabled={!selected}>
        {selected ? <>Seat the <b>{selected.name}</b> here</> : "Pick a part below, then seat it on the assembly"}
      </button>
      <div className="forge-dock">
        {open.map((part) => (
          <button key={part.id} type="button" data-dock-part={part.id} className={`forge-dock-card${part.id === (held ?? selectedPartId) ? " is-selected" : ""}`} onClick={() => onSelect(part.id === selectedPartId ? null : part.id)}>
            <i style={{ background: part.color ?? "#9fb3c8" }} />
            <span>{part.name.replace(/_/g, " ")}</span>
          </button>
        ))}
        {!open.length && <span className="forge-note">Every part is seated. Finish the remaining steps in the panel.</span>}
      </div>
      <div className="forge-dock-hands">
        <button type="button" className={`forge-toggle${hands ? " is-on" : ""}`} onClick={() => setHands(!hands)} aria-pressed={hands}><i aria-hidden />Hand gestures {hands ? "on" : "off"}</button>
        {hands && <span className="forge-note">{status || "Pinch a part card, move over the assembly, open your fingers."}</span>}
      </div>
      {hands && <div className="forge-dock-camera"><CameraTracker onFrame={onFrame} onStatus={setStatus} /></div>}
      {cursor && <div className={`forge-dock-cursor${cursor.pinched ? " is-pinched" : ""}`} style={{ left: cursor.x, top: cursor.y }} />}
    </div>
  );
}
