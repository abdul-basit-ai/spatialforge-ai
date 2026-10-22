import type { ForgeScenario } from "../types";
import { BUILTIN_DATE, DOWN, FLAT, FROM_RIGHT, IDENTITY, mate, part, rot, step } from "./util";

// The legacy 8-part pneumatic control valve (src/lib/assembly.ts PNEUMATIC_PARTS) as true 3D poses and mates.
// The body stands on the bench at the origin; everything stacks along +Y and drops in from above, except the side clip.
export const pneumaticValve: ForgeScenario = {
  id: "pneumatic-valve",
  version: 1,
  status: "published",
  title: "Pneumatic Control Valve",
  summary: "Assemble an eight-part spool valve: seal, keyed spool, return spring, torqued gland nut, actuator cap, then the locking clip and the preload screw.",
  domain: "mechanical",
  source: { kind: "builtin", approximation: false, notes: "Converted from the original SpatialForge pneumatic valve pilot." },
  baseParts: ["valve-body"],
  parts: [
    part("valve-body", "Valve Body", "structural", "hex", { radius: 0.025, length: 0.06 }, "#80dfff", [0, 0.03, 0], IDENTITY, mate("fixed", DOWN, 0.01, 10), "Hex aluminium body with a 16 mm spool bore."),
    part("body-o-ring", "Body O-ring", "seal", "torus", { radius: 0.012, tube: 0.0015 }, "#c5a6ff", [0, 0.056, 0], FLAT, mate("planar", DOWN, 0.005, 12, 0), "NBR 24 x 3 mm O-ring for the upper bore groove."),
    part("valve-spool", "Valve Spool", "drive", "cylinder", { radius: 0.008, length: 0.05 }, "#5fc8ee", [0, 0.035, 0], rot([0, 1, 0], 90), mate("axial", DOWN, 0.006, 10, 360), "Hardened spool with a keyed notch that must face the front port."),
    part("return-spring", "Return Spring", "drive", "spring", { radius: 0.007, turns: 6 }, "#d8e2e5", [0, 0.066, 0], rot([1, 0, 0], -90), mate("axial", DOWN, 0.006, 12, 0), "Stainless compression spring."),
    part("gland-nut", "Gland Nut", "fastener", "hex", { radius: 0.018, length: 0.012 }, "#ffbd70", [0, 0.066, 0], IDENTITY, mate("axial", DOWN, 0.006, 12, 60), "Hex gland nut that retains the spring and spool."),
    part("actuator-cap", "Actuator Cap", "structural", "cap", { radius: 0.021, length: 0.025 }, "#c4f48e", [0, 0.0845, 0], rot([0, 1, 0], 180), mate("axial", DOWN, 0.006, 10, 360), "Cap with a green alignment mark."),
    part("locking-clip", "Locking Clip", "fastener", "box", { width: 0.03, height: 0.006, depth: 0.012 }, "#f2a5c2", [0.027, 0.09, 0], rot([0, 1, 0], 90), mate("axial", FROM_RIGHT, 0.005, 12, 360), "Spring-steel clip that locks the cap."),
    part("adjustment-screw", "Adjustment Screw", "fastener", "screw", { radius: 0.003, length: 0.02 }, "#f0c878", [0, 0.102, 0], IDENTITY, mate("axial", DOWN, 0.004, 15, 180), "Slotted M6 screw that sets spring preload."),
  ],
  steps: [
    step({ id: "seat-o-ring", kind: "place", title: "Seat the body O-ring", instruction: "Lay the O-ring flat in the upper groove of the valve body. Lubricate it lightly first.", voiceLine: "Seat the O-ring flat in the body groove.", partIds: ["body-o-ring"], hints: ["A thin film of silicone grease stops the seal rolling."], warnings: ["A twisted O-ring leaks under pressure."], commonMistakes: ["Rolling the seal into the groove so it twists."] }),
    step({ id: "insert-spool", kind: "place", title: "Insert the valve spool", instruction: "Lower the spool into the bore with the keyed notch toward the front port.", voiceLine: "Insert the spool, keyed notch toward the front.", partIds: ["valve-spool"], requires: ["seat-o-ring"], hints: ["The notch lines up with the arrow on the body."], commonMistakes: ["Inserting the spool rotated a quarter turn so the ports never open."] }),
    step({ id: "insert-spring", kind: "place", title: "Drop in the return spring", instruction: "Drop the return spring onto the spool head, axis vertical.", voiceLine: "Drop the return spring onto the spool.", partIds: ["return-spring"], requires: ["insert-spool"], commonMistakes: ["Letting the spring sit crooked on the spool shoulder."] }),
    step({ id: "thread-gland", kind: "place", title: "Thread on the gland nut", instruction: "Thread the gland nut down over the spring by hand until it meets the body.", voiceLine: "Thread the gland nut on by hand.", partIds: ["gland-nut"], requires: ["insert-spring"], hints: ["Turn it backwards first until you feel the thread drop in."], commonMistakes: ["Cross-threading the nut by starting it with a wrench."] }),
    step({ id: "pick-wrench", kind: "tool", title: "Pick the torque wrench", instruction: "Take the torque wrench with the 32 mm crowfoot and set it to 6 Nm.", voiceLine: "Pick up the torque wrench and set six newton metres.", requires: ["thread-gland"], tool: "torque wrench", commonMistakes: ["Using an adjustable spanner, which cannot hold the spec."] }),
    step({ id: "torque-gland", kind: "fasten", title: "Torque the gland nut", instruction: "Torque the gland nut to 6 Nm in one steady pull.", voiceLine: "Torque the gland nut to six newton metres, one steady pull.", partIds: ["gland-nut"], requires: ["pick-wrench"], tool: "torque wrench", torqueNm: 6, pattern: "single steady pull", warnings: ["Over-torque crushes the O-ring and the spool sticks."], commonMistakes: ["Jerking the wrench past the click."] }),
    step({ id: "fit-cap", kind: "place", title: "Fit the actuator cap", instruction: "Press the actuator cap onto the gland, green mark on top facing the operator.", voiceLine: "Fit the actuator cap, green mark facing you.", partIds: ["actuator-cap"], requires: ["torque-gland"], hints: ["The cap is turned half a turn from how it sits in the box."], commonMistakes: ["Fitting the cap back to front so the mark faces away."] }),
    step({ id: "fit-clip", kind: "place", title: "Slide in the locking clip", instruction: "Slide the locking clip into the cap slot from the right, tab toward the right.", voiceLine: "Slide the locking clip in from the right.", partIds: ["locking-clip"], requires: ["fit-cap"], commonMistakes: ["Leaving the clip half engaged."] }),
    step({ id: "drive-screw", kind: "place", title: "Fit the adjustment screw", instruction: "Start the adjustment screw in the top of the cap, driver slot toward the front.", voiceLine: "Fit the adjustment screw in the top of the cap.", partIds: ["adjustment-screw"], requires: ["fit-cap"], commonMistakes: ["Driving it fully in, which locks the spool."] }),
    step({ id: "adjust-preload", kind: "adjust", title: "Set spring preload", instruction: "Turn the adjustment screw until it stands 4.0 mm proud of the cap face. Measure with the depth gauge.", voiceLine: "Set the screw four millimetres proud of the cap.", partIds: ["adjustment-screw"], requires: ["drive-screw"], tool: "depth gauge", target: { label: "Screw protrusion", value: 4.0, unit: "mm", tolerance: 0.5 }, hints: ["Half a turn moves the screw about 0.5 mm."], commonMistakes: ["Measuring from the clip instead of the cap face."] }),
    step({ id: "inspect-valve", kind: "inspect", title: "Function and leak check", instruction: "Cycle the spool by hand and pressurise to 6 bar.", voiceLine: "Cycle the spool and check for leaks at six bar.", partIds: ["valve-spool", "locking-clip"], requires: ["fit-clip", "adjust-preload"], checklist: ["Spool returns fully when released", "No audible leak at 6 bar", "Locking clip fully seated"], warnings: ["Wear safety glasses when pressurising."], commonMistakes: ["Testing before the clip is home."] }),
  ],
  createdAt: BUILTIN_DATE,
  updatedAt: BUILTIN_DATE,
};
