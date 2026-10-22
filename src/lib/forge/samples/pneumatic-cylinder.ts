import type { ForgeScenario } from "../types";
import { BUILTIN_DATE, DOWN, FLAT, IDENTITY, mate, part, rot, step } from "./util";

export const pneumaticCylinder: ForgeScenario = {
  id: "pneumatic-cylinder",
  version: 1,
  status: "published",
  title: "Pneumatic Cylinder Rebuild",
  summary: "Rebuild a compact double-acting cylinder with piston seals, rod, end cap, tie bolts, and a final leak check.",
  domain: "mechanical",
  source: { kind: "builtin", approximation: false, notes: "Hand-authored fallback scenario for reliable hackathon demos." },
  baseParts: ["cylinder-barrel"],
  parts: [
    part("cylinder-barrel", "Cylinder Barrel", "structural", "tube", { radius: 0.028, length: 0.09 }, "#80dfff", [0, 0.045, 0], IDENTITY, mate("fixed", DOWN, 0.01, 10), "Honed aluminium cylinder barrel."),
    part("piston-seal", "Piston Seal", "seal", "torus", { radius: 0.018, tube: 0.002 }, "#c5a6ff", [0, 0.044, 0], FLAT, mate("planar", DOWN, 0.005, 12, 0), "Low-friction piston seal."),
    part("piston-rod", "Piston and Rod", "drive", "shaft", { radius: 0.008, length: 0.14 }, "#d8e2e5", [0, 0.075, 0], IDENTITY, mate("axial", DOWN, 0.007, 10, 360), "Chrome rod with piston head."),
    part("rod-seal", "Rod Seal", "seal", "torus", { radius: 0.01, tube: 0.0015 }, "#f2a5c2", [0, 0.096, 0], FLAT, mate("planar", DOWN, 0.005, 12, 0), "Rod-side pressure seal."),
    part("front-cap", "Front End Cap", "structural", "cap", { radius: 0.029, length: 0.018 }, "#c4f48e", [0, 0.099, 0], rot([0, 1, 0], 180), mate("axial", DOWN, 0.006, 10, 360), "Front cap with rod bearing."),
    part("tie-bolt-set", "Tie Bolt Set", "fastener", "bolt", { radius: 0.003, length: 0.11 }, "#ffbd70", [0.022, 0.055, 0], IDENTITY, mate("axial", DOWN, 0.006, 12, 360), "Four tie bolts represented as one service set."),
  ],
  steps: [
    step({ id: "fit-piston-seal", kind: "place", title: "Fit the piston seal", instruction: "Lubricate and seat the piston seal without twisting it.", voiceLine: "Lubricate and seat the piston seal flat.", partIds: ["piston-seal"], warnings: ["A twisted seal will leak."], commonMistakes: ["Rolling the seal into the groove."] }),
    step({ id: "insert-rod", kind: "place", title: "Insert piston and rod", instruction: "Guide the piston into the barrel with the rod vertical.", voiceLine: "Guide the piston and rod into the barrel.", partIds: ["piston-rod"], requires: ["fit-piston-seal"], hints: ["Use the sleeve to protect the seal lip."] }),
    step({ id: "fit-rod-seal", kind: "place", title: "Fit the rod seal", instruction: "Seat the rod seal in the front cap recess, lip toward pressure.", voiceLine: "Fit the rod seal, pressure lip inward.", partIds: ["rod-seal"], requires: ["insert-rod"], commonMistakes: ["Reversing the pressure lip."] }),
    step({ id: "fit-front-cap", kind: "place", title: "Fit the front cap", instruction: "Slide the cap over the rod and seat it squarely on the barrel.", voiceLine: "Slide on the front cap and seat it square.", partIds: ["front-cap"], requires: ["fit-rod-seal"], commonMistakes: ["Forcing a cap that is cocked on the barrel."] }),
    step({ id: "install-tie-bolts", kind: "place", title: "Install the tie bolts", instruction: "Insert the four tie bolts through the end-cap holes.", voiceLine: "Install all four tie bolts.", partIds: ["tie-bolt-set"], requires: ["fit-front-cap"], hints: ["Start every nut before tightening any one bolt."] }),
    step({ id: "torque-tie-bolts", kind: "fasten", title: "Torque the tie bolts", instruction: "Torque in a cross pattern to 8 Nm in two passes.", voiceLine: "Torque the tie bolts to eight newton metres in a cross pattern.", partIds: ["tie-bolt-set"], requires: ["install-tie-bolts"], tool: "torque wrench", torqueNm: 8, pattern: "cross pattern, two passes", commonMistakes: ["Tightening one side fully before the cross pattern."] }),
    step({ id: "inspect-cylinder", kind: "inspect", title: "Stroke and leak check", instruction: "Stroke the rod by hand, then test both ports at 6 bar.", voiceLine: "Stroke the rod and leak check both ports at six bar.", partIds: ["piston-rod"], requires: ["torque-tie-bolts"], checklist: ["Rod moves smoothly", "No bubbles at either cap", "Rod returns without binding"], warnings: ["Wear safety glasses during pressure testing."], commonMistakes: ["Pressurising before checking that the rod moves freely."] }),
  ],
  createdAt: BUILTIN_DATE,
  updatedAt: BUILTIN_DATE,
};
