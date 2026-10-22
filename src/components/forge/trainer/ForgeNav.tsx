"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [{ href: "/train", label: "Train" }, { href: "/studio", label: "Studio" }, { href: "/admin", label: "Admin" }, { href: "/", label: "Legacy demo" }];

// Slim global nav (root layout). The legacy tray/valve page keeps its own top bar underneath.
export function ForgeNav() {
  const path = usePathname() ?? "/";
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="forge-nav" aria-label="Primary">
      <Link href="/train" className="forge-nav-brand"><span className="forge-nav-mark">◆</span>Spatial<b>Forge</b></Link>
      <div className="forge-nav-links">
        {LINKS.map((link) => <Link key={link.href} href={link.href} className={active(link.href) ? "is-active" : ""}>{link.label}</Link>)}
      </div>
    </nav>
  );
}
