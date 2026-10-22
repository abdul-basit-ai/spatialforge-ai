import type { Metadata } from "next";
import { ForgeNav } from "@/components/forge/trainer/ForgeNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpatialForge AI",
  description: "Assembly training and live assist for mechanical and mechatronic hardware",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body suppressHydrationWarning><ForgeNav />{children}</body></html>;
}
