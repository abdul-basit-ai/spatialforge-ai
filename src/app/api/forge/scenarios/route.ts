import { NextResponse } from "next/server";
import { listAll } from "./_lib/store";

export const dynamic = "force-dynamic";

// GET /api/forge/scenarios[?published=1] -> { scenarios: ListedScenario[] } (stored scenarios merged with builtins).
export async function GET(request: Request) {
  const publishedOnly = ["1", "true"].includes(new URL(request.url).searchParams.get("published") ?? "");
  return NextResponse.json({ scenarios: await listAll(publishedOnly) });
}
