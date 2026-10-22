import type { ForgeScenario } from "../types";
import { BUILTIN_DATE, DOWN, FLAT, IDENTITY, mate, part, rot, step } from "./util";

export const centrifugalPump: ForgeScenario = {
  id: "centrifugal-pump",
  version: 1,
  status: "published",
  title: "Centrifugal Pump Service",
  summary: "Install the shaft bearing, mechanical seal, impeller, volute cover, and fasteners, then verify free rotation and sealing.",
  domain: "mechanical",
  source: { kind: "builtin", approximation: false, notes: "Hand-authored fallback scenario for reliable hackathon demos." },
  baseParts: ["pump-housing"],
  parts: [
    part("pump-housing", "Pump Housing", "structural", "housing", { radius: 0.045, length: 0.05 }, "#80dfff", [0, 0.025, 0], IDENTITY, mate("fixed", DOWN, 0.01, 10), "Cast pump housing and bearing seat."),
    part("shaft-bearing", "Shaft Bearing", "bearing", "bearing", { radius: 0.016, length: 0.012 }, "#d8e2e5", [0, 0.045, 0], IDENTITY, mate("axial", DOWN, 0.005, 10, 0), "Sealed radial bearing."),
    part("mechanical-seal", "Mechanical Seal", "seal", "washer", { radius: 0.014, thickness: 0.006 }, "#c5a6ff", [0, 0.055, 0], FLAT, mate("planar", DOWN, 0.004, 10, 0), "Stationary ceramic seal face."),
    part("impeller", "Impeller", "drive", "gear", { radius: 0.035, teeth: 8, thickness: 0.012 }, "#5fc8ee", [0, 0.067, 0], IDENTITY, mate("axial", DOWN, 0.006, 12, 360), "Eight-vane pump impeller."),
    part("volute-gasket", "Volute Gasket", "seal", "torus", { radius: 0.038, tube: 0.0015 }, "#f2a5c2", [0, 0.075, 0], FLAT, mate("planar", DOWN, 0.005, 12, 0), "Elastomer housing gasket."),
    part("volute-cover", "Volute Cover", "structural", "cap", { radius: 0.047, length: 0.018 }, "#c4f48e", [0, 0.083, 0], rot([0, 1, 0], 180), mate("axial", DOWN, 0.006, 10, 360), "Front cover with discharge port."),
    part("cover-bolt-set", "Cover Bolt Set", "fastener", "bolt", { radius: 0.003, length: 0.025 }, "#ffbd70", [0.038, 0.083, 0], IDENTITY, mate("axial", DOWN, 0.006, 12, 360), "Six M6 cover bolts represented as one service set."),
  ],
  steps: [
    step({ id: "press-bearing", kind: "place", title: "Press in the shaft bearing", instruction: "Press on the outer race until the bearing seats against the shoulder.", voiceLine: "Press the bearing by its outer race until seated.", partIds: ["shaft-bearing"], tool: "arbor press", warnings: ["Never press through the inner race."], commonMistakes: ["Pressing on the inner race and brinelling the bearing."] }),
    step({ id: "fit-seal", kind: "place", title: "Fit the mechanical seal", instruction: "Clean the face and press the stationary seal squarely into its recess.", voiceLine: "Clean and fit the mechanical seal squarely.", partIds: ["mechanical-seal"], requires: ["press-bearing"], commonMistakes: ["Touching the ceramic face with greasy fingers."] }),
    step({ id: "fit-impeller", kind: "place", title: "Install the impeller", instruction: "Slide the impeller onto the shaft with the vane face toward the cover.", voiceLine: "Install the impeller with its vane face outward.", partIds: ["impeller"], requires: ["fit-seal"], commonMistakes: ["Installing the impeller with the vane face inward."] }),
    step({ id: "set-clearance", kind: "adjust", title: "Set impeller clearance", instruction: "Set the impeller-to-housing clearance to 0.5 mm.", voiceLine: "Set the impeller clearance to half a millimetre.", partIds: ["impeller"], requires: ["fit-impeller"], tool: "feeler gauge", target: { label: "Impeller clearance", value: 0.5, unit: "mm", tolerance: 0.1 }, hints: ["Measure at three points around the impeller."] }),
    step({ id: "fit-gasket", kind: "place", title: "Fit the volute gasket", instruction: "Lay the gasket flat in the housing groove.", voiceLine: "Lay the volute gasket flat in its groove.", partIds: ["volute-gasket"], requires: ["set-clearance"], warnings: ["Do not stretch or twist the gasket."], commonMistakes: ["Leaving the gasket proud of its groove."] }),
    step({ id: "fit-cover", kind: "place", title: "Fit the volute cover", instruction: "Align the discharge port and seat the cover without pinching the gasket.", voiceLine: "Align and seat the volute cover.", partIds: ["volute-cover"], requires: ["fit-gasket"], hints: ["Keep the discharge port aligned with the housing mark."] }),
    step({ id: "install-cover-bolts", kind: "place", title: "Install cover bolts", instruction: "Start all six bolts by hand.", voiceLine: "Start all six cover bolts by hand.", partIds: ["cover-bolt-set"], requires: ["fit-cover"], commonMistakes: ["Using a tool before every bolt is finger-started."] }),
    step({ id: "torque-cover", kind: "fasten", title: "Torque the cover", instruction: "Torque the bolts to 7 Nm in a star pattern.", voiceLine: "Torque the cover bolts to seven newton metres in a star pattern.", partIds: ["cover-bolt-set"], requires: ["install-cover-bolts"], tool: "torque wrench", torqueNm: 7, pattern: "star pattern, two passes", commonMistakes: ["Torqueing clockwise instead of using the star pattern."] }),
    step({ id: "inspect-pump", kind: "inspect", title: "Rotation and leak check", instruction: "Rotate the shaft by hand and hydro-test the casing.", voiceLine: "Check free rotation and hydro-test the casing.", partIds: ["impeller", "volute-cover"], requires: ["torque-cover"], checklist: ["Impeller turns freely", "No gasket pinch is visible", "No leak during hydro-test"], commonMistakes: ["Starting a powered test before confirming free hand rotation."] }),
  ],
  createdAt: BUILTIN_DATE,
  updatedAt: BUILTIN_DATE,
};
