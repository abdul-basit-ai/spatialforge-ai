"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportedAssembly, UploadedAsset, Units } from "@/lib/forge/import";
import { classifyFile, MAX_TOTAL_BYTES } from "@/lib/forge/import/policy";
import { BUILTIN_SCENARIOS } from "@/lib/forge/samples";
import { validateScenario } from "@/lib/forge/validate";
import type { ForgeScenario } from "@/lib/forge/types";

// Forge Studio: drop CAD / manuals / photos or just describe the job, then compile a training scenario.
// CAD is parsed in the browser (OpenCascade wasm + three loaders), exported as one GLB, uploaded, then compiled server-side.

const CadPreview = dynamic(() => import("@/lib/forge/import/CadPreview"), { ssr: false, loading: () => <div className="st-preview-empty">Loading viewer...</div> });

type Picked = { key: string; file: File; role: "cad" | "mesh" | "pdf" | "image" };
type StageKey = "parse" | "upload" | "compile" | "validate";
type StageState = { state: "idle" | "active" | "done" | "error" | "skip"; detail?: string };
type Summary = { id: string; version: number; status: string; title: string; summary: string; domain: string; parts: number; steps: number; source: string; updatedAt: string };

const STAGES: Array<{ key: StageKey; label: string }> = [
  { key: "parse", label: "Parsing CAD" },
  { key: "upload", label: "Uploading" },
  { key: "compile", label: "Compiling with AI" },
  { key: "validate", label: "Validating" },
];
const IDEAS = ["Assemble a NEMA17 linear actuator", "Train me to assemble a planetary gearbox", "Rebuild a pillow block bearing on a shaft", "Assemble a 2-axis servo pan-tilt bracket", "Service a 3D printer hotend"];
const ACCEPT = ".step,.stp,.iges,.igs,.brep,.stl,.obj,.glb,.pdf,.png,.jpg,.jpeg,.webp,.sldprt,.sldasm";
const SAMPLE = { url: "/samples/as1-bracket-assembly.stp", name: "as1-bracket-assembly.stp", prompt: "Assemble the AS1 bracket assembly: two L-brackets bolted to a base plate, then the rod with its nuts", notes: "CAx-IF AS1 test assembly. Bolts go through the bracket feet into the plate; nuts on the underside." };

const mb = (bytes: number) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const roleLabel: Record<Picked["role"], string> = { cad: "CAD", mesh: "MESH", pdf: "PDF", image: "IMG" };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function StudioPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [domain, setDomain] = useState<"mechanical" | "mechatronic">("mechanical");
  const [notes, setNotes] = useState("");
  const [units, setUnits] = useState<Units>("auto");
  const [files, setFiles] = useState<Picked[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [assembly, setAssembly] = useState<ImportedAssembly | null>(null);
  const [parsing, setParsing] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);
  const [stages, setStages] = useState<Record<StageKey, StageState>>({ parse: { state: "idle" }, upload: { state: "idle" }, compile: { state: "idle" }, validate: { state: "idle" } });
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [scenarios, setScenarios] = useState<Summary[] | null>(null);
  const [listNote, setListNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const parseRun = useRef(0);

  const cadFiles = useMemo(() => files.filter((item) => item.role === "cad" || item.role === "mesh"), [files]);
  const docFiles = useMemo(() => files.filter((item) => item.role === "pdf" || item.role === "image"), [files]);
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  const stage = (key: StageKey, value: StageState) => setStages((current) => ({ ...current, [key]: value }));

  // Scenario library: editor API when present, built-ins otherwise. Also warms the CAD engine for the first drop.
  useEffect(() => {
    const warm = setTimeout(() => { void import("@/lib/forge/import/occt").then((m) => m.warmCadEngine()); }, 400);
    const builtins: Summary[] = BUILTIN_SCENARIOS.map((s) => ({ id: s.id, version: s.version, status: s.status, title: s.title, summary: s.summary, domain: s.domain, parts: s.parts.length, steps: s.steps.length, source: s.source.kind, updatedAt: s.updatedAt }));
    fetch("/api/forge/scenarios", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then((json: Summary[] | { scenarios?: Summary[] }) => {
        const list = Array.isArray(json) ? json : json.scenarios ?? [];
        setScenarios([...list, ...builtins.filter((b) => !list.some((s) => s.id === b.id))]);
      })
      .catch(() => { setScenarios(builtins); setListNote("Scenario library offline; showing built-in scenarios."); });
    return () => clearTimeout(warm);
  }, []);

  // Re-parse whenever the CAD set or unit choice changes.
  useEffect(() => {
    const run = ++parseRun.current;
    setSelected(null);
    if (!cadFiles.length) { setAssembly(null); setParseError(null); setParsing(null); stage("parse", { state: "idle" }); return; }
    setParsing("Starting the CAD engine"); setParseError(null);
    stage("parse", { state: "active", detail: `${cadFiles.length} file${cadFiles.length > 1 ? "s" : ""}` });
    const started = performance.now();
    import("@/lib/forge/import")
      .then(({ parseCadFiles }) => parseCadFiles(cadFiles.map((item) => item.file), { units, onFile: (name) => { if (run === parseRun.current) setParsing(`Tessellating ${name}`); } }))
      .then((result) => {
        if (run !== parseRun.current) return;
        setAssembly(result); setParsing(null);
        stage("parse", { state: "done", detail: `${result.parts.length} parts, ${result.triangles.toLocaleString()} triangles, ${((performance.now() - started) / 1000).toFixed(1)} s` });
      })
      .catch((error) => {
        if (run !== parseRun.current) return;
        setAssembly(null); setParsing(null); setParseError(message(error));
        stage("parse", { state: "error", detail: message(error) });
      });
  }, [cadFiles, units]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  const addFiles = useCallback((list: FileList | File[]) => {
    const accepted: Picked[] = [], errors: string[] = [];
    for (const file of Array.from(list)) {
      const kind = classifyFile(file.name, file.size);
      if ("error" in kind) errors.push(kind.error);
      else accepted.push({ key: `${file.name}:${file.size}:${file.lastModified}`, file, role: kind.role });
    }
    setRejected(errors);
    if (accepted.length) setFiles((current) => [...current, ...accepted.filter((item) => !current.some((c) => c.key === item.key))]);
  }, []);

  const loadSample = async () => {
    try {
      const response = await fetch(SAMPLE.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      addFiles([new File([await response.blob()], SAMPLE.name, { type: "model/step" })]);
      if (!prompt) setPrompt(SAMPLE.prompt);
      if (!notes) setNotes(SAMPLE.notes);
    } catch (error) { setRejected([`Could not load the sample: ${message(error)}`]); }
  };

  const canBuild = !running && !parsing && (prompt.trim().length >= 3 || files.length > 0) && !(cadFiles.length && !assembly) && totalBytes <= MAX_TOTAL_BYTES * 1.5;

  async function build() {
    setRunning(true); setRunError(null); setElapsed(0);
    stage("upload", { state: "idle" }); stage("compile", { state: "idle" }); stage("validate", { state: "idle" });
    if (!cadFiles.length) stage("parse", { state: "skip", detail: "No CAD files" });
    let current: StageKey = "upload";
    try {
      const lib = await import("@/lib/forge/import");
      stage("upload", { state: "active", detail: "Packing assembly" });
      const assets: UploadedAsset[] = [];
      let cad: { assetId: string; parts: ImportedAssembly["parts"] } | null = null;
      if (assembly) {
        const glb = await lib.exportAssemblyGlb(assembly);
        const name = `${(cadFiles[0]?.file.name ?? "assembly").replace(/\.[^.]+$/, "")}${cadFiles.length > 1 ? "-merged" : ""}.glb`;
        stage("upload", { state: "active", detail: `Uploading ${name} (${mb(glb.byteLength)})` });
        const [mesh] = await lib.uploadAssets([{ blob: new Blob([glb], { type: "model/gltf-binary" }), name, kind: "mesh" }], { kind: "assembly", sources: cadFiles.map((item) => item.file.name), baseNode: assembly.baseNode, bbox: assembly.bbox, triangles: assembly.triangles, parts: assembly.parts });
        assets.push(mesh);
        cad = { assetId: mesh.id, parts: assembly.parts };
      }
      for (const item of docFiles) {
        stage("upload", { state: "active", detail: `Uploading ${item.file.name}` });
        assets.push(...await lib.uploadAssets([{ blob: item.file, name: item.file.name, kind: item.role as "pdf" | "image" }], { kind: item.role }));
      }
      stage("upload", { state: assets.length ? "done" : "skip", detail: assets.length ? `${assets.length} asset${assets.length > 1 ? "s" : ""} stored` : "Prompt only" });

      current = "compile";
      stage("compile", { state: "active", detail: assets.length ? "Reading parts, manuals and photos" : "Searching for open CAD, then engineering knowledge" });
      const outcome = await lib.compileScenario({ prompt: prompt.trim(), domain, notes: notes.trim(), assets, cad }, (progress) => stage("compile", { state: "active", detail: progress.message ?? progress.stage }));
      stage("compile", { state: "done", detail: outcome.scenario?.title ?? outcome.id });

      current = "validate";
      stage("validate", { state: "active", detail: "Checking mates, steps and dependencies" });
      let scenario = outcome.scenario as ForgeScenario | undefined;
      if (!scenario?.parts || !scenario?.steps) scenario = await fetch(`/api/forge/scenarios/${outcome.id}`).then((r) => (r.ok ? r.json() : null)).then((j) => (j?.scenario ?? j) as ForgeScenario | undefined).catch(() => undefined);
      const issues = scenario?.parts && scenario?.steps ? validateScenario(scenario) : outcome.scenario?.issues ?? [];
      stage("validate", { state: "done", detail: issues.length ? `${issues.length} issue${issues.length > 1 ? "s" : ""} to fix in the editor` : scenario ? `${scenario.parts.length} parts, ${scenario.steps.length} steps, no issues` : "Opening editor" });
      setTimeout(() => router.push(`/studio/${encodeURIComponent(outcome.id)}`), 900);
    } catch (error) {
      stage(current, { state: "error", detail: message(error) });
      setRunError(message(error));
      setRunning(false);
    }
  }

  const selectedPart = assembly?.parts.find((part) => part.node === selected) ?? null;

  return (
    <div className="st-shell">
      <style>{CSS}</style>
      <header className="st-top">
        <Link href="/" className="st-brand"><span className="st-mark">F</span>SPATIAL<b>FORGE</b><em>STUDIO</em></Link>
        <nav><Link href="/studio" className="on">Studio</Link><Link href="/train">Train</Link><Link href="/signin">Sign in</Link></nav>
      </header>

      <main className="st-main">
        <section className="st-intro">
          <div className="st-eyebrow"><i />SCENARIO BUILDER</div>
          <h1>Turn CAD, manuals or a sentence into <span>guided assembly training</span>.</h1>
          <p>Drop a STEP assembly, PDF work instructions or photos of the hardware, or just describe the job. Forge parses the geometry in your browser, compiles mates and steps with AI, and checks every step deterministically before anyone trains on it.</p>
        </section>

        <div className="st-grid">
          <section className="st-panel st-compose">
            <label className="st-label" htmlFor="st-prompt">WHAT SHOULD PEOPLE LEARN?</label>
            <textarea id="st-prompt" className="st-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what to train on, e.g. 'assemble a NEMA17 linear actuator'" rows={3} />
            <div className="st-ideas">{IDEAS.map((idea) => <button key={idea} type="button" onClick={() => setPrompt(idea)}>{idea}</button>)}</div>

            <div className={`st-drop${dragging ? " is-over" : ""}`} role="button" tabIndex={0}
              onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
              <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              <div className="st-drop-icon">⬡</div>
              <strong>Drop CAD, manuals or photos</strong>
              <span>STEP · IGES · BREP · STL · OBJ · GLB · PDF · PNG · JPG — 25 MB per file, 60 MB total</span>
              <small>SolidWorks, Inventor, Fusion: export the assembly as STEP first.</small>
            </div>
            <button type="button" className="st-sample" onClick={loadSample}>Try the sample: CAx-IF AS1 bracket assembly (STEP, 18 parts)</button>

            {rejected.length > 0 && <div className="st-rejected">{rejected.map((text) => <p key={text}>{text}</p>)}<button type="button" onClick={() => setRejected([])}>Dismiss</button></div>}

            {files.length > 0 && (
              <ul className="st-files">
                {files.map((item) => (
                  <li key={item.key}>
                    <span className={`st-chip st-${item.role}`}>{roleLabel[item.role]}</span>
                    <span className="st-file-name">{item.file.name}</span>
                    <span className="st-file-size">{mb(item.file.size)}</span>
                    <button type="button" aria-label={`Remove ${item.file.name}`} disabled={running} onClick={() => setFiles((current) => current.filter((c) => c.key !== item.key))}>×</button>
                  </li>
                ))}
                <li className="st-files-total"><span>{files.length} file{files.length > 1 ? "s" : ""}</span><span className={totalBytes > MAX_TOTAL_BYTES ? "st-over" : ""}>{mb(totalBytes)} of 60 MB</span></li>
              </ul>
            )}

            <div className="st-row">
              <div>
                <span className="st-label">DOMAIN</span>
                <div className="st-toggle">
                  {(["mechanical", "mechatronic"] as const).map((value) => <button type="button" key={value} className={domain === value ? "on" : ""} onClick={() => setDomain(value)}>{value === "mechanical" ? "Mechanical" : "Mechatronic"}</button>)}
                </div>
              </div>
              <div>
                <span className="st-label">CAD UNITS</span>
                <select className="st-select" value={units} onChange={(e) => setUnits(e.target.value as Units)}>
                  <option value="auto">Auto-detect</option><option value="mm">Millimetres</option><option value="cm">Centimetres</option><option value="m">Metres</option><option value="in">Inches</option>
                </select>
              </div>
            </div>
            <label className="st-label" htmlFor="st-notes">NOTES FOR THE COMPILER</label>
            <textarea id="st-notes" className="st-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Torque specs, the tools on your bench, steps to stress, parts that are already installed..." />

            <button type="button" className="st-build" disabled={!canBuild} onClick={build}>
              {running ? `Building scenario... ${elapsed}s` : files.length ? "Build training scenario" : "Generate scenario from prompt"}
            </button>
            {!files.length && prompt.trim().length >= 3 && !running && <p className="st-hint">No files: Forge will search the web for an openly licensed CAD model, then fall back to engineering knowledge (marked as approximate).</p>}

            {(running || runError || Object.values(stages).some((s) => s.state !== "idle")) && (
              <ol className="st-stages">
                {STAGES.map(({ key, label }) => (
                  <li key={key} className={`is-${stages[key].state}`}>
                    <span className="st-dot" />
                    <div><strong>{label}</strong>{stages[key].detail && <small>{stages[key].detail}</small>}</div>
                  </li>
                ))}
              </ol>
            )}
            {runError && <div className="st-error"><strong>Build stopped.</strong> {runError}</div>}
          </section>

          <section className="st-panel st-view">
            <div className="st-view-head">
              <span className="st-label">ASSEMBLY PREVIEW</span>
              {assembly && <span className="st-meta">{assembly.parts.length} parts · {Math.round((assembly.bbox.max[0] - assembly.bbox.min[0]) * 1000)}×{Math.round((assembly.bbox.max[1] - assembly.bbox.min[1]) * 1000)}×{Math.round((assembly.bbox.max[2] - assembly.bbox.min[2]) * 1000)} mm</span>}
            </div>
            <div className="st-canvas">
              {assembly ? <CadPreview group={assembly.group} explode={explode} selected={selected} onSelect={setSelected} />
                : <div className="st-preview-empty">{parsing ? <><span className="st-spinner" />{parsing}...</> : parseError ? <span className="st-bad">{parseError}</span> : "Drop a STEP, IGES, STL, OBJ or GLB file to see it here."}</div>}
              {assembly && (
                <div className="st-explode"><span>EXPLODE</span><input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} /></div>
              )}
              {selectedPart && (
                <div className="st-inspect">
                  <strong>{selectedPart.name}</strong>
                  <span>{selectedPart.size.map((n) => (n * 1000).toFixed(1)).join(" × ")} mm · {selectedPart.triangles.toLocaleString()} tris</span>
                  {selectedPart.path && selectedPart.path.length > 0 && <span>{selectedPart.path.join(" / ")}</span>}
                  {selectedPart.node === assembly?.baseNode && <em>Base part (origin)</em>}
                </div>
              )}
            </div>
            {assembly && assembly.warnings.length > 0 && <div className="st-warn">{assembly.warnings.map((w) => <p key={w}>{w}</p>)}</div>}
            {assembly && (
              <ul className="st-parts">
                {assembly.parts.map((part) => (
                  <li key={part.node} className={part.node === selected ? "on" : ""} onClick={() => setSelected(part.node === selected ? null : part.node)}>
                    <span className="st-swatch" style={{ background: part.color }} />
                    <span className="st-part-name">{part.name}{part.node === assembly.baseNode && <em>BASE</em>}</span>
                    <span className="st-part-size">{Math.max(...part.size).toFixed(3)} m</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="st-library">
          <div className="st-lib-head">
            <div><div className="st-eyebrow"><i />SCENARIO LIBRARY</div><h2>Existing scenarios</h2></div>
            {listNote && <span className="st-meta">{listNote}</span>}
          </div>
          {scenarios === null ? <p className="st-muted">Loading scenarios...</p> : scenarios.length === 0 ? <p className="st-muted">No scenarios yet. Build the first one above.</p> : (
            <div className="st-cards">
              {scenarios.map((s) => (
                <article key={s.id} className="st-card">
                  <div className="st-card-top"><span className={`st-status st-${s.status}`}>{s.status.toUpperCase()}</span><span className="st-meta">v{s.version} · {s.domain}</span></div>
                  <h3>{s.title}</h3>
                  <p>{s.summary}</p>
                  <div className="st-card-stats"><span><b>{s.parts}</b> parts</span><span><b>{s.steps}</b> steps</span><span>{s.source}</span></div>
                  <div className="st-card-actions"><Link href={`/studio/${encodeURIComponent(s.id)}`}>Edit</Link><Link href={`/train/${encodeURIComponent(s.id)}`} className="primary">Train</Link></div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

const CSS = `
.st-shell{--st-bg:#090d12;--st-panel:#0f151c;--st-panel2:#131c25;--st-line:#223040;--st-text:#e8eef4;--st-muted:#8b9bab;--st-amber:#ffb547;--st-cyan:#5ee7ff;--st-red:#ff7a6b;--st-green:#7ef0a8;min-height:100vh;color:var(--st-text);background:radial-gradient(circle at 85% -10%,#1d3442 0,transparent 38rem),radial-gradient(circle at 0% 110%,#3a2a12 0,transparent 32rem),linear-gradient(160deg,#080b10,#0b1118 60%,#080b10)}
.st-top{height:64px;padding:0 max(24px,calc((100vw - 1400px)/2));display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1c2733;background:#080c11cc;backdrop-filter:blur(8px);position:sticky;top:0;z-index:5}
.st-brand{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:.06em;font-size:14px}.st-brand b{color:var(--st-amber)}.st-brand em{font:500 10px 'DM Mono',monospace;font-style:normal;color:var(--st-cyan);border:1px solid #2a4a58;padding:3px 6px;border-radius:4px;margin-left:4px}
.st-mark{width:30px;height:30px;display:grid;place-items:center;border-radius:7px;background:linear-gradient(135deg,var(--st-amber),#ff8a3d);color:#1a1006;font-weight:900}
.st-top nav{display:flex;gap:6px}.st-top nav a{font:500 11px 'DM Mono',monospace;letter-spacing:.08em;color:var(--st-muted);padding:7px 12px;border-radius:6px;text-transform:uppercase}.st-top nav a:hover{color:var(--st-text);background:#131c25}.st-top nav a.on{color:var(--st-amber);background:#1d1a12}
.st-main{max-width:1400px;margin:0 auto;padding:34px 24px 64px}
.st-eyebrow{font:500 10px 'DM Mono',monospace;letter-spacing:.18em;color:var(--st-cyan)}.st-eyebrow i{display:inline-block;width:22px;height:1px;background:var(--st-cyan);vertical-align:middle;margin-right:8px}
.st-intro h1{font-size:clamp(28px,3.6vw,48px);line-height:1.08;letter-spacing:-.045em;margin:12px 0 10px;max-width:940px;font-weight:800}.st-intro h1 span{color:var(--st-amber)}
.st-intro p{color:var(--st-muted);max-width:760px;font-size:14px;line-height:1.7;margin:0 0 26px}
.st-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:18px;align-items:start}
@media (max-width:1000px){.st-grid{grid-template-columns:1fr}}
.st-panel{background:linear-gradient(180deg,var(--st-panel2),var(--st-panel));border:1px solid var(--st-line);border-radius:14px;padding:20px;box-shadow:0 20px 50px #0007}
.st-label{display:block;font:500 10px 'DM Mono',monospace;letter-spacing:.16em;color:var(--st-muted);margin:0 0 8px}
.st-prompt,.st-notes{width:100%;resize:vertical;background:#0a0f15;border:1px solid var(--st-line);border-radius:10px;color:var(--st-text);padding:14px 16px;font:500 16px Manrope,sans-serif;outline:none;transition:border-color .15s,box-shadow .15s}
.st-prompt{font-size:18px;min-height:92px}.st-notes{font-size:14px}
.st-prompt:focus,.st-notes:focus{border-color:var(--st-amber);box-shadow:0 0 0 3px #ffb54722}
.st-ideas{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 18px}.st-ideas button{background:#111a23;border:1px solid #243444;color:#b9c7d4;border-radius:999px;padding:5px 11px;font-size:12px}.st-ideas button:hover{border-color:var(--st-cyan);color:var(--st-cyan)}
.st-drop{border:1.5px dashed #34506a;border-radius:12px;padding:24px 16px;text-align:center;display:grid;gap:6px;justify-items:center;background:repeating-linear-gradient(135deg,#0c1219,#0c1219 12px,#0e151d 12px,#0e151d 24px);cursor:pointer;transition:all .15s}
.st-drop:hover,.st-drop.is-over{border-color:var(--st-cyan);background:#0d1c24;box-shadow:inset 0 0 40px #5ee7ff14}
.st-drop-icon{font-size:30px;color:var(--st-cyan);line-height:1}.st-drop strong{font-size:15px}.st-drop span{font:11px 'DM Mono',monospace;color:var(--st-muted)}.st-drop small{font-size:12px;color:var(--st-amber)}
.st-sample{margin-top:8px;width:100%;background:none;border:1px solid #2b3a2a00;color:var(--st-cyan);font:500 12px 'DM Mono',monospace;padding:6px;text-decoration:underline;text-underline-offset:3px}
.st-rejected,.st-error,.st-warn{margin-top:12px;border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.5}
.st-rejected{background:#2a1712;border:1px solid #6b3a2c;color:#ffc2b5}.st-rejected p{margin:2px 0}.st-rejected button{background:none;border:0;color:#ff9b85;font:11px 'DM Mono',monospace;padding:4px 0 0}
.st-error{background:#2a1214;border:1px solid #7a2e34;color:#ffc1c5}.st-warn{background:#261f10;border:1px solid #6a5222;color:#ffd894;margin:10px 0 0}.st-warn p{margin:2px 0}
.st-files{list-style:none;margin:14px 0 0;padding:0;border:1px solid var(--st-line);border-radius:10px;overflow:hidden}
.st-files li{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #1a2531;font-size:13px}.st-files li:last-child{border-bottom:0}
.st-files button{background:none;border:0;color:var(--st-muted);font-size:18px;line-height:1;padding:0 4px}.st-files button:hover{color:var(--st-red)}
.st-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st-file-size{font:11px 'DM Mono',monospace;color:var(--st-muted)}
.st-files-total{justify-content:space-between;background:#0b1117;font:11px 'DM Mono',monospace!important;color:var(--st-muted)}.st-over{color:var(--st-red)}
.st-chip{font:600 9px 'DM Mono',monospace;letter-spacing:.1em;padding:3px 6px;border-radius:4px;min-width:40px;text-align:center}
.st-chip.st-cad{background:#3a2a10;color:var(--st-amber)}.st-chip.st-mesh{background:#33280f;color:#ffd27a}.st-chip.st-pdf{background:#123040;color:var(--st-cyan)}.st-chip.st-image{background:#173326;color:var(--st-green)}
.st-row{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 14px}
.st-toggle{display:inline-flex;border:1px solid var(--st-line);border-radius:9px;padding:3px;background:#0a0f15}.st-toggle button{background:none;border:0;color:var(--st-muted);padding:7px 14px;border-radius:6px;font-weight:600;font-size:13px}.st-toggle button.on{background:#1f2a35;color:var(--st-amber);box-shadow:inset 0 0 0 1px #ffb54744}
.st-select{background:#0a0f15;border:1px solid var(--st-line);color:var(--st-text);border-radius:9px;padding:9px 12px;font-size:13px;outline:none}
.st-build{margin-top:16px;width:100%;border:0;border-radius:11px;padding:15px 18px;font-weight:800;font-size:15px;letter-spacing:.02em;color:#1b1103;background:linear-gradient(135deg,var(--st-amber),#ff8f3d);box-shadow:0 10px 28px #ff9d3d33;transition:transform .1s,box-shadow .15s}
.st-build:not(:disabled):hover{transform:translateY(-1px);box-shadow:0 14px 34px #ff9d3d55}
.st-hint{font-size:12px;color:var(--st-muted);margin:8px 2px 0;line-height:1.5}
.st-stages{list-style:none;margin:16px 0 0;padding:14px 16px;border:1px solid var(--st-line);border-radius:10px;background:#0a0f15;display:grid;gap:12px}
.st-stages li{display:flex;gap:12px;align-items:flex-start}.st-stages strong{display:block;font-size:13px}.st-stages small{display:block;font:11px 'DM Mono',monospace;color:var(--st-muted);margin-top:2px;word-break:break-word}
.st-dot{width:12px;height:12px;border-radius:50%;margin-top:3px;flex:none;border:2px solid #34465a}
.st-stages .is-active .st-dot{border-color:var(--st-cyan);background:#5ee7ff33;box-shadow:0 0 0 4px #5ee7ff1c;animation:st-pulse 1.2s infinite}
.st-stages .is-done .st-dot{border-color:var(--st-green);background:var(--st-green)}.st-stages .is-error .st-dot{border-color:var(--st-red);background:var(--st-red)}.st-stages .is-error small{color:#ffb0a6}
.st-stages .is-skip{opacity:.5}.st-stages .is-idle{opacity:.45}
@keyframes st-pulse{50%{box-shadow:0 0 0 8px #5ee7ff00}}
.st-view{padding:16px;position:sticky;top:80px}
.st-view-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.st-view-head .st-label{margin:0}
.st-meta{font:11px 'DM Mono',monospace;color:var(--st-muted)}
.st-canvas{position:relative;height:440px;border-radius:11px;overflow:hidden;border:1px solid #1d2a37;background:radial-gradient(circle at 50% 35%,#16222e,#090d12 75%)}
.st-preview-empty{height:100%;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--st-muted);font-size:13px;padding:24px;text-align:center}
.st-bad{color:#ffb0a6}
.st-spinner{width:16px;height:16px;border:2px solid #2d4152;border-top-color:var(--st-cyan);border-radius:50%;animation:st-spin .8s linear infinite}@keyframes st-spin{to{transform:rotate(360deg)}}
.st-explode{position:absolute;left:12px;bottom:12px;display:flex;align-items:center;gap:8px;background:#0b1117dd;border:1px solid #243444;border-radius:8px;padding:6px 10px;font:10px 'DM Mono',monospace;letter-spacing:.14em;color:var(--st-muted)}.st-explode input{accent-color:var(--st-amber);width:130px}
.st-inspect{position:absolute;right:12px;top:12px;max-width:240px;display:grid;gap:3px;background:#0b1117e6;border:1px solid #2a4a58;border-left:3px solid var(--st-cyan);border-radius:8px;padding:9px 12px;font-size:12px}.st-inspect span{font:11px 'DM Mono',monospace;color:var(--st-muted)}.st-inspect em{font:600 10px 'DM Mono',monospace;color:var(--st-amber);font-style:normal}
.st-parts{list-style:none;margin:12px 0 0;padding:0;max-height:250px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px}
.st-parts li{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid #1d2935;border-radius:8px;background:#0b1117;cursor:pointer;font-size:12.5px}.st-parts li:hover{border-color:#35506a}.st-parts li.on{border-color:var(--st-cyan);background:#0d1d26}
.st-swatch{width:10px;height:10px;border-radius:3px;flex:none}.st-part-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st-part-name em{font:600 9px 'DM Mono',monospace;font-style:normal;color:var(--st-amber);margin-left:6px}.st-part-size{font:10px 'DM Mono',monospace;color:var(--st-muted)}
.st-library{margin-top:40px}.st-lib-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px}.st-lib-head h2{margin:8px 0 0;font-size:24px;letter-spacing:-.03em}
.st-muted{color:var(--st-muted);font-size:13px}
.st-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
.st-card{background:linear-gradient(180deg,var(--st-panel2),var(--st-panel));border:1px solid var(--st-line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s,transform .15s}.st-card:hover{border-color:#3b5670;transform:translateY(-2px)}
.st-card h3{margin:2px 0 0;font-size:16px}.st-card p{margin:0;color:var(--st-muted);font-size:13px;line-height:1.5;flex:1;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.st-card-top{display:flex;justify-content:space-between;align-items:center}
.st-status{font:600 9px 'DM Mono',monospace;letter-spacing:.12em;padding:3px 7px;border-radius:4px;background:#1f2a35;color:var(--st-muted)}.st-status.st-published{background:#123326;color:var(--st-green)}.st-status.st-draft{background:#33280f;color:var(--st-amber)}
.st-card-stats{display:flex;gap:14px;font:11px 'DM Mono',monospace;color:var(--st-muted)}.st-card-stats b{color:var(--st-text)}
.st-card-actions{display:flex;gap:8px;margin-top:4px}.st-card-actions a{flex:1;text-align:center;padding:8px;border-radius:8px;border:1px solid #2b3c4d;font-weight:700;font-size:13px}.st-card-actions a:hover{border-color:var(--st-cyan);color:var(--st-cyan)}.st-card-actions a.primary{background:#2a1e0b;border-color:#6d4e1d;color:var(--st-amber)}
`;
