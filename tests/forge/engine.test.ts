import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  attemptPlace, attemptStep, createRun, expectedNext, insertionBlocker, isComplete, nextSteps, orientationError, partById, partSize, progress, quatAxisAngle, qmul,
  snapPose, stagingPose, stepById, type RunState, type StepEvidence, type Verdict,
} from "../../src/lib/forge/engine";
import { BUILTIN_SCENARIOS, builtinScenario } from "../../src/lib/forge/samples";
import type { ForgeScenario, ForgeStep, Transform } from "../../src/lib/forge/types";
import { validateScenario } from "../../src/lib/forge/validate";

const PLACE = ["place", "connect", "route"];
const scenario = (id: string) => { const s = builtinScenario(id); assert.ok(s, `missing builtin ${id}`); return s; };
const seated = (s: ForgeScenario, partId: string): Transform => partById(s, partId)!.assembled;
const evidenceFor = (step: ForgeStep): StepEvidence => {
  if (step.kind === "tool") return { tool: step.tool };
  if (step.target) return { value: step.target.value, tool: step.tool };
  if (step.torqueNm) return { value: step.torqueNm, tool: step.tool };
  if (step.checklist?.length) return { checklist: step.checklist.map(() => true) };
  return { confirmed: true };
};

// Performs one step with correct actions. Returns the verdicts of every action.
function perform(s: ForgeScenario, run: RunState, step: ForgeStep): { run: RunState; verdicts: Verdict[] } {
  const verdicts: Verdict[] = [];
  if (PLACE.includes(step.kind)) {
    for (const id of step.partIds.filter((partId) => !run.installed.includes(partId))) {
      const result = attemptPlace(s, run, id, seated(s, id));
      verdicts.push(result.verdict); run = result.run;
      if (!result.verdict.ok) break;
    }
  } else {
    const result = attemptStep(s, run, step.id, evidenceFor(step));
    verdicts.push(result.verdict); run = result.run;
  }
  return { run, verdicts };
}

// Run until a given step id becomes available, using the scenario's listed order.
function runUntil(s: ForgeScenario, stepId: string): RunState {
  let run = createRun(s);
  while (!nextSteps(s, run).some((step) => step.id === stepId)) {
    const step = nextSteps(s, run)[0];
    assert.ok(step, `ran out of steps before ${stepId}`);
    run = perform(s, run, step).run;
  }
  return run;
}

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

describe("built-in scenarios", () => {
  test("exist and cover the three demos", () => {
    assert.deepEqual(BUILTIN_SCENARIOS.map((s) => s.id).sort(), ["centrifugal-pump", "linear-actuator", "planetary-gearbox", "pneumatic-cylinder", "pneumatic-valve"]);
    const actuator = scenario("linear-actuator");
    assert.ok(actuator.parts.length >= 14 && actuator.parts.length <= 20, `actuator has ${actuator.parts.length} parts`);
    for (const kind of ["place", "fasten", "connect", "route", "adjust", "inspect", "tool"]) assert.ok(actuator.steps.some((step) => step.kind === kind), `actuator lacks a ${kind} step`);
    assert.equal(scenario("pneumatic-valve").parts.length, 8);
    const gearbox = scenario("planetary-gearbox").parts.length;
    assert.ok(gearbox >= 10 && gearbox <= 14);
  });

  for (const s of BUILTIN_SCENARIOS) {
    test(`${s.id}: validates with zero issues`, () => assert.deepEqual(validateScenario(s), []));

    test(`${s.id}: every step has voice, hints or mistakes, and parts have colors and bounds`, () => {
      for (const step of s.steps) {
        assert.ok(step.voiceLine.trim().length > 5, step.id);
        assert.ok((step.hints?.length ?? 0) + (step.commonMistakes?.length ?? 0) > 0, `${step.id} has no hints or common mistakes`);
      }
      for (const part of s.parts) {
        assert.ok(part.color, part.id);
        const size = partSize(part);
        assert.ok(size && size.every((v) => v > 0 && v < 1), `${part.id} has no usable bounds`);
      }
    });

    test(`${s.id}: completes in its listed order with no mistakes`, () => {
      let run = createRun(s);
      for (let guard = 0; guard < 200 && !isComplete(s, run); guard++) {
        const step = nextSteps(s, run)[0];
        const result = perform(s, run, step);
        for (const verdict of result.verdicts) assert.ok(verdict.ok, `${step.id}: ${!verdict.ok ? verdict.message : ""}`);
        run = result.run;
      }
      assert.ok(isComplete(s, run));
      assert.equal(run.mistakes.length, 0);
      assert.deepEqual(progress(s, run), { done: s.steps.length, total: s.steps.length, percent: 100 });
      assert.deepEqual(expectedNext(s, run), { step: null, partIds: [] });
      assert.deepEqual([...run.installed].sort(), s.parts.map((part) => part.id).sort());
    });

    test(`${s.id}: any allowed order completes without dead ends (blocked guidance only)`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const random = rng(seed);
        let run = createRun(s);
        for (let guard = 0; guard < 500 && !isComplete(s, run); guard++) {
          const available = nextSteps(s, run);
          assert.ok(available.length, `seed ${seed}: dead end`);
          const ordered = available.map((step) => ({ step, key: random() })).sort((a, b) => a.key - b.key).map((entry) => entry.step);
          let progressed = false;
          for (const step of ordered) {
            const ids = PLACE.includes(step.kind) ? step.partIds.filter((id) => !run.installed.includes(id)) : [];
            const shuffled = ids.map((id) => ({ id, key: random() })).sort((a, b) => a.key - b.key).map((entry) => entry.id);
            if (PLACE.includes(step.kind)) {
              for (const id of shuffled) {
                const result = attemptPlace(s, run, id, seated(s, id));
                if (result.verdict.ok) { run = result.run; progressed = true; break; }
                assert.equal(result.verdict.reason, "blocked", `seed ${seed} ${id}: ${result.verdict.message}`);
              }
            } else {
              const result = attemptStep(s, run, step.id, evidenceFor(step));
              assert.ok(result.verdict.ok); run = result.run; progressed = true;
            }
            if (progressed) break;
          }
          assert.ok(progressed, `seed ${seed}: every available action was blocked`);
        }
        assert.ok(isComplete(s, run), `seed ${seed}: incomplete`);
      }
    });
  }
});

describe("order", () => {
  test("rejects a part placed out of order and names what to do now", () => {
    const s = scenario("linear-actuator");
    const { verdict, run } = attemptPlace(s, createRun(s), "lead-screw", seated(s, "lead-screw"));
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.reason, "out-of-order");
    assert.equal(verdict.expectedPartId, "rail-support-a");
    assert.match(verdict.message, /Lead Screw/);
    assert.match(verdict.message, /Right now: Place the rail supports/);
    assert.equal(run.mistakes.length, 1);
    assert.equal(run.installed.includes("lead-screw"), false);
  });

  test("rejects a non-placement step done early, and repeats of installed parts", () => {
    const s = scenario("linear-actuator");
    let run = createRun(s);
    const early = attemptStep(s, run, "fasten-coupling", { confirmed: true }).verdict;
    assert.equal(!early.ok && early.reason, "out-of-order");
    run = attemptPlace(s, run, "rail-support-a", seated(s, "rail-support-a")).run;
    const again = attemptPlace(s, run, "rail-support-a", seated(s, "rail-support-a")).verdict;
    assert.equal(!again.ok && again.reason, "wrong-part");
    const unknown = attemptPlace(s, run, "flux-capacitor", seated(s, "rail-support-a")).verdict;
    assert.equal(!unknown.ok && unknown.reason, "wrong-part");
  });

  test("a multi-part step stays active until all its parts are seated", () => {
    const s = scenario("linear-actuator");
    const first = attemptPlace(s, createRun(s), "rail-support-a", seated(s, "rail-support-a"));
    assert.deepEqual(first.verdict, { ok: true, stepId: "place-supports", done: false });
    const step = attemptStep(s, first.run, "place-supports", { confirmed: true }).verdict;
    assert.equal(!step.ok && step.reason, "not-confirmed");
    const second = attemptPlace(s, first.run, "rail-support-b", seated(s, "rail-support-b"));
    assert.deepEqual(second.verdict, { ok: true, stepId: "place-supports", done: true });
    assert.equal(second.run.activeStepId, "pick-hex-key");
    assert.deepEqual(progress(s, second.run), { done: 1, total: s.steps.length, percent: Math.round(100 / s.steps.length) });
  });
});

describe("position and orientation", () => {
  test("position errors give a direction and a distance, by mate type", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "place-carriage");
    const seat = seated(s, "carriage");
    const short = attemptPlace(s, run, "carriage", { ...seat, position: [seat.position[0] + 0.02, seat.position[1], seat.position[2]] }).verdict;
    assert.equal(!short.ok && short.reason, "position");
    assert.match(!short.ok ? short.message : "", /not fully seated.*20 mm further in/);
    const offAxis = attemptPlace(s, run, "carriage", { ...seat, position: [seat.position[0], seat.position[1] + 0.015, seat.position[2]] }).verdict;
    assert.match(!offAxis.ok ? offAxis.message : "", /off its centreline.*down/);
    const planar = attemptPlace(s, createRun(s), "rail-support-a", { ...seated(s, "rail-support-a"), position: [-0.1, 0.03, 0] }).verdict;
    assert.match(!planar.ok ? planar.message : "", /not sitting flat.*lower it 16 mm/);
    const near = attemptPlace(s, run, "carriage", { ...seat, position: [seat.position[0] + 0.005, seat.position[1], seat.position[2]] }).verdict;
    assert.ok(near.ok);
  });

  test("orientation honours symmetry: hex bolts every 60°, square-ish supports every 180°, keyed parts once, round parts any angle", () => {
    const g = scenario("planetary-gearbox");
    const bolt = partById(g, "bolt-1")!;
    const turn = (deg: number, axis: [number, number, number] = [0, 1, 0]) => qmul(quatAxisAngle(axis, deg), bolt.assembled.quaternion);
    assert.ok(orientationError(turn(60), bolt.assembled.quaternion, bolt.mate) < 0.01);
    assert.ok(orientationError(turn(120), bolt.assembled.quaternion, bolt.mate) < 0.01);
    assert.ok(Math.abs(orientationError(turn(30), bolt.assembled.quaternion, bolt.mate) - 30) < 0.01);
    assert.ok(Math.abs(orientationError(turn(50), bolt.assembled.quaternion, bolt.mate) - 10) < 0.01);
    assert.ok(Math.abs(orientationError(turn(20, [1, 0, 0]), bolt.assembled.quaternion, bolt.mate) - 20) < 0.01, "tilt is never forgiven by symmetry");

    const a = scenario("linear-actuator");
    const screw = partById(a, "lead-screw")!;
    assert.ok(orientationError(qmul(quatAxisAngle([1, 0, 0], 137), screw.assembled.quaternion), screw.assembled.quaternion, screw.mate) < 0.01, "symmetry 0 = any spin");
    const connector = partById(a, "motor-connector")!;
    assert.ok(Math.abs(orientationError(quatAxisAngle([0, 1, 0], 180), connector.assembled.quaternion, connector.mate) - 180) < 0.01, "keyed");

    const run = createRun(a);
    const support = seated(a, "rail-support-a");
    assert.ok(attemptPlace(a, run, "rail-support-a", { ...support, quaternion: quatAxisAngle([0, 1, 0], 180) }).verdict.ok);
    const quarter = attemptPlace(a, run, "rail-support-a", { ...support, quaternion: quatAxisAngle([0, 1, 0], 90) }).verdict;
    assert.equal(!quarter.ok && quarter.reason, "orientation");
    assert.match(!quarter.ok ? quarter.message : "", /Turn the Rail Support \(motor side\) 90° about its axis.*repeats every 180°/);
    const tilted = attemptPlace(a, run, "rail-support-a", { ...support, quaternion: quatAxisAngle([1, 0, 0], 30) }).verdict;
    assert.match(!tilted.ok ? tilted.message : "", /tipped 30°/);
  });

  test("fixed mates check straight-line distance and name the direction", () => {
    const base = scenario("pneumatic-valve");
    const s: ForgeScenario = {
      ...base, id: "fixed-test", baseParts: [],
      parts: [{ id: "jig", name: "Fixture Jig", category: "structural", geometry: { kind: "primitive", shape: "box", params: { width: 0.1, height: 0.02, depth: 0.1 } }, assembled: { position: [0, 0.01, 0], quaternion: [0, 0, 0, 1] }, mate: { type: "fixed", positionTolerance: 0.005, angleToleranceDeg: 5 } }],
      steps: [{ id: "jig", kind: "place", title: "Set the jig", instruction: "Set the jig.", voiceLine: "Set the jig.", partIds: ["jig"], requires: [] }],
    };
    const off = attemptPlace(s, createRun(s), "jig", { position: [0.03, 0.01, 0], quaternion: [0, 0, 0, 1] }).verdict;
    assert.equal(!off.ok && off.reason, "position");
    assert.match(!off.ok ? off.message : "", /Move the Fixture Jig 30 mm to the left/);
    const turned = attemptPlace(s, createRun(s), "jig", { position: [0, 0.01, 0], quaternion: quatAxisAngle([0, 1, 0], 20) }).verdict;
    assert.equal(!turned.ok && turned.reason, "orientation");
    assert.match(!turned.ok ? turned.message : "", /20° off/);
  });

  test("keyed connector rejects a flipped plug with a keyed message", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "connect-motor-cable");
    const flipped = attemptPlace(s, run, "motor-connector", { ...seated(s, "motor-connector"), quaternion: quatAxisAngle([0, 1, 0], 180) }).verdict;
    assert.equal(!flipped.ok && flipped.reason, "orientation");
    assert.match(!flipped.ok ? flipped.message : "", /keyed/);
  });

  test("snapPose snaps inside 2x tolerance only", () => {
    const s = scenario("linear-actuator");
    const seat = seated(s, "carriage");
    const tol = partById(s, "carriage")!.mate.positionTolerance;
    assert.deepEqual(snapPose(s, "carriage", { ...seat, position: [seat.position[0] + tol * 1.8, seat.position[1], seat.position[2]] }), seat);
    assert.equal(snapPose(s, "carriage", { ...seat, position: [seat.position[0] + tol * 2.5, seat.position[1], seat.position[2]] }), null);
    assert.equal(snapPose(s, "carriage", { ...seat, quaternion: quatAxisAngle([1, 0, 0], 45) }), null);
    assert.equal(snapPose(s, "nope", seat), null);
  });
});

describe("blocked insertion path", () => {
  test("an installed part on the insertion path blocks placement and is named", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "place-carriage");
    // Force the idler block in (as if fitted on real hardware) and try to slide the carriage on.
    const forced: RunState = { ...run, installed: [...run.installed, "idler-bearing-block"] };
    assert.equal(insertionBlocker(s, forced, "carriage")?.id, "idler-bearing-block");
    const { verdict } = attemptPlace(s, forced, "carriage", seated(s, "carriage"));
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.reason, "blocked");
    assert.equal(verdict.blockerId, "idler-bearing-block");
    assert.match(verdict.message, /Idler Bearing Block is in the way.*slides in from the right/);
  });

  test("placing a part that would close off another part's path is refused with the right order", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "place-idler-block");
    const early = attemptPlace(s, run, "idler-bearing-block", seated(s, "idler-bearing-block"));
    assert.equal(!early.verdict.ok && early.verdict.reason, "blocked");
    if (early.verdict.ok) return;
    assert.equal(early.verdict.victimId, "carriage");
    assert.match(early.verdict.message, /Fit the Carriage Block \(MGN12H\) first/);
    const carriage = attemptPlace(s, early.run, "carriage", seated(s, "carriage"));
    assert.ok(carriage.verdict.ok);
    assert.ok(attemptPlace(s, carriage.run, "idler-bearing-block", seated(s, "idler-bearing-block")).verdict.ok);
  });

  test("mating hosts (bores, rails, housings) never count as blockers", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "insert-lead-screw");
    assert.equal(insertionBlocker(s, run, "lead-screw"), null);
    const p = stagingPose(s, "lead-screw");
    assert.ok(p.position[0] > seated(s, "lead-screw").position[0], "screw stages on the idler side");
  });

  test("synthetic: a plate over a hole blocks a pin dropped from above", () => {
    const base = scenario("pneumatic-valve");
    const s: ForgeScenario = {
      ...base, id: "pin-test", baseParts: ["block"],
      parts: [
        { id: "block", name: "Block", category: "structural", geometry: { kind: "primitive", shape: "box", params: { width: 0.1, height: 0.02, depth: 0.1 } }, assembled: { position: [0, 0.01, 0], quaternion: [0, 0, 0, 1] }, mate: { type: "fixed", positionTolerance: 0.01, angleToleranceDeg: 10 } },
        { id: "pin", name: "Dowel Pin", category: "fastener", geometry: { kind: "primitive", shape: "shaft", params: { radius: 0.003, length: 0.02 } }, assembled: { position: [0, 0.02, 0], quaternion: [0, 0, 0, 1] }, mate: { type: "axial", axis: [0, -1, 0], positionTolerance: 0.004, angleToleranceDeg: 10, symmetryDeg: 0 } },
        { id: "cover", name: "Cover Plate", category: "structural", geometry: { kind: "primitive", shape: "plate", params: { width: 0.06, height: 0.004, depth: 0.06 } }, bounds: { size: [0.06, 0.004, 0.06] }, assembled: { position: [0, 0.06, 0], quaternion: [0, 0, 0, 1] }, mate: { type: "planar", axis: [0, -1, 0], positionTolerance: 0.005, angleToleranceDeg: 10 } },
      ],
      steps: [
        { id: "pin", kind: "place", title: "Drive the pin", instruction: "Drive the pin.", voiceLine: "Drive the pin.", partIds: ["pin"], requires: [] },
        { id: "cover", kind: "place", title: "Fit the cover", instruction: "Fit the cover.", voiceLine: "Fit the cover.", partIds: ["cover"], requires: [] },
      ],
    };
    assert.deepEqual(validateScenario(s), []);
    const refused = attemptPlace(s, createRun(s), "cover", seated(s, "cover")).verdict;
    assert.equal(!refused.ok && refused.reason, "blocked");
    const forced: RunState = { ...createRun(s), installed: ["block", "cover"] };
    const blocked = attemptPlace(s, forced, "pin", seated(s, "pin")).verdict;
    assert.equal(!blocked.ok && blocked.reason, "blocked");
    assert.equal(!blocked.ok && blocked.blockerId, "cover");
    assert.match(!blocked.ok ? blocked.message : "", /drops in from above/);
  });
});

describe("tools, adjustments and confirmations", () => {
  test("wrong tool is rejected; spelling and 'Allen' variants are accepted", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "pick-hex-key");
    const wrong = attemptStep(s, run, "pick-hex-key", { tool: "3 mm hex key" }).verdict;
    assert.equal(!wrong.ok && wrong.reason, "wrong-tool");
    assert.match(!wrong.ok ? wrong.message : "", /That is the 3 mm hex key\..*needs the 2\.5 mm hex key/);
    const none = attemptStep(s, run, "pick-hex-key", {}).verdict;
    assert.equal(!none.ok && none.reason, "not-confirmed");
    assert.ok(attemptStep(s, run, "pick-hex-key", { tool: "2.5mm Allen Key" }).verdict.ok);
  });

  test("adjust outside tolerance is rejected with the correction; inside is accepted", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "adjust-coupling-gap");
    const wide = attemptStep(s, run, "adjust-coupling-gap", { value: 1.5 }).verdict;
    assert.equal(!wide.ok && wide.reason, "out-of-range");
    assert.match(!wide.ok ? wide.message : "", /Coupling gap reads 1\.5 mm; it must be 1 mm ± 0\.2\. Reduce it by 0\.5 mm/);
    const tight = attemptStep(s, run, "adjust-coupling-gap", { value: 0.7 }).verdict;
    assert.match(!tight.ok ? tight.message : "", /Increase it by 0\.3 mm/);
    assert.equal(!attemptStep(s, run, "adjust-coupling-gap", {}).verdict.ok, true);
    const garbage = attemptStep(s, run, "adjust-coupling-gap", { value: Number.NaN }).verdict;
    assert.equal(!garbage.ok && garbage.reason, "not-confirmed");
    assert.match(!garbage.ok ? garbage.message : "", /not a number.*coupling gap in mm/);
    assert.ok(attemptStep(s, run, "adjust-coupling-gap", { value: 1.15 }).verdict.ok);
  });

  test("torque readings are checked against spec", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "fasten-supports");
    const over = attemptStep(s, run, "fasten-supports", { value: 2 }).verdict;
    assert.equal(!over.ok && over.reason, "out-of-range");
    assert.match(!over.ok ? over.message : "", /Over-torqued/);
    assert.ok(attemptStep(s, run, "fasten-supports", { value: 1.2, tool: "2.5 mm hex key" }).verdict.ok);
  });

  test("inspection needs every checklist item", () => {
    const s = scenario("linear-actuator");
    const run = runUntil(s, "inspect-rotation");
    const step = stepById(s, "inspect-rotation")!;
    const partial = attemptStep(s, run, "inspect-rotation", { checklist: step.checklist!.map((_, i) => i !== 1) }).verdict;
    assert.equal(!partial.ok && partial.reason, "not-confirmed");
    assert.match(!partial.ok ? partial.message : "", /No tight spot/);
    assert.ok(attemptStep(s, run, "inspect-rotation", { checklist: step.checklist!.map(() => true) }).verdict.ok);
  });

  test("expectedNext reports the active step and missing parts", () => {
    const s = scenario("linear-actuator");
    const run = createRun(s);
    const next = expectedNext(s, run);
    assert.equal(next.step?.id, "place-supports");
    assert.deepEqual(next.partIds, ["rail-support-a", "rail-support-b"]);
    const after = attemptPlace(s, run, "rail-support-a", seated(s, "rail-support-a")).run;
    assert.deepEqual(expectedNext(s, after).partIds, ["rail-support-b"]);
  });
});
