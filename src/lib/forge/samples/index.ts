import type { ForgeScenario } from "../types";
import { linearActuator } from "./linear-actuator";
import { planetaryGearbox } from "./planetary-gearbox";
import { pneumaticValve } from "./pneumatic-valve";
import { pneumaticCylinder } from "./pneumatic-cylinder";
import { centrifugalPump } from "./centrifugal-pump";

// Built-in scenarios (always available, even without a database). The linear actuator is the hero demo.
export const BUILTIN_SCENARIOS: ForgeScenario[] = [linearActuator, pneumaticValve, pneumaticCylinder, centrifugalPump, planetaryGearbox];

export const builtinScenario = (id: string) => BUILTIN_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
