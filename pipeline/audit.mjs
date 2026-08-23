// AUDIT of the drawn network: run it after lines.mjs and it answers the only
// questions that matter about the picture — is any line torn, does any stroke
// end in mid-air, and is there anything in the geometry that line-offset will
// turn into a squiggle. It reads only the emitted files, so it checks what the
// map actually draws rather than what the pipeline meant to draw.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data/out');
const read = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));

const LAT0 = (() => { const b = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8')).bbox; return (b[1] + b[3]) / 2; })();
const MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const MY = 111132;
const m = (c) => [c[0] * MX, c[1] * MY];
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const plen = (c) => { let s = 0; for (let i = 1; i < c.length; i++) s += d2(m(c[i - 1]), m(c[i])); return s; };
const nk = (c) => c[0].toFixed(6) + ',' + c[1].toFixed(6);
const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00') + '%';

const streets = read('streets.geojson');
const strands = read('lines-strands.geojson');
const corridors = read('lines-corridors.geojson');
const rows = read('lines-rows.geojson');
const meta = JSON.parse(readFileSync(join(OUT, 'lines-meta.json'), 'utf8'));
const MAXSEP = meta.maxSeparate;

const problems = [];
const flag = (kind, n, detail, where) => problems.push({ kind, n, detail, where });
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

// ---------- 1. is every line drawn over its whole route? ----------
// The source says how many metres of roadway each line rides. Every one of them
// has to end up either in a coloured strand or inside a grey trunk; a shortfall
// is a hole in that line's route, whatever it looks like on screen.
head('1. COVERAGE — drawn length vs the network the build produced');
const srcKm = new Map(), drawnKm = new Map();
const add = (map2, k, v) => map2.set(k, (map2.get(k) || 0) + v);
for (const f of streets.features) {
  const L = plen(f.geometry.coordinates);
  for (const l of f.properties.arr) add(srcKm, l, L);
}
// a strand's pieces overlap by design (0.4 m per swing step), so measure the
// chain each piece belongs to instead of summing the pieces
const chainSeen = new Set();
for (const f of strands.features) {
  const c = f.geometry.coordinates;
  const key = f.properties.line + '|' + nk(c[0]) + '|' + nk(c[c.length - 1]) + '|' + f.properties.oi;
  if (chainSeen.has(key)) continue;
  chainSeen.add(key);
  add(drawnKm, f.properties.line, plen(c));
}
for (const f of corridors.features) {
  const L = plen(f.geometry.coordinates);
  for (const l of f.properties.arr) add(drawnKm, l, L);
}
let short = 0, worst = null;
for (const [line, src] of srcKm) {
  const got = drawnKm.get(line) || 0;
  const diff = (got - src) / src;
  if (diff < -0.02) { short++; if (!worst || diff < worst.diff) worst = { line, src, got, diff }; }
}
console.log(`${srcKm.size} lines in the source, ${short} of them drawn more than 2 % short`);
if (worst) console.log(`  worst: line ${worst.line} — ${(worst.src / 1000).toFixed(1)} km ridden, ${(worst.got / 1000).toFixed(1)} km drawn (${(100 * worst.diff).toFixed(1)} %)`);
if (short) flag('coverage', short, 'lines drawn short of their route', worst && worst.line);

// ---------- 2. do the strokes meet at the junctions? ----------
// A slot number is meaningless on its own: line-offset measures from the
// direction a stroke is DRAWN in, so the same number means opposite kerbs on two
// strokes drawn opposite ways. What has to match is the physical displacement —
// the slot times the right-hand normal of the drawing direction at that end.
head('2. HANDOVERS — does a strand meet its continuation on the same side?');
const atNode = new Map();
const put = (k, v) => { if (!atNode.has(k)) atNode.set(k, []); atNode.get(k).push(v); };
const dirAt = (coords, atStart) => {
  const a2 = atStart ? m(coords[0]) : m(coords[coords.length - 2]);
  const b2 = atStart ? m(coords[1]) : m(coords[coords.length - 1]);
  const dx = b2[0] - a2[0], dy = b2[1] - a2[1], L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
};
const sideVec = (d, oi) => [oi * d[1], -oi * d[0]];
for (const f of strands.features) {
  const c = f.geometry.coordinates, oi = f.properties.oi;
  const d0 = dirAt(c, true), d1 = dirAt(c, false);
  put(nk(c[0]), { line: f.properties.line, mode: f.properties.mode, v: sideVec(d0, oi), oi, d: d0, into: true });
  put(nk(c[c.length - 1]), { line: f.properties.line, mode: f.properties.mode, v: sideVec(d1, oi), oi, d: d1, into: false });
}
for (const f of corridors.features) {
  const c = f.geometry.coordinates;
  for (const l of f.properties.arr) {
    put(nk(c[0]), { line: l, mode: f.properties.mode, v: [0, 0], oi: 0, trunk: true, d: dirAt(c, true), into: true });
    put(nk(c[c.length - 1]), { line: l, mode: f.properties.mode, v: [0, 0], oi: 0, trunk: true, d: dirAt(c, false), into: false });
  }
}
let steps = 0, stepWorst = null, meets = 0, pinches = 0;
// two strokes meeting nose to tail on a straight run point the same way; at a
// bend they do not, and there the giving-way side deliberately runs down to the
// centreline and finishes inside the other one's band
const straight = (a2, b2) => {
  const dot = a2.into === b2.into ? -(a2.d[0] * b2.d[0] + a2.d[1] * b2.d[1]) : (a2.d[0] * b2.d[0] + a2.d[1] * b2.d[1]);
  return dot > Math.cos(25 * Math.PI / 180);
};
for (const [k, list] of atNode) {
  const byLine = new Map();
  for (const e of list) {
    const key = e.mode + '|' + e.line;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(e);
  }
  for (const [key, es] of byLine) {
    if (es.length < 2) continue;
    meets++;
    let spread = 0, bent = false;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const gap = Math.hypot(es[i].v[0] - es[j].v[0], es[i].v[1] - es[j].v[1]);
      if (gap > spread) { spread = gap; bent = !straight(es[i], es[j]); }
    }
    // 0.35 of a slot is about a pixel and a half — below that nothing shows
    if (spread <= 0.35) continue;
    if (bent) { pinches++; continue; }
    steps++;
    if (!stepWorst || spread > stepWorst.spread) stepWorst = { key, spread, at: k };
  }
}
console.log(`${meets} places where a line hands over from one stroke to the next`);
console.log(`${pinches} of them at a bend, where the giving-way stroke runs into the other one's band on purpose`);
console.log(`${steps} with a step on a STRAIGHT run, which is the kind that shows (${pct(steps, meets)})`);
if (stepWorst) console.log(`  worst: ${stepWorst.key} — ${stepWorst.spread.toFixed(2)} slots apart at ${stepWorst.at}`);
if (steps) flag('handover', steps, 'handovers with a visible offset step', stepWorst && stepWorst.at);

// ---------- 3. torn ends ----------
// A stroke may only stop where the line stops. Testing that on node KEYS is not
// enough — a welded run passes THROUGH a junction without an endpoint there, and
// a neighbour that ends at it is perfectly well continued by that run. So the
// test is geometric: is there any other drawn metre of this line within reach?
head('3. TORN ENDS — a stroke stopping where the line still goes on');
const CELL = 60;
// Index SEGMENTS, not sampled points: a node can sit in the middle of a 30 m
// straight, and a sampler that only drops a point every 40 m would call a
// perfectly continuous line torn.
const grid = new Map();
const cells = (p) => [Math.round(p[0] / CELL), Math.round(p[1] / CELL)];
const index = (coords, key) => {
  for (let i = 1; i < coords.length; i++) {
    const a2 = m(coords[i - 1]), b2 = m(coords[i]);
    const [x0, y0] = cells(a2), [x1, y1] = cells(b2);
    for (let x = Math.min(x0, x1) - 1; x <= Math.max(x0, x1) + 1; x++)
      for (let y = Math.min(y0, y1) - 1; y <= Math.max(y0, y1) + 1; y++) {
        const k = x + ',' + y;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ key, a: a2, b: b2 });
      }
  }
};
for (const f of strands.features) index(f.geometry.coordinates, f.properties.mode + '|' + f.properties.line);
for (const f of corridors.features) for (const l of f.properties.arr) index(f.geometry.coordinates, f.properties.mode + '|' + l);
const segDist = (p, a2, b2) => {
  const vx = b2[0] - a2[0], vy = b2[1] - a2[1];
  const L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a2[0]) * vx + (p[1] - a2[1]) * vy) / L2)) : 0;
  return Math.hypot(p[0] - (a2[0] + vx * t), p[1] - (a2[1] + vy * t));
};
// how many source runs of this line touch each node
const srcAt = new Map();
for (const f of streets.features) {
  const c = f.geometry.coordinates;
  for (const l of f.properties.arr) for (const k of [nk(c[0]), nk(c[c.length - 1])]) {
    const kk = k + '|' + f.properties.mode + '|' + l;
    srcAt.set(kk, (srcAt.get(kk) || 0) + 1);
  }
}
let torn = 0, tornWhere = null;
for (const [k, list] of atNode) {
  const byLine = new Map();
  for (const e of list) byLine.set(e.mode + '|' + e.line, (byLine.get(e.mode + '|' + e.line) || 0) + 1);
  for (const [key, n] of byLine) {
    if (n > 1) continue;                               // something else takes over here
    if ((srcAt.get(k + '|' + key) || 0) < 2) continue; // the line really ends here
    const [lon, lat] = k.split(',').map(Number);
    const p = m([lon, lat]);
    // does any OTHER drawn stretch of this line run through the node? the piece
    // that ends here touches it too, so a continuous line scores at least two
    let hits = 0;
    const [cx, cy] = cells(p);
    for (let dx = -1; dx <= 1 && hits < 2; dx++) for (let dy = -1; dy <= 1 && hits < 2; dy++)
      for (const e of (grid.get((cx + dx) + ',' + (cy + dy)) || [])) {
        if (e.key === key && segDist(p, e.a, e.b) < 2.5) { hits++; if (hits >= 2) break; }
      }
    if (hits < 2) { torn++; if (!tornWhere) tornWhere = { key, at: k }; }
  }
}
console.log(`${torn} strokes ending where the line still had somewhere to go`);
if (tornWhere) console.log(`  first: ${tornWhere.key} at ${tornWhere.at}`);
if (torn) flag('torn', torn, 'strokes ending mid-route', tornWhere && tornWhere.at);

// ---------- 4. geometry that line-offset cannot survive ----------
// An offset polyline folds over itself on a vertex sharper than the offset can
// turn. Those folds are the "weird squiggles": a loop of colour hanging off a
// corner. Arms shorter than the offset are the other half of the same problem.
head('4. SQUIGGLES — corners an offset stroke would fold over');
const turnScan = (fc, label, offsetAware) => {
  let sharp = 0, fold = 0, micro = 0, worstT = 0, worstAt = null, verts = 0, pieces = 0;
  for (const f of fc.features) {
    const p = f.geometry.coordinates.map(m);
    pieces++;
    if (plen(f.geometry.coordinates) < 1) micro++;
    for (let i = 1; i < p.length - 1; i++) {
      const v1 = [p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]];
      const v2 = [p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]];
      const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
      const t = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]) * 180 / Math.PI);
      verts++;
      // sub-metre arms are the 0.4 m overlaps the swing steps are built with:
      // whatever angle they make is far below a pixel and means nothing here
      if (l1 < 1 || l2 < 1) continue;
      if (t > 35.5) sharp++;
      // a fold needs BOTH a sharp turn and arms long enough to show it
      if (t > 45 && l1 > 3 && l2 > 3 && (!offsetAware || Math.abs(f.properties.oi) > 0.1)) fold++;
      if (t > worstT) { worstT = t; worstAt = f.geometry.coordinates[i]; }
    }
  }
  console.log(`${label}: ${pieces} pieces, ${verts} vertices — ${sharp} over 35°, ${fold} that an offset stroke would fold, ${micro} pieces under 1 m`);
  if (worstAt) console.log(`  sharpest: ${worstT.toFixed(0)}° at ${worstAt.join(',')}`);
  if (fold) flag('fold', fold, label + ': corners an offset stroke folds over', worstAt && worstAt.join(','));
  if (micro) flag('micro', micro, label + ': pieces under 1 m');
  return { sharp, fold, micro };
};
turnScan(strands, 'strands', true);
turnScan(corridors, 'trunks', false);

// ---------- 5. is everything named? ----------
head('5. NAMES — can the reader tell what is what?');
const drawnLines = new Set(strands.features.map((f) => f.properties.line));
const inRows = new Set();
for (const f of rows.features) for (const l of f.properties.arr) inRows.add(l);
const missing = [...drawnLines].filter((l) => !inRows.has(l));
console.log(`${drawnLines.size} lines drawn as their own strand, ${drawnLines.size - missing.length} of them named in a cluster`);
if (missing.length) flag('unnamed', missing.length, 'strands with no number anywhere: ' + missing.join(', '));
const rowLines = inRows;
const trunkLines = new Set();
for (const f of corridors.features) for (const l of f.properties.arr) trunkLines.add(l);
const noRow = [...trunkLines].filter((l) => !rowLines.has(l));
console.log(`${trunkLines.size} lines ride a grey trunk, ${rowLines.size} of them appear in a trunk's number row`);
if (noRow.length) flag('unnamed-trunk', noRow.length, 'lines inside a trunk that no row names: ' + noRow.slice(0, 8).join(', '));


// ---------- 6. does a drawn stroke still follow its street? ----------
// Everything above checks how the pieces relate to EACH OTHER. This asks the
// other question: is the line still where the build put it? Smoothing rounds
// corners and slicing cuts pieces, and either could quietly walk a stroke off
// its roadway — which on screen is the "line drawn through the middle of a
// block" kind of wrong that no continuity check would ever notice.
head('6. FIDELITY — how far a drawn stroke wanders from the roadway it rides');
const srcGrid = new Map();
const SCELL = 120;
for (const f of streets.features) {
  const c = f.geometry.coordinates;
  for (let i = 1; i < c.length; i++) {
    const a2 = m(c[i - 1]), b2 = m(c[i]);
    const [x0, y0] = [Math.round(a2[0] / SCELL), Math.round(a2[1] / SCELL)];
    const [x1, y1] = [Math.round(b2[0] / SCELL), Math.round(b2[1] / SCELL)];
    for (let x = Math.min(x0, x1) - 1; x <= Math.max(x0, x1) + 1; x++)
      for (let y = Math.min(y0, y1) - 1; y <= Math.max(y0, y1) + 1; y++) {
        const k = x + ',' + y;
        if (!srcGrid.has(k)) srcGrid.set(k, []);
        srcGrid.get(k).push({ a: a2, b: b2, mode: f.properties.mode, arr: f.properties.arr });
      }
  }
}
const segD = (p, a2, b2) => {
  const vx = b2[0] - a2[0], vy = b2[1] - a2[1];
  const L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a2[0]) * vx + (p[1] - a2[1]) * vy) / L2)) : 0;
  return Math.hypot(p[0] - (a2[0] + vx * t), p[1] - (a2[1] + vy * t));
};
const nearestSrc = (p, mode, line) => {
  const cx = Math.round(p[0] / SCELL), cy = Math.round(p[1] / SCELL);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    for (const e of (srcGrid.get((cx + dx) + ',' + (cy + dy)) || [])) {
      if (e.mode !== mode || !e.arr.includes(line)) continue;
      const d = segD(p, e.a, e.b);
      if (d < best) best = d;
    }
  return best;
};
const wander = (fc, label, lineOf) => {
  let worst = 0, worstAt = null, off = 0, tested = 0;
  for (const f of fc.features) {
    const line = lineOf(f);
    if (!line) continue;
    const c = f.geometry.coordinates;
    for (let i = 0; i < c.length; i += Math.max(1, Math.floor(c.length / 12))) {
      const d = nearestSrc(m(c[i]), f.properties.mode, line);
      if (!isFinite(d)) continue;
      tested++;
      if (d > 5) off++;
      if (d > worst) { worst = d; worstAt = c[i]; }
    }
  }
  console.log(`${label}: ${tested} sampled points — ${off} more than 5 m off their roadway (${pct(off, tested)}), worst ${worst.toFixed(1)} m`);
  if (off) flag('wander', off, label + ': points off their roadway', worstAt && worstAt.join(','));
  return { worst, worstAt };
};
wander(strands, 'strands', (f) => f.properties.line);
wander(corridors, 'trunks', (f) => f.properties.arr[0]);

// ---------- 7. is anything drawn twice? ----------
// Two pieces of the same line lying on top of each other render as one darker,
// fatter stroke — and at a different offset they render as a ghost beside it.
head('7. DOUBLES — the same line drawn twice over the same ground');
const sig = new Map();
for (const f of strands.features) {
  const c = f.geometry.coordinates;
  if (c.length < 2) continue;
  // endpoints alone are not identity: two one-way roadways of a short split
  // street share BOTH end nodes (Zakręt do Oksywia, carriageways 6 m apart) —
  // a true double also shares its middle vertex
  const key = [f.properties.line, f.properties.mode, nk(c[0]), nk(c[Math.floor((c.length - 1) / 2)]), nk(c[c.length - 1])].join('|');
  if (!sig.has(key)) sig.set(key, []);
  sig.get(key).push(f.properties.oi);
}
let doubles = 0, ghosts = 0;
for (const [, ois] of sig) {
  if (ois.length < 2) continue;
  const spread = Math.max(...ois) - Math.min(...ois);
  if (spread < 0.05) doubles++; else ghosts++;
}
console.log(`${doubles} pieces drawn twice at the same offset, ${ghosts} at different offsets (a ghost beside the line)`);
if (doubles) flag('double', doubles, 'pieces drawn twice over the same ground');
if (ghosts) flag('ghost', ghosts, 'the same stretch drawn at two different offsets');

// ---------- 8. does every roadway say which lines ride it? ----------
// The numbers are one cluster per roadway now, so the question is no longer
// "is this number beside its own strand" but "did any roadway end up with
// nothing written next to it" — a stroke that names nothing is a stroke the
// reader cannot use.
head('8. NUMBERS — does every roadway carry its list?');
const RCELL = 200;
const rowGrid = new Map();
for (const f of rows.features) {
  const p = m(f.geometry.coordinates);
  const k = Math.round(p[0] / RCELL) + ',' + Math.round(p[1] / RCELL);
  if (!rowGrid.has(k)) rowGrid.set(k, []);
  rowGrid.get(k).push({ p, arr: f.properties.arr });
}
let nameless = 0, namelessKm = 0, namelessAt = null;
for (const f of streets.features) {
  // `nolabel` is build.mjs deciding NOT to print this run: on a dual carriageway
  // only one side carries the row, so the other is named by its twin
  if (f.properties.nolabel) continue;
  const c = f.geometry.coordinates;
  // junction stubs and roundabout arcs are read from the corridor they belong to
  if (plen(c) < 60) continue;
  const mid = m(c[Math.floor(c.length / 2)]);
  const want = new Set(f.properties.arr);
  const [cx, cy] = [Math.round(mid[0] / RCELL), Math.round(mid[1] / RCELL)];
  let ok = false;
  for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1 && !ok; dy++)
    for (const e of (rowGrid.get((cx + dx) + ',' + (cy + dy)) || [])) {
      // the row has to be near AND to name at least what this roadway carries
      if (d2(e.p, mid) < 400 && [...want].every((l) => e.arr.includes(l))) { ok = true; break; }
    }
  if (!ok) { nameless++; namelessKm += plen(c) / 1000; if (!namelessAt) namelessAt = c[0]; }
}
console.log(`${streets.features.length} roadways, ${rows.features.length} number clusters`);
console.log(`${nameless} roadways over 60 m with no cluster naming their lines within 400 m (${namelessKm.toFixed(2)} km)`);
if (namelessAt) console.log(`  first: ${namelessAt.join(',')}`);
if (nameless) flag('nameless', nameless, 'roadways with no numbers beside them', namelessAt && namelessAt.join(','));
const greyNums = rows.features.filter((f) => /^#(41464e|4a4f57)$/i.test(f.properties.c0 || '')).length;
if (greyNums) flag('grey-number', greyNums, 'clusters whose numbers fell back to grey');

// ---------- 9. is each line's route in one piece? ----------
// The check that was missing, and the one that mattered: everything above asks
// whether the drawn metres are right, not whether they HANG TOGETHER. The
// streets layer is built from the road segments a route used, and a segment
// only enters it once enough of it was travelled — so a route that clips a long
// segment briefly leaves a hole and the line falls into two pieces, each of them
// perfectly drawn (user report: 700 at the Wielki Kack interchange).
//
// Runs are welded on SHARED VERTICES, not shared endpoints: one run routinely
// ends against the middle of another, and testing endpoints alone reported 171
// of 192 lines as torn when 4 were.
head("9. CONTINUITY — is each line's route one connected piece?");
{
  const byLine = new Map();
  for (const f of streets.features) for (const l of f.properties.arr) {
    const k = f.properties.mode + '|' + l;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(f);
  }
  let torn2 = 0, orphanKm = 0, worstLine = null, worstKm = 0;
  for (const [k, runs] of byLine) {
    const at = new Map();
    runs.forEach((f, i) => { for (const c of f.geometry.coordinates) {
      const key = nk(c); if (!at.has(key)) at.set(key, []); at.get(key).push(i); } });
    const seen = new Array(runs.length).fill(false);
    const comps = [];
    for (let i = 0; i < runs.length; i++) {
      if (seen[i]) continue;
      const mem = [], q = [i]; seen[i] = true;
      while (q.length) { const j = q.pop(); mem.push(j);
        for (const c of runs[j].geometry.coordinates) for (const n of (at.get(nk(c)) || [])) if (!seen[n]) { seen[n] = true; q.push(n); } }
      comps.push(mem);
    }
    if (comps.length < 2) continue;
    const lens = comps.map((mm) => mm.reduce((s2, j) => s2 + plen(runs[j].geometry.coordinates), 0)).sort((x, y) => y - x);
    const o = lens.slice(1).reduce((x, y) => x + y, 0) / 1000;
    torn2++; orphanKm += o;
    if (o > worstKm) { worstKm = o; worstLine = k + ' (' + comps.length + ' pieces)'; }
  }
  console.log(`${byLine.size} lines — ${torn2} whose route falls into more than one piece (${orphanKm.toFixed(2)} km adrift)`);
  if (worstLine) console.log(`  worst: ${worstLine}, ${worstKm.toFixed(2)} km cut off`);
  if (torn2) flag('split-route', torn2, 'lines whose route is not one connected piece', worstLine);
}

// ---------- verdict ----------
head('VERDICT');
if (!problems.length) console.log('clean — nothing to fix');
else for (const p of problems) console.log(`  ${String(p.n).padStart(6)}  ${p.kind.padEnd(14)} ${p.detail}${p.where ? '  @ ' + p.where : ''}`);
process.exit(problems.length ? 1 : 0);
