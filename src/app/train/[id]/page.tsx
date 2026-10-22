import type { Metadata } from "next";
import { Trainer } from "@/components/forge/trainer/Trainer";

export const metadata: Metadata = { title: "Training · SpatialForge" };

export default async function TrainScenarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Trainer id={decodeURIComponent(id)} />;
}
