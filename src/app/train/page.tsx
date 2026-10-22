import type { Metadata } from "next";
import { Gallery } from "@/components/forge/trainer/Gallery";

export const metadata: Metadata = { title: "Train · SpatialForge", description: "Assembly training scenarios" };

export default function TrainPage() {
  return <Gallery />;
}
