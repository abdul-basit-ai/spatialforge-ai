export type PinchCalibration = { openDistance: number; pinchDistance: number; closeThreshold: number; releaseThreshold: number };

export function calibratePinch(openDistance: number, pinchDistance: number): PinchCalibration {
  const open = Math.max(openDistance, pinchDistance + 0.001);
  const pinch = Math.min(pinchDistance, open - 0.001);
  const span = open - pinch;
  return { openDistance: open, pinchDistance: pinch, closeThreshold: pinch + span * 0.35, releaseThreshold: pinch + span * 0.65 };
}

export class PinchHysteresis {
  private state = false;
  private goodFrames = 0;
  constructor(private calibration: PinchCalibration, private frames = 3) {}
  update(distance: number, confidence: number) {
    if (confidence < 0.65 || !Number.isFinite(distance)) { this.goodFrames = 0; return this.state; }
    const wantsClosed = this.state ? distance < this.calibration.releaseThreshold : distance <= this.calibration.closeThreshold;
    if (wantsClosed) this.goodFrames += 1; else this.goodFrames = 0;
    if (this.goodFrames >= this.frames) { this.state = !this.state; this.goodFrames = 0; }
    return this.state;
  }
  reset() { this.state = false; this.goodFrames = 0; }
  get active() { return this.state; }
}

export type InteractionState = "idle" | "hover" | "holding" | "tracking-lost" | "releasing";

export function safeTrackingState(previous: InteractionState, visible: boolean, confidence: number): InteractionState {
  if (!visible || confidence < 0.45) return previous === "holding" ? "tracking-lost" : "idle";
  return previous === "tracking-lost" ? "hover" : previous;
}
