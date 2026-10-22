import type { ForgePart, ForgeStep, Mate, PartCategory, PrimitiveShape, Quat, Vec3 } from "../types";

// Small builders for the hand-authored built-in scenarios. Units are metres and degrees, Y-up.

export const BUILTIN_DATE = "2026-10-01T00:00:00.000Z";

export function rot(axis: Vec3, deg: number): Quat {
  const l = Math.hypot(...axis) || 1, h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [round((axis[0] / l) * s), round((axis[1] / l) * s), round((axis[2] / l) * s), round(Math.cos(h))];
}
export const mulq = (a: Quat, b: Quat): Quat => {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz].map(round) as Quat;
};
const round = (v: number) => Math.round(v * 1e6) / 1e6;

export const IDENTITY: Quat = [0, 0, 0, 1];
export const Y_TO_X = rot([0, 0, 1], -90); // primitive's long (Y) axis laid along +X
export const FLAT = rot([1, 0, 0], 90); // torus/washer (XY plane) laid flat on the XZ plane

export const DOWN: Vec3 = [0, -1, 0];
export const FROM_RIGHT: Vec3 = [-1, 0, 0];
export const FROM_LEFT: Vec3 = [1, 0, 0];

export const mate = (type: Mate["type"], axis: Vec3 | undefined, positionTolerance: number, angleToleranceDeg: number, symmetryDeg?: number): Mate =>
  ({ type, ...(axis ? { axis } : {}), positionTolerance, angleToleranceDeg, ...(symmetryDeg !== undefined ? { symmetryDeg } : {}) });

export function part(id: string, name: string, category: PartCategory, shape: PrimitiveShape, params: Record<string, number>, color: string, position: Vec3, quaternion: Quat, partMate: Mate, description?: string): ForgePart {
  return { id, name, category, geometry: { kind: "primitive", shape, params }, color, assembled: { position: position.map(round) as Vec3, quaternion }, mate: partMate, ...(description ? { description } : {}) };
}

export const step = (s: Omit<ForgeStep, "partIds" | "requires"> & Partial<Pick<ForgeStep, "partIds" | "requires">>): ForgeStep => ({ partIds: [], requires: [], ...s });
