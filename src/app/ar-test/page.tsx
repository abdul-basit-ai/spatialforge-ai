// TEMPORARY test harness for the AR role (not committed).
import { getScenario } from "@/lib/forge/repo";
import Client from "./client";

export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ id?: string; mode?: string }> }) {
  const { id = "editor-test-mvjeycxb", mode = "train" } = await searchParams;
  const scenario = await getScenario(id);
  if (!scenario) return <p>not found</p>;
  return <Client scenario={scenario} mode={mode} />;
}
