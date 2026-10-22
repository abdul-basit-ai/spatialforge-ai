import type { ForgeScenario, Vec3 } from "../types";
import { BUILTIN_DATE, DOWN, IDENTITY, mate, part, step } from "./util";

// Single-stage planetary gearbox, module 1: sun 22T, planets 29T, ring 80T (ratio 1 + 80/22 = 4.64:1; (22+80)/3 is whole, so three equal planets fit).
// The housing stands at the origin, axis vertical; everything drops in from above.
const STEEL = "#9aa6b2", DARK = "#4a525c", GEAR = "#c7cfd8", RING = "#f5a623";
const PLANET_R = 0.0255, BOLT_R = 0.048;
const at = (radius: number, deg: number, y: number): Vec3 => [radius * Math.cos((deg * Math.PI) / 180), y, radius * Math.sin((deg * Math.PI) / 180)];
const planet = (id: string, name: string, deg: number) => part(id, name, "drive", "gear", { radius: 0.0145, teeth: 29, thickness: 0.01 }, GEAR, at(PLANET_R, deg, 0.024), IDENTITY, mate("axial", DOWN, 0.005, 10, 0), "29-tooth planet with a needle bearing, runs on a carrier pin.");
const bolt = (id: string, name: string, deg: number) => part(id, name, "fastener", "bolt", { radius: 0.002, length: 0.016 }, "#2d3138", at(BOLT_R, deg, 0.04), IDENTITY, mate("axial", DOWN, 0.004, 15, 60), "M4 x 16 socket head cap screw.");

export const planetaryGearbox: ForgeScenario = {
  id: "planetary-gearbox",
  version: 1,
  status: "published",
  title: "Planetary Gearbox 4.6:1",
  summary: "Build a single-stage planetary reducer: output bearing, carrier, ring gear, three planets, sun gear, cover, input bearing and a torqued star-pattern bolt-up.",
  domain: "mechanical",
  source: { kind: "builtin", approximation: false, notes: "Module 1 gearing, 22/29/80 teeth; 110 mm housing." },
  baseParts: ["housing"],
  parts: [
    part("housing", "Gearbox Housing", "structural", "tube", { radius: 0.055, length: 0.04 }, DARK, [0, 0.02, 0], IDENTITY, mate("fixed", DOWN, 0.01, 10), "Machined aluminium housing with the output bearing seat in the floor."),
    part("output-bearing", "Output Bearing (6002)", "bearing", "bearing", { radius: 0.014, length: 0.008 }, STEEL, [0, 0.006, 0], IDENTITY, mate("axial", DOWN, 0.005, 10, 0), "28 x 15 x 8 mm deep-groove ball bearing."),
    part("carrier", "Planet Carrier", "drive", "cylinder", { radius: 0.038, length: 0.006 }, STEEL, [0, 0.013, 0], IDENTITY, mate("axial", DOWN, 0.006, 10, 120), "Carrier disc with three planet pins and the output shaft."),
    part("ring-gear", "Ring Gear (80T)", "drive", "tube", { radius: 0.042, length: 0.012, teeth: 80 }, RING, [0, 0.024, 0], IDENTITY, mate("planar", DOWN, 0.006, 8, 120), "Internal ring gear located by three dowel pins."),
    planet("planet-a", "Planet Gear A", 90),
    planet("planet-b", "Planet Gear B", 210),
    planet("planet-c", "Planet Gear C", 330),
    part("sun-gear", "Sun Gear (22T)", "drive", "gear", { radius: 0.011, teeth: 22, thickness: 0.012 }, "#e8edf2", [0, 0.024, 0], IDENTITY, mate("axial", DOWN, 0.005, 10, 0), "Sun gear on the input shaft."),
    part("cover", "Housing Cover", "structural", "cap", { radius: 0.055, length: 0.006 }, DARK, [0, 0.043, 0], IDENTITY, mate("planar", DOWN, 0.006, 8, 120), "Cover plate with the input bearing bore and three bolt holes."),
    part("input-bearing", "Input Bearing (6000)", "bearing", "bearing", { radius: 0.013, length: 0.007 }, STEEL, [0, 0.0435, 0], IDENTITY, mate("axial", DOWN, 0.005, 10, 0), "26 x 10 x 8 mm ball bearing for the input shaft."),
    bolt("bolt-1", "Cover Bolt 1", 30),
    bolt("bolt-2", "Cover Bolt 2", 150),
    bolt("bolt-3", "Cover Bolt 3", 270),
  ],
  steps: [
    step({ id: "press-output-bearing", kind: "place", title: "Press in the output bearing", instruction: "Press the 6002 bearing squarely into the seat in the housing floor, pushing on the outer ring.", voiceLine: "Press the output bearing into the housing floor.", partIds: ["output-bearing"], hints: ["Use the bearing driver so the load goes through the outer ring."], warnings: ["Never hammer on the inner ring."], commonMistakes: ["Cocking the bearing in the seat."] }),
    step({ id: "place-carrier", kind: "place", title: "Fit the planet carrier", instruction: "Lower the carrier into the housing, output shaft through the bearing, pins pointing up.", voiceLine: "Lower the planet carrier in, pins up.", partIds: ["carrier"], requires: ["press-output-bearing"], hints: ["Fit the carrier before the ring gear so you can watch the output shaft enter the bearing."], commonMistakes: ["Fitting the carrier upside down with the pins pointing into the floor."] }),
    step({ id: "place-ring-gear", kind: "place", title: "Seat the ring gear", instruction: "Lower the ring gear onto its shoulder so the three dowel pins drop into their holes.", voiceLine: "Seat the ring gear on its dowel pins.", partIds: ["ring-gear"], requires: ["place-carrier"], hints: ["Any of the three dowel positions works; the pattern repeats every 120 degrees."], commonMistakes: ["Resting the ring on top of a dowel so it sits proud."] }),
    step({ id: "place-planet-a", kind: "place", title: "Fit planet gear A", instruction: "Slide planet A onto its carrier pin until it meshes with the ring gear.", voiceLine: "Fit planet gear A on its pin.", partIds: ["planet-a"], requires: ["place-ring-gear"], hints: ["Rock the planet gently until its teeth drop into the ring."], commonMistakes: ["Forcing the planet tooth-on-tooth."] }),
    step({ id: "place-planet-b", kind: "place", title: "Fit planet gear B", instruction: "Slide planet B onto its carrier pin.", voiceLine: "Fit planet gear B on its pin.", partIds: ["planet-b"], requires: ["place-ring-gear"], commonMistakes: ["Leaving out the thrust washer under the planet."] }),
    step({ id: "place-planet-c", kind: "place", title: "Fit planet gear C", instruction: "Slide planet C onto its carrier pin.", voiceLine: "Fit planet gear C on its pin.", partIds: ["planet-c"], requires: ["place-ring-gear"], commonMistakes: ["Leaving out the thrust washer under the planet."] }),
    step({ id: "insert-sun", kind: "place", title: "Insert the sun gear", instruction: "Lower the sun gear into the centre and turn it slowly until it meshes with all three planets.", voiceLine: "Insert the sun gear and turn it until it meshes with all three planets.", partIds: ["sun-gear"], requires: ["place-planet-a", "place-planet-b", "place-planet-c"], hints: ["Turn the input a few degrees back and forth; it drops in when the teeth line up."], commonMistakes: ["Pushing down hard instead of turning, which burrs the tooth tips."] }),
    step({ id: "inspect-mesh", kind: "inspect", title: "Check the gear mesh", instruction: "Turn the sun gear one full turn by hand and watch all three planets.", voiceLine: "Turn the sun one full turn and watch the planets.", partIds: ["sun-gear", "planet-a", "planet-b", "planet-c"], requires: ["insert-sun"], checklist: ["All three planets turn together", "No tight spot or tooth rubbing", "Carrier turns the output shaft"], hints: ["The output should turn a little over a fifth of a turn per input turn."], commonMistakes: ["Skipping the check and finding a dropped washer after the cover is on."] }),
    step({ id: "fit-cover", kind: "place", title: "Fit the cover", instruction: "Lower the cover over the input shaft so the three bolt holes line up with the housing.", voiceLine: "Fit the cover and line up the bolt holes.", partIds: ["cover"], requires: ["inspect-mesh"], hints: ["The bolt pattern repeats every 120 degrees."], commonMistakes: ["Pinching the cover gasket."] }),
    step({ id: "press-input-bearing", kind: "place", title: "Press in the input bearing", instruction: "Press the 6000 bearing into the cover bore over the input shaft.", voiceLine: "Press the input bearing into the cover.", partIds: ["input-bearing"], requires: ["fit-cover"], warnings: ["Support the input shaft from below while pressing."], commonMistakes: ["Pushing the sun gear out of mesh while pressing."] }),
    step({ id: "pick-hex-key", kind: "tool", title: "Pick the 3 mm hex key", instruction: "Take the 3 mm hex bit for the torque wrench. The cover bolts are M4 socket head.", voiceLine: "Pick up the three millimetre hex key.", requires: ["press-input-bearing"], tool: "3 mm hex key", commonMistakes: ["Using the 2.5 mm key, which rounds the M4 socket."] }),
    step({ id: "insert-bolts", kind: "place", title: "Insert the cover bolts", instruction: "Insert all three M4 bolts and run them down finger tight.", voiceLine: "Insert all three cover bolts, finger tight.", partIds: ["bolt-1", "bolt-2", "bolt-3"], requires: ["pick-hex-key"], commonMistakes: ["Fully tightening the first bolt before the others are started."] }),
    step({ id: "torque-bolts", kind: "fasten", title: "Torque the cover bolts", instruction: "Torque the bolts to 2.5 Nm in a star pattern, two passes.", voiceLine: "Torque the cover bolts to two point five newton metres, star pattern, two passes.", partIds: ["bolt-1", "bolt-2", "bolt-3", "cover"], requires: ["insert-bolts"], tool: "3 mm hex key", torqueNm: 2.5, pattern: "star pattern, two passes: 1.2 Nm then 2.5 Nm", warnings: ["Uneven torque cocks the cover and pre-loads the input bearing."], commonMistakes: ["Going round the circle instead of across."] }),
    step({ id: "final-inspect", kind: "inspect", title: "Final run-in check", instruction: "Turn the input shaft ten turns by hand and check the output.", voiceLine: "Turn the input ten turns and check the output.", partIds: ["sun-gear", "carrier"], requires: ["torque-bolts"], checklist: ["Input turns smoothly with even drag", "Output turns about 2.2 turns for 10 input turns", "No grinding or clicking"], commonMistakes: ["Testing with a drill before checking by hand."] }),
  ],
  createdAt: BUILTIN_DATE,
  updatedAt: BUILTIN_DATE,
};
