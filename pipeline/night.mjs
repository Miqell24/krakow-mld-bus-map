// Night lines print BLACK and come LAST (user rule, 8.09.2026: "on every map
// the night line numbers, whatever the mode, are black — the common
// convention"; "keep the colours together, never mixed, on the map and in the
// legend"; "night always at the end"). Where the pipeline has no line rank the
// lists are re-sorted too.
//
// A post-pass over the written outputs (data/out and docs/data carry the same
// files): the number rows of labels.geojson that contain a night line get
// their text as coloured SECTIONS (l0/c0, l1/c1 … — the same properties the
// Lines view uses, read by app.js's colouredRow / sectionRow): the day numbers
// of each group in the group's colour (rail row, trolleybus row, bus row —
// each colour together), then '\n' and ALL the row's night numbers in black
// as the last group. bl/bc = the bus-only view's row, tl/tc = the tram-only
// view's. Terminus badges of night lines get a black box and number, the
// panel chips (meta.json) a black colour, and where there is no rank the
// night lines move to the very end of the list.
//
// Usage: node night.mjs <dir> '<regex source>' [--sort]
//   or  import { nightPass } from './night.mjs'; await nightPass(dir, /regex/, { sort })
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BLACK = '#000000';
const TROLLEY_GREEN = '#149a3f';
const KMK = '#0059a9';

const split = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const joinList = (a) => a.join(', ');

export function nightPass(dir, NIGHT, opts = {}) {
  const sort = !!opts.sort;
  const isNight = (n) => NIGHT.test(n);
  const order = (list) => (sort ? [...list.filter((n) => !isNight(n)), ...list.filter(isNight)] : list);
  const rd = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const wr = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o), 'utf8');
  const stats = { rows: 0, busRows: 0, tramRows: 0, badges: 0, meta: 0, stops: 0, maxSlots: 0 };

  // ---- labels: number rows ----
  const sections = (groups) => {
    // groups: [{ nums: [...], color }] → [[text, color], ...]: the day numbers
    // of each group in its colour, '\n' between groups, the night numbers of
    // the whole row black at the end
    const out = [];
    const emit = (nums, color) => {
      if (!nums.length) return;
      if (out.length) out.push(['\n', BLACK]);
      let run = null;
      nums.forEach((n, i) => {
        const c = isNight(n) ? BLACK : color;
        const text = n + (i < nums.length - 1 ? ', ' : '');
        if (run && run[1] === c) run[0] += text; else out.push(run = [text, c]);
      });
    };
    for (const g of groups) emit(g.nums.filter((n) => !isNight(n)), g.color);
    emit(groups.flatMap((g) => g.nums.filter(isNight)), BLACK);
    return out;
  };
  const put = (p, pre, secs) => {
    secs.forEach(([t, c], i) => { p[pre + 'l' + i] = t; p[pre + 'c' + i] = c; });
    stats.maxSlots = Math.max(stats.maxSlots, secs.length);
  };
  const labelsFile = join(dir, 'labels.geojson');
  if (existsSync(labelsFile)) {
    const labels = rd('labels.geojson');
    for (const f of labels.features) {
      const p = f.properties;
      if (!p || p.mLines || p.nmLines) continue; // paratransit splits: untouched
      for (const k of Object.keys(p)) if (/^(b|t)?[lc]\d+$/.test(k)) delete p[k]; // a rerun recomputes
      const lines = split(p.lines);
      if (!lines.some(isNight) && !split(p.busLines).some(isNight)) continue;
      if (sort) {
        for (const k of ['lines', 'busLines', 'tLines', 'ntLines']) if (p[k]) p[k] = joinList(order(split(p[k])));
        if (Array.isArray(p.arr)) p.arr = order(p.arr);
      }
      const railColor = p.color || KMK;
      let groups, busGroups, tramGroups;
      if (p.busLines) {
        const bus = p.tLines ? [{ nums: split(p.tLines), color: TROLLEY_GREEN }, { nums: split(p.ntLines), color: KMK }] : [{ nums: split(p.busLines), color: KMK }];
        groups = [{ nums: split(p.lines), color: railColor }, ...bus];
        busGroups = bus;
        tramGroups = [{ nums: split(p.lines), color: railColor }];
      } else if (p.tLines) {
        groups = [{ nums: split(p.tLines), color: TROLLEY_GREEN }, { nums: split(p.ntLines), color: KMK }];
        busGroups = groups;
      } else {
        groups = [{ nums: split(p.lines), color: railColor }];
        if (p.mode === 'bus') busGroups = groups; else tramGroups = groups;
      }
      put(p, '', sections(groups)); stats.rows++;
      if (busGroups) { put(p, 'b', sections(busGroups)); stats.busRows++; }
      if (tramGroups) { put(p, 't', sections(tramGroups)); stats.tramRows++; }
    }
    wr('labels.geojson', labels);
  }

  // ---- terminus badges ----
  const badgesFile = join(dir, 'badges.geojson');
  if (existsSync(badgesFile)) {
    const badges = rd('badges.geojson');
    for (const f of badges.features) {
      const p = f.properties;
      if (!p) continue;
      if (p.line !== undefined && isNight(String(p.line))) { p.color = BLACK; p.colorDark = BLACK; stats.badges++; }
      if (sort && Array.isArray(p.arr)) p.arr = order(p.arr);
    }
    wr('badges.geojson', badges);
  }

  // ---- the panel: meta.json ----
  const metaFile = join(dir, 'meta.json');
  if (existsSync(metaFile)) {
    const meta = rd('meta.json');
    if (Array.isArray(meta.lines)) {
      const key = (l) => String(l.label !== undefined && l.label !== null ? l.label : l.line);
      for (const l of meta.lines) {
        if (!isNight(key(l))) continue;
        l.color = BLACK; if (l.colorDark !== undefined) l.colorDark = BLACK;
        if (sort && l.rank === undefined) l.rank = 2;
        stats.meta++;
      }
      if (sort) {
        const firstMode = new Map();
        meta.lines.forEach((l, i) => { if (!firstMode.has(l.mode)) firstMode.set(l.mode, i); });
        // colours together: mode groups in their first-seen order, the green
        // trolleybuses at the head of their group, the black night lines last of all
        const grp = (l) => (isNight(key(l)) ? 1 : 0);
        const tro = (l) => (String(l.color).toLowerCase() === TROLLEY_GREEN ? 0 : 1);
        meta.lines = meta.lines.map((l, i) => ({ l, i })).sort((a, b) => (grp(a.l) - grp(b.l)) || (firstMode.get(a.l.mode) - firstMode.get(b.l.mode)) || (tro(a.l) - tro(b.l)) || (a.i - b.i)).map((x) => x.l);
      }
    }
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  }

  // ---- stops: line lists in the popups ----
  const stopsFile = join(dir, 'stops.geojson');
  if (sort && existsSync(stopsFile)) {
    const stops = rd('stops.geojson');
    for (const f of stops.features) {
      const p = f.properties;
      if (!p) continue;
      if (p.lines) { const o = order(split(p.lines)); if (joinList(o) !== p.lines) { p.lines = joinList(o); stats.stops++; } }
      if (Array.isArray(p.arr)) p.arr = order(p.arr);
    }
    wr('stops.geojson', stops);
  }
  return stats;
}

if (process.argv[1] && /night\.mjs$/.test(process.argv[1]) && process.argv[2]) {
  const [dir, re, ...rest] = process.argv.slice(2);
  const stats = nightPass(dir, new RegExp(re), { sort: rest.includes('--sort') });
  console.log(dir, JSON.stringify(stats));
}
