import { aiJson, MODEL, openaiConfigured, type InputPart } from "@/lib/ai/openai";
import { attachAssets, getScenario, saveAsset, saveScenario, slugify } from "../repo";
import type { ForgeScenario, ForgeSource } from "../types";
import { BUILTIN_SCENARIOS } from "../samples";
import { validateScenario } from "../validate";
import { cadSkeleton, mergeCadDraft, scenarioFromGenerated, toGeneratedDraft } from "./build";
import { convertCad } from "./cad-convert";
import { gatherEvidence, type Evidence } from "./evidence";
import { geometryWarnings } from "./geometry-check";
import { normalizeScenario } from "./normalize";
import { CAD_INSTRUCTIONS, GENERATE_INSTRUCTIONS, REPAIR_INSTRUCTIONS } from "./prompts";
import { CadDraftSchema, GeneratedDraftSchema, type GeneratedDraft } from "./schemas";
import { planSequence } from "./sequence";
import { CompileLog, type CadInput, type CompileRequest, type CompileResult } from "./types";
import { findWebCad, type WebSearchOutcome } from "./web";

export { planSequence } from "./sequence";
export { CompileRequestSchema, CompileLog } from "./types";

export class CompileError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const round3 = (v: number) => Math.round(v * 1000);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function requestText(req: CompileRequest, evidence: Evidence) {
  const lines = [
    req.prompt ? `Request: ${req.prompt}` : "Request: build the assembly-training scenario for the attached material.",
    req.domain ? `Domain: ${req.domain}` : "",
    req.notes ? `Author notes: ${req.notes}` : "",
    evidence.files.length ? `Attached files: ${evidence.files.map((f) => `${f.name} (${f.mime})`).join(", ")}` : "",
    evidence.text ? `Extracted manual text:\n${evidence.text}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

// The model's draft for the no-CAD case (prompt, manual, photos), with parametric primitives.
async function generateDraft(req: CompileRequest, evidence: Evidence, log: CompileLog, timeoutMs: number) {
  const input: InputPart[] = [{ type: "input_text", text: requestText(req, evidence) }, ...evidence.media];
  log.add(`Designing the assembly with ${MODEL} (reasoning medium)${evidence.media.length ? ` from ${evidence.media.length} attached file(s)` : ""}.`);
  const result = await aiJson("forge-compile-generate", GeneratedDraftSchema, GENERATE_INSTRUCTIONS, input, { model: MODEL, reasoning: "medium", maxOutputTokens: 32000, timeoutMs });
  log.add(result.ok ? `Draft: ${result.data.parts.length} parts, ${result.data.steps.length} steps in ${secs(result.ms)}.` : `Generation failed after ${secs(result.ms)}: ${result.error}`);
  return result;
}

async function repairGenerated(draft: GeneratedDraft, problems: string[], blocking: boolean, log: CompileLog) {
  const timeoutMs = Math.min(110000, log.remaining() - 12000);
  if (timeoutMs < (blocking ? 35000 : 70000)) { log.add("Not enough time left for an AI repair pass."); return null; }
  log.add(`Repair pass for ${problems.length} problem(s).`);
  const result = await aiJson("forge-compile-repair", GeneratedDraftSchema, REPAIR_INSTRUCTIONS, `Problems to fix:\n- ${problems.join("\n- ")}\n\nDraft JSON:\n${JSON.stringify(draft)}`, { model: MODEL, reasoning: "low", maxOutputTokens: 32000, timeoutMs });
  log.add(result.ok ? `Repair returned ${result.data.parts.length} parts, ${result.data.steps.length} steps in ${secs(result.ms)}.` : `Repair failed: ${result.error}`);
  return result.ok ? result.data : null;
}

async function compileCad(req: CompileRequest, cad: CadInput, evidence: Evidence, source: ForgeSource, title: string, log: CompileLog) {
  const plan = planSequence(cad.parts);
  for (const note of plan.notes) log.add(note);
  log.add(`Install order (reverse of the disassembly): ${plan.steps.map((s) => (s.kind === "place" ? s.nodes[0] : `[${s.nodes.length} ${s.family}]`)).join(" -> ")}.`);
  const skeleton = cadSkeleton(cad, plan, { title, domain: req.domain, source });
  if (!openaiConfigured()) { log.add("OpenAI not configured: using the deterministic CAD procedure text."); return skeleton.scenario; }
  const table = cad.parts.map((p) => ({ id: skeleton.partIdByNode.get(p.node), node: p.node, sizeMm: [0, 1, 2].map((k) => round3(Math.abs(p.bbox.max[k] - p.bbox.min[k]))), centerMm: p.position.map(round3), insertAxis: plan.axes[p.node], triangles: p.triangles }));
  const steps = skeleton.skeletonSteps.map((s) => ({ id: s.id, kind: s.kind, partIds: s.partIds, draftTitle: s.title }));
  const input: InputPart[] = [{ type: "input_text", text: `${requestText(req, evidence)}\n\nCAD parts (assembly frame, Y-up, millimetres):\n${JSON.stringify(table)}\n\nBase part (already in place): ${skeleton.scenario.baseParts[0]}\n\nSkeleton steps in the fixed order:\n${JSON.stringify(steps)}` }, ...evidence.media];
  const timeoutMs = Math.min(150000, log.remaining() - 20000);
  if (timeoutMs < 30000) { log.add("Not enough time left to write the procedure with AI; keeping the deterministic text."); return skeleton.scenario; }
  log.add(`Writing the procedure with ${MODEL} (reasoning medium) around ${steps.length} fixed steps.`);
  const result = await aiJson("forge-compile-cad", CadDraftSchema, CAD_INSTRUCTIONS, input, { model: MODEL, reasoning: "medium", maxOutputTokens: 32000, timeoutMs });
  if (!result.ok) { log.add(`Procedure writing failed (${result.error}); keeping the deterministic text.`); return skeleton.scenario; }
  const merged = mergeCadDraft(skeleton, result.data);
  log.add(`Procedure merged in ${secs(result.ms)}: ${merged.extras} extra step(s) added${merged.dropped ? `, ${merged.dropped} invented install step(s) dropped` : ""}.`);
  if (result.data.notes) merged.scenario.source = { ...merged.scenario.source, notes: [merged.scenario.source.notes, result.data.notes].filter(Boolean).join(" ") };
  return merged.scenario;
}

// Keyword overlap between the prompt and the built-in scenarios (used only when OpenAI is not configured).
const STOP = new Set(["the", "and", "with", "for", "how", "train", "teach", "assemble", "assembly", "build", "small", "this", "that"]);
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
function closestBuiltin(prompt: string): ForgeScenario | null {
  const wanted = words(prompt);
  const scored = BUILTIN_SCENARIOS.map((s) => ({ s, n: [...words(`${s.id.replace(/-/g, " ")} ${s.title} ${s.summary}`)].filter((w) => wanted.has(w)).length })).filter((x) => x.n > 0);
  return scored.sort((a, b) => b.n - a.n)[0]?.s ?? null;
}

async function uniqueId(title: string, req: CompileRequest): Promise<{ id: string; version: number }> {
  if (req.scenarioId) {
    const existing = await getScenario(slugify(req.scenarioId));
    if (existing) return { id: existing.id, version: existing.version + 1 };
  }
  const base = slugify(title);
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base.slice(0, 56)}-${n}`;
    if (!(await getScenario(id))) return { id, version: 1 };
  }
  return { id: `${base.slice(0, 50)}-${Date.now().toString(36)}`, version: 1 };
}

export async function compileScenario(req: CompileRequest, log = new CompileLog(), createdBy?: string): Promise<CompileResult & { saved: boolean }> {
  const ai = openaiConfigured();
  const evidence = await gatherEvidence(req.assets, log);
  const attach = new Set(req.assets.map((a) => a.id));
  let citations: Array<{ title: string; url: string }> = [];
  let cad: CadInput | null = req.cad?.parts.length ? { assetId: req.cad.assetId, parts: req.cad.parts } : null;
  let source: ForgeSource = { kind: "upload", files: evidence.files, ...(req.prompt ? { prompt: req.prompt } : {}), approximation: !cad, notes: "" };
  if (cad) { attach.add(cad.assetId); log.add(`CAD part list: ${cad.parts.length} parts.`); }

  // Raw CAD uploads that the browser did not parse: convert on the server.
  if (!cad && evidence.cadFiles.length) {
    const file = evidence.cadFiles[0];
    try {
      const converted = await convertCad(file.bytes, file.name, file.format, Math.min(120000, Math.max(20000, log.remaining() - 90000)));
      converted.notes.forEach((n) => log.add(n));
      const assetId = await saveAsset({ name: `${file.name.replace(/\.[^.]+$/, "")}.glb`, mime: "model/gltf-binary", bytes: converted.glb, meta: { sourceAssetId: file.assetId, format: file.format, parts: converted.parts.length } });
      cad = { assetId, parts: converted.parts }; attach.add(assetId);
      source = { ...source, approximation: false };
      log.add(`Converted ${file.name} to GLB: ${converted.parts.length} parts.`);
    } catch (error) { log.add(`CAD conversion of ${file.name} failed: ${(error as Error).message}`); }
  }

  const promptOnly = !req.assets.length && !cad;
  if (promptOnly && !req.prompt?.trim()) throw new CompileError("Provide a prompt, files or a CAD part list.");
  let draft: ForgeScenario | null = null;
  if (!cad && !ai) {
    // No OpenAI: a prompt can still start from the closest built-in scenario; anything else needs CAD.
    const builtin = promptOnly ? closestBuiltin(req.prompt!) : null;
    if (!builtin) throw new CompileError("OpenAI is not configured; without it only CAD imports (or prompts matching a built-in scenario) can be compiled.", 503);
    log.add(`OpenAI not configured: starting from the built-in "${builtin.title}" scenario.`);
    draft = { ...structuredClone(builtin), source: { ...builtin.source, prompt: req.prompt, notes: `Copied from the built-in "${builtin.title}" scenario (OpenAI not configured).` } };
  }

  let assumptions: string[] = [];
  let generation: ReturnType<typeof generateDraft> | null = null;
  if (promptOnly && !draft) {
    // Search for open CAD and design from knowledge in parallel; open CAD wins when it downloads and parses.
    generation = generateDraft(req, evidence, log, Math.min(145000, log.remaining() - 30000));
    const web: WebSearchOutcome = await findWebCad(req.prompt!, log);
    citations = web.citations;
    if (web.cad) {
      const assetId = await saveAsset({ name: web.cad.fileName.replace(/\.[^.]+$/, "") + ".glb", mime: "model/gltf-binary", bytes: web.cad.converted.glb, meta: { url: web.cad.url, license: web.cad.license, format: web.cad.converted.format, parts: web.cad.converted.parts.length } });
      web.cad.converted.notes.forEach((n) => log.add(n));
      cad = { assetId, parts: web.cad.converted.parts }; attach.add(assetId);
      source = { kind: "web", prompt: req.prompt, urls: [{ title: web.cad.title, url: web.cad.url, license: web.cad.license }, ...citations.filter((c) => c.url !== web.cad!.url).slice(0, 8)], approximation: false, notes: `CAD downloaded from ${new URL(web.cad.url).hostname} (${web.cad.license}); install order computed by disassembly analysis.` };
    } else {
      source = { kind: "generated", prompt: req.prompt, ...(citations.length ? { urls: citations.slice(0, 10) } : {}), approximation: true, notes: `No directly downloadable open CAD was usable (${web.tried.length} tried); geometry and procedure generated from engineering knowledge.` };
    }
  }

  if (cad) {
    const fileTitle = evidence.files.find((f) => f.assetId === cad!.assetId)?.name?.replace(/\.[^.]+$/, "");
    const title = req.prompt?.trim() ? req.prompt.trim().replace(/^(train me (to|on)|teach me (to|how to)|how to)\s+/i, "").replace(/^(assemble|build)\s+(an?\s+|the\s+)?/i, "").replace(/^./, (c) => c.toUpperCase()).slice(0, 80) : fileTitle || "Imported assembly";
    if (source.kind === "upload") source.notes = "Install order computed by disassembly analysis of the CAD bounding boxes.";
    draft = await compileCad(req, cad, evidence, source, title, log);
  } else if (!draft) {
    let result = generation ? await generation : await generateDraft(req, evidence, log, Math.min(145000, log.remaining() - 30000));
    if (!result.ok && log.remaining() > 55000) {
      log.add("Retrying the design once with low reasoning effort.");
      result = await aiJson("forge-compile-generate-retry", GeneratedDraftSchema, GENERATE_INSTRUCTIONS, [{ type: "input_text", text: requestText(req, evidence) }, ...evidence.media], { model: MODEL, reasoning: "low", maxOutputTokens: 32000, timeoutMs: log.remaining() - 12000 });
      log.add(result.ok ? `Retry draft: ${result.data.parts.length} parts, ${result.data.steps.length} steps in ${secs(result.ms)}.` : `Retry failed: ${result.error}`);
    }
    if (!result.ok) throw new CompileError(`Scenario generation failed: ${result.error}`, 502);
    assumptions = result.data.assumptions;
    if (source.kind === "upload") source = { ...source, approximation: true, notes: "Geometry estimated from the manual/photos as parametric parts." };
    source = { ...source, notes: [source.notes, assumptions.length ? `Assumed: ${assumptions.join("; ")}` : ""].filter(Boolean).join(" ").slice(0, 2000) };
    draft = scenarioFromGenerated(result.data, { domain: req.domain, source });
  }

  // Post-process, validate, one repair pass, validate again.
  let scenario = normalizeScenario(draft);
  let issues = validateScenario(scenario);
  let warnings = cad ? [] : geometryWarnings(scenario);
  log.add(`Validation: ${issues.length} issue(s)${warnings.length ? `, ${warnings.length} geometry warning(s)` : ""}.`);
  if ((issues.length || warnings.length) && !cad && ai) {
    const repaired = await repairGenerated(toGeneratedDraft(scenario, assumptions), [...issues, ...warnings], issues.length > 0, log);
    if (repaired) {
      const candidate = normalizeScenario(scenarioFromGenerated(repaired, { domain: req.domain, source: scenario.source }));
      const candidateIssues = validateScenario(candidate), candidateWarnings = geometryWarnings(candidate);
      if (candidateIssues.length + candidateWarnings.length <= issues.length + warnings.length) { scenario = candidate; issues = candidateIssues; warnings = candidateWarnings; }
      log.add(`After repair: ${candidateIssues.length} issue(s), ${candidateWarnings.length} geometry warning(s)${scenario === candidate ? "" : "; kept the original"}.`);
    }
  }
  if (warnings.length) log.add(`Geometry warnings: ${warnings.slice(0, 5).join(" | ")}`);

  const { id, version } = await uniqueId(scenario.title, req).catch(() => ({ id: slugify(scenario.title), version: 1 }));
  scenario = { ...scenario, id, version, status: "draft", issues };
  let saved = false;
  try {
    scenario = await saveScenario(scenario, createdBy);
    await attachAssets([...attach].filter((a) => /^[0-9a-f-]{36}$/i.test(a)), scenario.id);
    saved = true;
    log.add(`Saved draft ${scenario.id} v${scenario.version}: ${scenario.parts.length} parts, ${scenario.steps.length} steps, source ${scenario.source.kind}.`);
  } catch (error) { log.add(`Saving failed: ${(error as Error).message}`); }
  return { scenario, issues, log: log.lines, ms: log.elapsed(), citations, saved };
}
