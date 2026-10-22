import type { Box, CadPart, Vec3 } from "./types";

// Deterministic assembly sequencing from CAD bounding boxes (assembly-by-disassembly).
// Repeatedly remove a part that can slide out along one of the six principal directions without its box sweeping
// through the remaining parts. Reversing the removal order gives the assembly order; the opposite of the removal
// direction is the insertion axis (unit vector from approach toward seat). Fasteners are sequenced after the part they hold.

export type PlanStep =
  | { kind: "place"; nodes: [string]; axis: Vec3; interlocked?: boolean }
  | { kind: "fasteners"; holder: string; family: string; nodes: string[]; axis: Vec3; fastenNodes?: string[] }; // fastenNodes: tighten these after this group

export type SequencePlan = { base: string; steps: PlanStep[]; axes: Record<string, Vec3>; notes: string[] };

const FASTENER = /(screw|bolt|nut\b|nut[\s_\-\d(]|washer|rivet|shcs|bhcs|fhcs|iso[\s_-]?(4762|4017|4032|7380|10642|7089)|din[\s_-]?(912|933|934|125|7991)|\bm\d{1,2}\s?x\s?\d)/i;
const DRIVEN = /(screw|bolt|nut|shcs|bhcs|fhcs|rivet|4762|4017|4032|7380|10642|912|933|934|7991|\bm\d{1,2}\s?x)/i;
export const isFastener = (part: Pick<CadPart, "name" | "node">) => FASTENER.test(`${part.name} ${part.node}`);

// Removal directions in order of preference: lift up first, then sideways, then out the bottom.
const DIRECTIONS: Array<{ axis: 0 | 1 | 2; sign: 1 | -1 }> = [
  { axis: 1, sign: 1 }, { axis: 0, sign: 1 }, { axis: 0, sign: -1 }, { axis: 2, sign: 1 }, { axis: 2, sign: -1 }, { axis: 1, sign: -1 },
];
const unit = (axis: number, sign: number): Vec3 => { const v: Vec3 = [0, 0, 0]; v[axis] = sign; return v; };
const volume = (b: Box) => Math.max(1e-12, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]));
const center = (b: Box): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

export function normalizeBox(b: Box): Box {
  return { min: [0, 1, 2].map((i) => Math.min(b.min[i], b.max[i])) as Vec3, max: [0, 1, 2].map((i) => Math.max(b.min[i], b.max[i])) as Vec3 };
}

const overlaps = (p: Box, q: Box, by: number) => [0, 1, 2].every((k) => Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k]) > by);
// Axis along which `inner` passes right through `outer` (sticks out both ends, fits inside the other two extents), or -1.
function throughAxis(inner: Box, outer: Box, eps: number): number {
  for (let k = 0; k < 3; k++) {
    if (!(inner.min[k] < outer.min[k] - eps && inner.max[k] > outer.max[k] + eps)) continue;
    if ([0, 1, 2].every((j) => j === k || (inner.min[j] >= outer.min[j] - eps && inner.max[j] <= outer.max[j] + eps))) return k;
  }
  return -1;
}

// Does q block p sliding along (axis, sign)? q must overlap p's cross-section and reach past p's leading face.
// Boxes that already overlap at rest (shaft inside a bearing) only block when q extends beyond p in that direction,
// except pass-through members (a rod through a bracket, a bolt through a nut): those allow sliding along the rod only.
function blocks(p: Box, q: Box, axis: number, sign: number, eps: number): boolean {
  if (overlaps(p, q, 2 * eps)) {
    const k = throughAxis(q, p, eps), j = throughAxis(p, q, eps);
    if (k >= 0) return axis !== k;
    if (j >= 0) return axis !== j;
  }
  for (let k = 0; k < 3; k++) {
    if (k === axis) continue;
    if (Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k]) <= eps) return false;
  }
  return sign > 0 ? q.max[axis] > p.max[axis] + eps : q.min[axis] < p.min[axis] - eps;
}

function removalDirection(p: Box, others: Box[], eps: number) {
  for (const d of DIRECTIONS) if (!others.some((q) => blocks(p, q, d.axis, d.sign, eps))) return d;
  return null;
}

function familyOf(name: string) {
  return name.toLowerCase().replace(/[<>()[\]{}]/g, " ").replace(/[\s_-]*(\d+|copy|instance|inst|body|part)\s*$/g, "").replace(/[\s_:-]+\d+$/g, "").replace(/\s+/g, " ").trim() || "fastener";
}

export function planSequence(parts: CadPart[]): SequencePlan {
  const notes: string[] = [];
  const boxes = new Map(parts.map((part) => [part.node, normalizeBox(part.bbox)]));
  const all = [...boxes.values()];
  const lo = [0, 1, 2].map((i) => Math.min(...all.map((b) => b.min[i]))), hi = [0, 1, 2].map((i) => Math.max(...all.map((b) => b.max[i])));
  const eps = Math.max(0.0003, 0.0015 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  let fasteners = parts.filter(isFastener);
  let bodies = parts.filter((part) => !isFastener(part));
  if (!bodies.length) { bodies = parts; fasteners = []; notes.push("Every part looks like a fastener; sequencing them all as bodies."); }

  // Base: the largest body, unless the lowest body is nearly as big (then it is the natural fixture).
  const byVolume = [...bodies].sort((a, b) => volume(boxes.get(b.node)!) - volume(boxes.get(a.node)!));
  const lowest = [...bodies].sort((a, b) => boxes.get(a.node)!.min[1] - boxes.get(b.node)!.min[1])[0];
  const base = volume(boxes.get(lowest.node)!) >= 0.25 * volume(boxes.get(byVolume[0].node)!) ? lowest : byVolume[0];
  notes.push(`Base part: ${base.name || base.node} (${base === lowest ? "lowest" : "largest"} body).`);

  // Disassembly over bodies. Among removable parts, take the top-most first (then the smallest), preferring lift-off.
  const remaining = new Set(bodies.map((part) => part.node).filter((node) => node !== base.node));
  const removed: Array<{ node: string; axis: Vec3; interlocked?: boolean }> = [];
  while (remaining.size) {
    const present = (except: string) => [base.node, ...remaining].filter((node) => node !== except).map((node) => boxes.get(node)!);
    const candidates = [...remaining].map((node) => ({ node, box: boxes.get(node)!, dir: removalDirection(boxes.get(node)!, present(node), eps) })).filter((c) => c.dir);
    const rank = (c: { box: Box; dir: { axis: number; sign: number } | null }) => DIRECTIONS.findIndex((d) => d.axis === c.dir!.axis && d.sign === c.dir!.sign) > 0 ? 1 : 0;
    // Lift-off candidates: top-most first, then smallest. Sideways candidates: smallest first (a rod slides out before the brackets it threads).
    candidates.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.box.max[1] - a.box.max[1] : 0) || volume(a.box) - volume(b.box));
    const pick = candidates[0];
    if (pick) {
      removed.push({ node: pick.node, axis: unit(pick.dir!.axis, -pick.dir!.sign) });
      remaining.delete(pick.node);
    } else {
      // Interlocked by bounding boxes: lift the top-most part straight off and flag it.
      const top = [...remaining].sort((a, b) => boxes.get(b)!.max[1] - boxes.get(a)!.max[1])[0];
      removed.push({ node: top, axis: [0, -1, 0], interlocked: true });
      remaining.delete(top);
      notes.push(`${top} is interlocked by bounding boxes; assuming a top-down insertion.`);
    }
  }
  const order = removed.reverse();
  const axes: Record<string, Vec3> = { [base.node]: [0, -1, 0] };
  const steps: PlanStep[] = [];
  for (const item of order) { axes[item.node] = item.axis; steps.push({ kind: "place", nodes: [item.node], axis: item.axis, ...(item.interlocked ? { interlocked: true } : {}) }); }

  // Fasteners. Screws/bolts hold the latest-installed body they touch (base counts as earliest; else the nearest body).
  // Nuts and washers threaded on a bolt follow that bolt's holder: washers on the approach side go first, nuts after.
  const installIndex = new Map<string, number>([[base.node, -1], ...order.map((item, i) => [item.node, i] as [string, number])]);
  const touches = (a: Box, b: Box) => [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) >= -eps * 2);
  const mid = lo.map((v, i) => (v + hi[i]) / 2);
  const kindOf = (part: CadPart) => (/washer/i.test(`${part.name} ${part.node}`) ? "washer" : /nut\b|nut[\s_\-\d(]|4032|934/i.test(`${part.name} ${part.node}`) ? "nut" : "male");
  const fastenerAxis = (part: CadPart, kind: string): Vec3 => {
    const box = boxes.get(part.node)!, size = [0, 1, 2].map((k) => box.max[k] - box.min[k]);
    const k = kind === "male" ? size.indexOf(Math.max(...size)) : size.indexOf(Math.min(...size));
    // Bodies the fastener already sits inside (the holes it passes through) do not block it; everything else does.
    const blockers = parts.filter((other) => other.node !== part.node && (isFastener(other) || !overlaps(box, boxes.get(other.node)!, 2 * eps))).map((other) => boxes.get(other.node)!);
    const free = (sign: number) => !blockers.some((q) => blocks(box, q, k, sign, eps));
    const away = (box.min[k] + box.max[k]) / 2 >= mid[k] ? 1 : -1;
    const removal = free(1) && free(-1) ? (k === 1 ? 1 : away) : free(1) ? 1 : free(-1) ? -1 : away;
    return unit(k, -removal);
  };
  const holderOf = (box: Box) => {
    const touching = bodies.filter((body) => touches(box, boxes.get(body.node)!));
    return touching.length
      ? touching.sort((a, b) => installIndex.get(b.node)! - installIndex.get(a.node)!)[0].node
      : [...bodies].sort((a, b) => dist(center(box), center(boxes.get(a.node)!)) - dist(center(box), center(boxes.get(b.node)!)))[0].node;
  };
  type Group = { holder: string; family: string; nodes: string[]; axis: Vec3; rank: number; driven: boolean };
  const groups = new Map<string, Group>();
  const males = fasteners.filter((f) => kindOf(f) === "male"), others = fasteners.filter((f) => kindOf(f) !== "male");
  const maleHolder = new Map<string, string>();
  for (const fastener of [...males, ...others]) {
    const box = boxes.get(fastener.node)!, kind = kindOf(fastener);
    const axis = fastenerAxis(fastener, kind);
    axes[fastener.node] = axis;
    let holder = holderOf(box), rank = kind === "washer" ? 0 : kind === "male" ? 1 : 2;
    if (kind === "male") maleHolder.set(fastener.node, holder);
    else {
      const bolt = males.find((m) => touches(box, boxes.get(m.node)!));
      if (bolt) {
        holder = maleHolder.get(bolt.node) ?? holder;
        const b = boxes.get(bolt.node)!, boltAxis = axes[bolt.node];
        const side = [0, 1, 2].reduce((sum, k) => sum + (center(box)[k] - center(b)[k]) * boltAxis[k], 0);
        if (kind === "washer") rank = side < 0 ? 0 : 2; // washer under the head vs under the nut
      }
    }
    const family = familyOf(fastener.name || fastener.node);
    const key = `${holder}|${family}|${axis.join(",")}|${rank}`;
    const group = groups.get(key) ?? { holder, family, nodes: [], axis, rank, driven: kind !== "washer" && DRIVEN.test(`${fastener.name} ${fastener.node}`) };
    group.nodes.push(fastener.node);
    groups.set(key, group);
  }
  // Insert each holder's groups right after the holder, in rank order; one tightening step after the holder's last driven group.
  const byHolder = new Map<string, Group[]>();
  for (const group of groups.values()) byHolder.set(group.holder, [...(byHolder.get(group.holder) ?? []), group]);
  for (const [holder, list] of byHolder) {
    list.sort((a, b) => a.rank - b.rank);
    const driven = list.filter((g) => g.driven).flatMap((g) => g.nodes);
    const lastDriven = list.map((g) => g.driven).lastIndexOf(true);
    let at = holder === base.node ? 0 : steps.findIndex((step) => step.kind === "place" && step.nodes[0] === holder) + 1;
    while (at < steps.length && steps[at].kind === "fasteners") at++;
    steps.splice(at, 0, ...list.map((g, i): PlanStep => ({ kind: "fasteners", holder, family: g.family, nodes: g.nodes, axis: g.axis, ...(i === lastDriven ? { fastenNodes: driven } : {}) })));
  }
  if (fasteners.length) notes.push(`${fasteners.length} fastener(s) grouped into ${groups.size} group(s) on ${byHolder.size} part(s).`);
  return { base: base.node, steps, axes, notes };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
