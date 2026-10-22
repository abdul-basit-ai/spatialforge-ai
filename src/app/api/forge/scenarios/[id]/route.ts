import { NextResponse } from "next/server";
import { saveScenario } from "@/lib/forge/repo";
import { validateScenario } from "@/lib/forge/validate";
import { MAX_BODY_BYTES, parseScenario } from "../_lib/schema";
import { draftVersion, failure, publishedVersion, resolveScenario, validId } from "../_lib/store";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// GET /api/forge/scenarios/<id>[?version=N][&published=1] -> { scenario, builtin, stored, publishedVersion, unpublished }
// ?published=1 (trainees) prefers the latest published version and falls back to the latest draft (unpublished: true);
// add &strict=1 to get a 404 instead.
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: "Invalid scenario id" }, { status: 400 });
  const search = new URL(request.url).searchParams;
  const version = Number(search.get("version")) || undefined;
  const flag = (name: string) => ["1", "true"].includes(search.get(name) ?? "");
  const publishedOnly = flag("published");
  try {
    let found = await resolveScenario(id, { version, publishedOnly });
    if (!found && publishedOnly && !flag("strict")) found = await resolveScenario(id, { version });
    if (!found) return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
    return NextResponse.json({ ...found, publishedVersion: await publishedVersion(id), unpublished: found.scenario.status !== "published" });
  } catch (error) { return failure("get failed", error); }
}

// PUT /api/forge/scenarios/<id> body: ForgeScenario (or { scenario }) -> saves a draft; builtins are forked into the DB here.
export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: "Invalid scenario id" }, { status: 400 });
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "Scenario too large" }, { status: 413 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = parseScenario(body && "scenario" in body ? body.scenario : body);
  if (!parsed.ok) return NextResponse.json(parsed, { status: 400 });
  if (parsed.scenario.id !== id) return NextResponse.json({ error: "Scenario id does not match the URL" }, { status: 400 });
  try {
    const draft = { ...parsed.scenario, status: "draft" as const, version: await draftVersion(id, parsed.scenario.version) };
    draft.issues = validateScenario(draft);
    const saved = await saveScenario(draft);
    return NextResponse.json({ scenario: saved, issues: saved.issues });
  } catch (error) { return failure("save failed", error); }
}
