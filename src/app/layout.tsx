import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpatialForge AI",
  description: "Gesture guided spatial assembly workbench",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
