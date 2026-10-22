import type { ForgeScenario } from "../types";
import { linearActuator } from "./linear-actuator";
import { planetaryGearbox } from "./planetary-gearbox";
import { pneumaticValve } from "./pneumatic-valve";

// Built-in scenarios (always available, even without a database). The linear actuator is the hero demo.
export const BUILTIN_SCENARIOS: ForgeScenario[] = [linearActuator, pneumaticValve, planetaryGearbox];

export const builtinScenario = (id: string) => BUILTIN_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
