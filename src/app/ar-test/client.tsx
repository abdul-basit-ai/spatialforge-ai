"use client";
import { ARAssist, ARTrainer } from "@/components/forge/ARModes";
import { useForgeRun } from "@/lib/forge/run-store";
import type { ForgeScenario } from "@/lib/forge/types";

(globalThis as unknown as { __forgeRun: typeof useForgeRun }).__forgeRun = useForgeRun;
export default function Client({ scenario, mode }: { scenario: ForgeScenario; mode: string }) {
  const exit = () => { (window as unknown as { __exited: boolean }).__exited = true; };
  return mode === "assist" ? <ARAssist scenario={scenario} onExit={exit} operatorId="ar-test" /> : <ARTrainer scenario={scenario} onExit={exit} operatorId="ar-test" />;
}
