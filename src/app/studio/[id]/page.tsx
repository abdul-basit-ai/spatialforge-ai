import type { Metadata } from "next";
import ScenarioEditor from "@/components/forge/editor/ScenarioEditor";

export const metadata: Metadata = { title: "Forge Studio · Scenario editor" };

export default async function StudioScenarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScenarioEditor id={decodeURIComponent(id)} />;
}
