import type { ForgeScenario } from "../types";

// Built-in scenarios (always available, even without a database). Contract stub: the engine agent fills these in.
export const BUILTIN_SCENARIOS: ForgeScenario[] = [];

export const builtinScenario = (id: string) => BUILTIN_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
