// Stop names and line keys as the street prints them (audit, 11.09.2026).
//
// A post-pass over the written outputs (data/out and docs/data carry the same
// files), run by build.mjs right after the night pass:
//  * stop names — spacing and stray punctuation (a comma with no space after
//    it, a dot with a space before it, a trailing "/" or "-"), names a feed cut
//    at N characters completed from the complete parentheticals of the same map,
//    one spelling where two differ only in letter case (the one most of the
//    map's stop points use), plus the city's own table below;
//  * line keys the city's table renames (merging two into one where both are
//    the same line on the street);
//  * headsigns — the chips' tooltips — tidied, and where the feed left them
//    empty, a bare number or an "A ↔ B" pair, the stop the direction ends at.
//
// Usage: node pipeline/names.mjs <dir> [--dry] [--list]
//   or  import { namesPass } from './names.mjs'; namesPass(outDir)

export const RULES = { lowerAbbr: true };

// ---------------------------------------------------------------------------
// The engine — identical in every map of the family; only RULES above differ.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// the files whose features ARE stops (never the street files: their "name" is
// a street)
const STOP_FILES = ['stops.geojson', 'badges.geojson', 'schematic/stops.geojson', 'schematic/terminals.geojson'];
// every file a line key can live in (lines, rows, badges, chips, Lines view,
// the network diagram)
const KEY_FILES = ['meta.json', 'route.geojson', 'streets.geojson', 'labels.geojson', 'stops.geojson',
  'badges.geojson', 'gtfs-shape.geojson', 'lines-meta.json', 'lines-rows.geojson',
  'lines-strands.geojson', 'lines-corridors.geojson',
  'schematic/network.geojson', 'schematic/numbers.geojson', 'schematic/terminals.geojson'];
// properties holding free text, never keys
const TEXT_PROPS = new Set(['name', 'headsign', 'street', 'label', 'opName', 'note']);

const ENT = { '&harr;': '↔', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—' };
const decode = (s) => s.replace(/&[a-z]+;|&#\d+;/g, (e) => ENT[e] ?? e);

// spacing and stray punctuation, the same in every language
export function tidy(n) {
  let s = decode(n).replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+,/g, ',');                                   // "Śląska ,Kościuszki"
  s = s.replace(/(?<=[\p{L}.)]),(?=[\p{L}\d])/gu, ', ');         // "Ořech,u školy"; digits-comma-digits stay
  s = s.replace(/(?<=\p{L})\s+\.(?=\p{L})/gu, '. ');             // "Αγ .Μελετίου"
  s = s.replace(/(?<=\p{L})\((?=\p{L})/gu, ' (');                // "Sportowa(Pabianice"
  if ((s.match(/\//g) || []).length === 1) s = s.replace(/\.?\/$/, ''); // "Szlachęcin/", "Baranowo./"
  s = s.replace(/(?<=\p{L}|\))\s*[-–]$/u, '');                   // "San Martín y Estrada-"
  return s.replace(/\s+/g, ' ').trim();
}

// unclosed "(" at the end — a feed that cut the name at N characters: complete
// the fragment from the complete parentheticals the same map uses, when only
// one starts with it; a stray extra ")" goes
function parens(n, complete) {
  const open = (n.match(/\(/g) || []).length, close = (n.match(/\)/g) || []).length;
  if (close > open) {
    let s = n;
    for (let k = close - open; k > 0; k--) {
      const i = s.lastIndexOf(')');
      s = s.slice(0, i) + s.slice(i + 1);
    }
    return s.replace(/\)\)/g, ')').replace(/\s+/g, ' ').trim();
  }
  if (open > close) {
    const m = n.match(/^(.*)\(([^()]*)$/);
    if (!m) return n;
    const frag = m[2].trim();
    const hits = frag.length >= 2 ? [...complete].filter((c) => c.startsWith(frag)) : [];
    if (hits.length === 1) return `${m[1].trimEnd()} (${hits[0]})`;
    if (hits.length > 1 && hits.every((h) => h === hits[0])) return `${m[1].trimEnd()} (${hits[0]})`;
    return `${m[1].trimEnd()} (${frag})`;
  }
  return n;
}

// one place, one spelling: names that differ only in letter case take one.
// The city's style decides: 'title' (English, Romance, Dutch: every word
// capitalised but the particles — of, de, la, van, di) or 'sentence' (Slavic,
// Greek, Hungarian, Nordic: only the first word and proper names); both keep
// acronyms (CFR, C.F.R., II, DN1, MAC VAL) and a capital first letter — except
// where the city starts a name with a lowercase abbreviation (ul., бул., ks.).
// A tie goes to the spelling most of the map's stop points use.
const SMALL = new Set(['of', 'the', 'and', 'at', 'on', 'in', 'de', 'del', 'des', 'du', 'da', 'do', 'dos', 'das', 'di', 'e', 'y', 'i', 'a', 'à', 'au', 'aux', 'en', 'et', 'la', 'les', 'le', 'lo', 'los', 'las', 'el', 'els', 'van', 'von', 'het', 'der', 'den', 'ten', 'ter', 'aan', 'op', 'bij', 'und', 'am', 'im', 'an', 'cu', 'și', 'din', 'pe', 'sub', 'es']);
const ARTICLES = new Set(['la', 'las', 'el', 'los']);
// street-type abbreviations a feed's capitals produce — not acronyms
const STREET = new Set(['AV', 'AVE', 'ST', 'RD', 'DR', 'PL', 'LA', 'LN', 'CT', 'BLVD', 'HWY', 'PKWY', 'PY', 'TPKE', 'EXPY', 'SQ', 'TER', 'CIR', 'BR', 'EP', 'EN', 'OPP']);
const words = (s) => s.match(/\p{L}[\p{L}'’]*/gu) || [];
const acr = (s) => (s.match(/(?<!\p{L})\p{Lu}{2,4}(?!\p{L})|(?:\p{Lu}\.){2,}/gu) || []).filter((w) => !STREET.has(w)).length;
let keepArticles = false;
function styleScore(s, style) {
  // the first word is the name's own capital — unless the name starts with a number
  const w = /^\P{L}*\d/u.test(s) ? words(s) : words(s).slice(1);
  if (style === 'title') {
    let sc = 0;
    for (const x of w) {
      const up = /^\p{Lu}/u.test(x), allUp = x.length > 1 && x === x.toLocaleUpperCase();
      const lc = x.toLocaleLowerCase();
      if (SMALL.has(lc) && !(keepArticles && ARTICLES.has(lc)) && !allUp) sc += up ? -1 : 1;
      else if (allUp && x.length >= 5) sc -= 2;
      else sc += (up ? 1 : -1) + (/\p{Ll}\p{Lu}/u.test(x) ? 1 : 0); // McArthur, OiLibya
    }
    return sc;
  }
  return -w.filter((x) => /^\p{Lu}/u.test(x) && !(x.length > 1 && x === x.toLocaleUpperCase())).length;
}
function caseUnify(counts, prefer, style, lowerAbbr) {
  const groups = new Map();
  for (const [n, c] of counts) {
    const k = n.toLocaleLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([n, c]);
  }
  const map = new Map();
  const head = (s) => (lowerAbbr && /^\p{L}{1,4}\.(\p{L}{1,2}\.)?(\s|$)/u.test(s)
    ? (/^\p{Ll}/u.test(s) ? 1 : 0) : (/^\p{Lu}|^\d/u.test(s) ? 1 : 0));
  for (const vs of groups.values()) {
    if (vs.length < 2) continue;
    const pick = vs.find(([n]) => prefer.has(n));
    vs.sort((a, b) => (head(b[0]) - head(a[0])) || (acr(b[0]) - acr(a[0]))
      || (styleScore(b[0], style) - styleScore(a[0], style)) || (b[1] - a[1]) || a[0].localeCompare(b[0]));
    const win = pick ? pick[0] : vs[0][0];
    for (const [n] of vs) if (n !== win) map.set(n, win);
  }
  return map;
}

const nearestStop = (stops, key, pt) => {
  let best = null, bd = Infinity;
  const kx = Math.cos((pt[1] * Math.PI) / 180);
  for (const f of stops) {
    if (!(f.properties.arr || []).includes(key)) continue;
    const [x, y] = f.geometry.coordinates;
    const d = ((x - pt[0]) * kx) ** 2 + (y - pt[1]) ** 2;
    if (d < bd) { bd = d; best = f; }
  }
  return best && Math.sqrt(bd) * 111320 < 800 ? best.properties.name : null;
};

// rename a line key everywhere it is a key (strings of ", "- or newline-joined
// numbers, arrays, object keys) — never inside free text
function renameKeys(o, R, prop) {
  if (typeof o === 'string') {
    if (TEXT_PROPS.has(prop)) return o;
    if (prop === 'text') {
      // the diagram's numbers: space-joined, and a key may hold a space itself
      let s = o;
      for (const [a, b] of R) {
        s = s.replace(new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?= |$)`, 'g'), `$1${b}`);
      }
      return s === o ? o : [...new Set(s.split(' '))].join(' ');
    }
    const parts = o.split(/(, |\n)/);
    let hit = false;
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
      const t = R.has(parts[i]) ? (hit = true, R.get(parts[i])) : parts[i];
      if (i > 0) out.push(parts[i - 1]);
      out.push(t);
    }
    if (!hit) return o;
    // a merged key can now appear twice in one list: keep the first
    const seen = new Set();
    const res = [];
    for (let i = 0; i < out.length; i += 2) {
      const sep = i > 0 ? out[i - 1] : null;
      if (out[i] !== '' && seen.has(out[i]) && sep === ', ') continue;
      seen.add(out[i]);
      if (sep !== null) res.push(sep);
      res.push(out[i]);
    }
    return res.join('').replace(/^, /, '');
  }
  if (Array.isArray(o)) {
    const a = o.map((v) => renameKeys(v, R, prop));
    const hit = a.some((v, i) => v !== o[i]);
    return hit && a.every((v) => typeof v === 'string') ? [...new Set(a)] : a;
  }
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      const nk = R.has(k) ? R.get(k) : k;
      if (nk in r && nk !== k) continue;
      r[nk] = renameKeys(v, R, k);
    }
    return r;
  }
  return o;
}

export function namesPass(dir, rules = RULES, opts = {}) {
  const log = opts.log || (() => {});
  const rd = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  // written back in the layout the build gave the file (meta.json is indented)
  const pretty = (f) => /^\{\s*\n\s+"/.test(readFileSync(join(dir, f), 'utf8').slice(0, 64));
  const wr = (f, o) => { if (!opts.dry) writeFileSync(join(dir, f), pretty(f) ? JSON.stringify(o, null, 2) : JSON.stringify(o), 'utf8'); };
  const report = { stops: new Map(), headsigns: 0, keys: 0 };

  // ---- 1. stop names ----
  const stopFiles = STOP_FILES.filter((f) => existsSync(join(dir, f)));
  const data = Object.fromEntries(stopFiles.map((f) => [f, rd(f)]));
  const exact = new Map(Object.entries(rules.stops || {}));
  const res = rules.stopRe || [];
  const step1 = (n) => {
    let s = exact.get(n) ?? n;
    for (const [re, to] of res) s = s.replace(re, to);
    return tidy(s);
  };
  const counts = new Map();
  const first = new Map();
  for (const f of stopFiles) for (const ft of data[f].features) {
    const n = ft.properties.name;
    if (typeof n !== 'string' || !n) continue;
    if (!first.has(n)) first.set(n, step1(n));
    if (f === 'stops.geojson') counts.set(first.get(n), (counts.get(first.get(n)) || 0) + 1);
  }
  const complete = new Set();
  for (const s of counts.keys()) for (const m of s.matchAll(/\(([^()]+)\)/g)) complete.add(m[1].trim());
  const second = new Map([...new Set(first.values())].map((s) => [s, parens(s, complete)]));
  const c2 = new Map();
  for (const [s, c] of counts) { const t = second.get(s); c2.set(t, (c2.get(t) || 0) + c); }
  keepArticles = !!rules.keepArticles;
  const unify = rules.caseUnify === false ? new Map() : caseUnify(c2, new Set(rules.prefer || []), rules.style || 'sentence', !!rules.lowerAbbr);
  const post = new Map(Object.entries(rules.after || {}));
  const final = (n) => {
    let s = second.get(first.get(n)) ?? n;
    s = unify.get(s) ?? s;
    return post.get(s) ?? s;
  };
  for (const f of stopFiles) {
    let changed = false;
    for (const ft of data[f].features) {
      const n = ft.properties.name;
      if (typeof n !== 'string' || !n) continue;
      const t = final(n);
      if (t !== n) { ft.properties.name = t; changed = true; report.stops.set(n, t); }
    }
    if (changed) wr(f, data[f]);
  }

  // ---- 2. headsigns (the chips' tooltips): tidied, and where the feed left
  // them empty, a bare number or a "A ↔ B" pair, the stop the direction ends at
  // (on the feed's own keys — before step 3 merges any)
  const meta = existsSync(join(dir, 'meta.json')) ? rd('meta.json') : null;
  let metaChanged = false;
  if (meta) {
    const hsFix = new Map(Object.entries(rules.headsigns || {}));
    const bad = (h) => !h || !h.trim() || /^\d+$/.test(h.trim()) || /&[a-z]+;|↔/.test(h);
    let ends = null;
    const endOf = (line, d) => {
      if (!ends) {
        ends = new Map();
        const route = existsSync(join(dir, 'route.geojson')) ? rd('route.geojson') : { features: [] };
        for (const f of route.features) {
          const g = f.geometry;
          const cs = g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates;
          if (!cs || cs.length < 2) continue;
          const k = f.properties.line + '|' + f.properties.dir;
          const prev = ends.get(k);
          if (!prev || prev.n < cs.length) ends.set(k, { n: cs.length, end: cs[cs.length - 1] });
        }
      }
      const e = ends.get(line + '|' + d);
      return e ? nearestStop(data['stops.geojson'] ? data['stops.geojson'].features : [], line, e.end) : null;
    };
    for (const l of meta.lines) for (const d of l.dirs || []) {
      let h = d.headsign || '';
      let t = hsFix.get(h) ?? (h ? tidy(h) : h);
      if (bad(t)) t = endOf(l.line, d.dir) || (t && !/^\d+$/.test(t) ? t.replace(/\s*↔\s*/g, ' – ') : '');
      if (t !== h) { d.headsign = t; metaChanged = true; report.headsigns++; }
    }
  }

  // ---- 3. line keys: renamed everywhere they are keys. Where the new key is
  // one the map already has, the renamed line merges into it: its panel entry
  // goes (its directions join the kept one only for the keys in mergeDirs — a
  // one-way line whose return the feed files as a second route)
  const R = new Map(Object.entries(rules.keys || {}));
  const mergeDirs = new Set(rules.mergeDirs || []);
  if (meta && R.size) {
    const renamedAny = meta.lines.some((l) => R.has(l.line));
    const byKey = new Map();
    for (const l of meta.lines) if (!R.has(l.line)) byKey.set(l.line, l);
    const kept = [];
    for (const l of meta.lines) {
      if (!R.has(l.line)) { kept.push(l); continue; }
      const to = R.get(l.line);
      const into = byKey.get(to);
      if (into) {
        if (mergeDirs.has(l.line)) {
          const ids = new Set(into.dirs.map((d) => d.dir));
          for (const d of l.dirs) {
            let id = d.dir;
            while (ids.has(id)) id = String(+id + 1);
            ids.add(id);
            into.dirs.push({ ...d, dir: id });
          }
        }
        continue;
      }
      l.line = to;
      byKey.set(to, l);
      kept.push(l);
    }
    if (renamedAny) metaChanged = true;
    meta.lines = kept;
  }
  if (meta && metaChanged) { wr('meta.json', renameKeys(meta, R, null)); report.keys += R.size ? 1 : 0; }
  if (R.size) {
    for (const f of KEY_FILES) {
      if (f === 'meta.json' || !existsSync(join(dir, f))) continue;
      const before = readFileSync(join(dir, f), 'utf8');
      if (![...R.keys()].some((k) => before.includes(JSON.stringify(k).slice(1, -1)))) continue;
      const o = JSON.parse(before);
      const s = JSON.stringify(renameKeys(o, R, null));
      if (s === JSON.stringify(o)) continue;
      wr(f, JSON.parse(s));
      report.keys++;
    }
  }

  log(`names: ${report.stops.size} stop spellings, ${report.headsigns} headsigns, ${report.keys} files with renamed keys`);
  return report;
}

// CLI: node pipeline/names.mjs <dir> [--dry]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  const dry = process.argv.includes('--dry');
  const r = namesPass(dir, RULES, { dry, log: console.log });
  if (process.argv.includes('--list')) for (const [a, b] of r.stops) console.log(`${a}  →  ${b}`);
}
