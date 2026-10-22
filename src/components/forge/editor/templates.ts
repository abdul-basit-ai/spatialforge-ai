import type { ForgePart, ForgeScenario, Mate } from "@/lib/forge/types";

// Starting points for the editor when a scenario id does not exist yet (and a small fixture for route tests).
const now = () => new Date().toISOString();
const down = (tol = 0.004, sym = 360): Mate => ({ type: "axial", axis: [0, -1, 0], positionTolerance: tol, angleToleranceDeg: 12, symmetryDeg: sym });
const part = (id: string, name: string, category: ForgePart["category"], shape: string, params: Record<string, number>, position: [number, number, number], mate: Mate, color?: string): ForgePart =>
  ({ id, name, category, geometry: { kind: "primitive", shape: shape as never, params }, color, assembled: { position, quaternion: [0, 0, 0, 1] }, mate });

export function blankScenario(id: string, title = "Untitled assembly"): ForgeScenario {
  return {
    id, version: 1, status: "draft", title, summary: "", domain: "mechanical",
    source: { kind: "generated", approximation: true, notes: "Authored in Forge Studio." },
    baseParts: ["base"],
    parts: [part("base", "Base plate", "structural", "plate", { width: 0.12, height: 0.006, depth: 0.08 }, [0, 0, 0], { type: "fixed", positionTolerance: 0.002, angleToleranceDeg: 5 }, "#56606e")],
    steps: [], createdAt: now(), updatedAt: now(),
  };
}

// NEMA 17 leadscrew drive: a compact mechatronic fixture with every step kind.
export function demoScenario(id: string): ForgeScenario {
  return {
    id, version: 1, status: "draft", title: "NEMA 17 leadscrew drive", domain: "mechatronic",
    summary: "Mount a NEMA 17 stepper on its plate, couple it to an 8 mm leadscrew, then fit and wire the home sensor.",
    source: { kind: "generated", approximation: true, prompt: "train me to assemble a stepper leadscrew drive", notes: "Template geometry: primitive approximations of a typical 3D-printer Z axis." },
    baseParts: ["plate"],
    parts: [
      part("plate", "Motor plate", "structural", "plate", { width: 0.12, height: 0.006, depth: 0.08 }, [0, 0, 0], { type: "fixed", positionTolerance: 0.002, angleToleranceDeg: 5 }, "#56606e"),
      part("motor", "NEMA 17 stepper", "motor", "box", { width: 0.042, height: 0.04, depth: 0.042 }, [0, 0.023, 0], down(0.004, 90), "#2b313b"),
      part("screw-a", "M3 screw A", "fastener", "screw", { radius: 0.0015, length: 0.012 }, [0.0155, 0.049, 0.0155], down(0.003, 0), "#c9ced6"),
      part("screw-b", "M3 screw B", "fastener", "screw", { radius: 0.0015, length: 0.012 }, [-0.0155, 0.049, -0.0155], down(0.003, 0), "#c9ced6"),
      part("coupling", "5-8 mm flexible coupling", "drive", "coupling", { radius: 0.0095, length: 0.025 }, [0, 0.0555, 0], down(0.003, 0), "#d4a24c"),
      part("leadscrew", "T8 leadscrew", "drive", "leadscrew", { radius: 0.004, length: 0.15 }, [0, 0.143, 0], down(0.003, 0), "#b8c4d0"),
      part("sensor", "Home sensor", "sensor", "box", { width: 0.012, height: 0.01, depth: 0.02 }, [0.045, 0.008, 0], down(0.004, 180), "#2f9e8f"),
      part("cable", "Sensor cable", "cable", "box", { width: 0.004, height: 0.003, depth: 0.05 }, [0.045, 0.0045, 0.035], { type: "planar", axis: [0, -1, 0], positionTolerance: 0.006, angleToleranceDeg: 20, symmetryDeg: 180 }, "#111827"),
    ],
    steps: [
      { id: "s1", kind: "place", title: "Seat the stepper", instruction: "Lower the NEMA 17 onto the plate with the connector facing the sensor side. The pilot boss drops into the plate bore.", voiceLine: "Seat the stepper on the plate, connector toward the sensor.", partIds: ["motor"], requires: [], hints: ["The 22 mm pilot boss only fits one way into the bore."], commonMistakes: ["Connector facing away from the sensor."] },
      { id: "s2", kind: "place", title: "Start the mounting screws", instruction: "Thread both M3 screws by hand through the plate into the motor face.", voiceLine: "Start both M3 screws by hand.", partIds: ["screw-a", "screw-b"], requires: ["s1"] },
      { id: "s3", kind: "fasten", title: "Torque the screws", instruction: "Tighten both screws in a cross pattern to 1.2 N·m.", voiceLine: "Torque the screws to one point two newton metres, cross pattern.", partIds: ["screw-a", "screw-b"], requires: ["s2"], tool: "2.5 mm hex key", torqueNm: 1.2, pattern: "cross pattern, two passes", warnings: ["Overtightening strips the motor threads."] },
      { id: "s4", kind: "place", title: "Fit the coupling", instruction: "Slide the 5 mm bore of the coupling over the motor shaft, set screw on the shaft flat.", voiceLine: "Slide the coupling onto the motor shaft.", partIds: ["coupling"], requires: ["s3"] },
      { id: "s5", kind: "place", title: "Insert the leadscrew", instruction: "Insert the T8 leadscrew into the 8 mm side of the coupling.", voiceLine: "Insert the leadscrew into the coupling.", partIds: ["leadscrew"], requires: ["s4"] },
      { id: "s6", kind: "adjust", title: "Set the coupling gap", instruction: "Leave a gap between the shafts inside the coupling, then tighten the set screws.", voiceLine: "Set a one millimetre gap between the shafts.", partIds: ["coupling"], requires: ["s5"], target: { label: "Shaft gap", value: 1, unit: "mm", tolerance: 0.3 }, tool: "1.5 mm hex key" },
      { id: "s7", kind: "place", title: "Mount the home sensor", instruction: "Clip the home sensor onto the plate next to the motor.", voiceLine: "Clip the home sensor onto the plate.", partIds: ["sensor"], requires: ["s1"] },
      { id: "s8", kind: "route", title: "Route the sensor cable", instruction: "Plug the cable into the sensor and route it along the plate edge.", voiceLine: "Plug in and route the sensor cable along the edge.", partIds: ["cable"], requires: ["s7"], warnings: ["Keep the cable clear of the rotating coupling."] },
      { id: "s9", kind: "inspect", title: "Final inspection", instruction: "Check the drive before handing it over.", voiceLine: "Run the final inspection checklist.", partIds: [], requires: ["s6", "s8"], checklist: ["Leadscrew spins freely by hand", "Both screws torqued", "Cable clear of the coupling"] },
    ],
    createdAt: now(), updatedAt: now(),
  };
}
