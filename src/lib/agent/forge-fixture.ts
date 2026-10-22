import type { ForgeScenario } from "@/lib/forge/types";

// Small planetary gearbox used by the people/memory live test (forge-live-test.ts). Valid per validateScenario.
export function fixtureScenario(id: string): ForgeScenario {
  const now = new Date().toISOString();
  const down: [number, number, number] = [0, -1, 0];
  const q: [number, number, number, number] = [0, 0, 0, 1];
  const axial = (tol = 0.004, angle = 8, symmetryDeg = 360) => ({ type: "axial" as const, axis: down, positionTolerance: tol, angleToleranceDeg: angle, symmetryDeg });
  return {
    id, version: 1, status: "published", title: "Planetary gearbox (test fixture)", summary: "Single-stage planetary reducer: ring, sun, carrier, cover and screws.", domain: "mechanical",
    source: { kind: "generated", approximation: true, notes: "people live-test fixture" }, baseParts: ["housing"],
    parts: [
      { id: "housing", name: "Gearbox housing", category: "structural", geometry: { kind: "primitive", shape: "housing", params: { radius: 0.06, length: 0.05 } }, assembled: { position: [0, 0, 0], quaternion: q }, mate: { type: "fixed", positionTolerance: 0.01, angleToleranceDeg: 10 } },
      { id: "ring-gear", name: "Ring gear", category: "drive", geometry: { kind: "primitive", shape: "gear", params: { radius: 0.05, teeth: 60, thickness: 0.012 } }, assembled: { position: [0, 0.01, 0], quaternion: q }, mate: axial(0.004, 6, 360) },
      { id: "sun-gear", name: "Sun gear", category: "drive", geometry: { kind: "primitive", shape: "gear", params: { radius: 0.012, teeth: 12, thickness: 0.012 } }, assembled: { position: [0, 0.012, 0], quaternion: q }, mate: axial(0.003, 8, 360) },
      { id: "carrier", name: "Planet carrier", category: "drive", geometry: { kind: "primitive", shape: "plate", params: { width: 0.08, height: 0.01, depth: 0.08 } }, assembled: { position: [0, 0.022, 0], quaternion: q }, mate: axial(0.004, 10, 120) },
      { id: "cover", name: "Output cover", category: "structural", geometry: { kind: "primitive", shape: "cap", params: { radius: 0.06, length: 0.01 } }, assembled: { position: [0, 0.032, 0], quaternion: q }, mate: axial(0.005, 10, 90) },
      { id: "screws", name: "M4 cap screws", category: "fastener", geometry: { kind: "primitive", shape: "screw", params: { radius: 0.002, length: 0.016 } }, assembled: { position: [0.05, 0.036, 0], quaternion: q }, mate: axial(0.003, 15, 0) },
    ],
    steps: [
      { id: "s1-ring", kind: "place", title: "Seat the ring gear", instruction: "Lower the ring gear into the housing with the locating tab in the notch.", voiceLine: "Seat the ring gear, tab into the notch.", partIds: ["ring-gear"], requires: [] },
      { id: "s2-sun", kind: "place", title: "Fit the sun gear", instruction: "Slide the sun gear onto the input shaft, keyway aligned with the key.", voiceLine: "Slide the sun gear onto the input shaft.", partIds: ["sun-gear"], requires: ["s1-ring"], hints: ["The keyway faces the flat on the shaft."] },
      { id: "s3-carrier", kind: "place", title: "Drop in the planet carrier", instruction: "Lower the carrier so the three planets mesh with the sun and ring.", voiceLine: "Lower the carrier until the planets mesh.", partIds: ["carrier"], requires: ["s2-sun"] },
      { id: "s4-cover", kind: "place", title: "Fit the output cover", instruction: "Place the cover over the carrier, dowel holes over the dowels.", voiceLine: "Place the output cover over the dowels.", partIds: ["cover"], requires: ["s3-carrier"] },
      { id: "s5-screws", kind: "place", title: "Insert the cap screws", instruction: "Insert the four M4 cap screws by hand.", voiceLine: "Insert the four cap screws by hand.", partIds: ["screws"], requires: ["s4-cover"] },
      { id: "s6-torque", kind: "fasten", title: "Torque the cover screws", instruction: "Torque the screws to 3 Nm in a cross pattern, two passes.", voiceLine: "Torque the screws to three newton metres, cross pattern.", partIds: ["screws"], requires: ["s5-screws"], tool: "torque driver", torqueNm: 3, pattern: "cross pattern, two passes" },
      { id: "s7-inspect", kind: "inspect", title: "Spin test", instruction: "Turn the input by hand: smooth, no binding, output turns slower.", voiceLine: "Turn the input by hand and check it runs smooth.", partIds: [], requires: ["s6-torque"], checklist: ["Turns smoothly", "No binding", "Output turns slower than input"] },
    ],
    createdAt: now, updatedAt: now,
  };
}
