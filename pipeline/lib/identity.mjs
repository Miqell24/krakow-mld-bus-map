// Identity of the project a report is generated for — derived from the project itself,
// never written down here. Every city map in this family is a clone of the same
// pipeline, so a literal city name, publisher or package name in a template string
// travels with the clone and mislabels its reports (that is how Rio's gap report ended
// up titled "Poznań (ZTM)"). Nothing below is city-specific: copy this file into a new
// clone unchanged and it will report that clone's own identity.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readCsv } from './csv.mjs';

// Name of the pipeline, e.g. "rio-bus-map" — the project directory, which is also what
// package.json calls it.
export function pipelineName(root) {
  return basename(root);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// City or region the project covers, spelled the way its readers know it ("Rio de
// Janeiro", "GZM Metropolis", "Łódź"). Read from the web app's <title> — the one place
// in the project where that name is written out for humans — dropping the
// "— interactive map" suffix and the generic "Public Transport" tail. Falls back to the
// directory name for a project without a web app.
export function areaName(root) {
  const index = join(root, 'web/index.html');
  const title = (existsSync(index) ? readFileSync(index, 'utf8') : '').match(/<title>([\s\S]*?)<\/title>/i);
  if (title) {
    const area = title[1]
      .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
      .split(/\s+[—–|-]\s+/)[0]
      .replace(/\s+public\s+transport$/i, '')
      .trim();
    if (area) return area;
  }
  return basename(root)
    .replace(/-(bus|lines|rail)?-?map$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// Who published the feed: feed_info.txt when the feed carries one (the file is optional
// in GTFS and a third of these feeds ship without it), otherwise the operators named in
// agency.txt. Region-wide feeds are summarised instead of listed — Buenos Aires names
// 191 operators and none of them is "the publisher".
export async function publisherName(gtfsDir, feedInfo = {}) {
  const published = (feedInfo.feed_publisher_name || '').trim();
  if (published) return published;
  const agencies = join(gtfsDir, 'agency.txt');
  if (!existsSync(agencies)) return '—';
  const names = [...new Set((await readCsv(agencies)).map((a) => (a.agency_name || '').trim()).filter(Boolean))];
  if (!names.length) return '—';
  return names.length <= 3 ? names.join(' / ') : `${names.length} operators (see agency.txt)`;
}

// GTFS route_type -> coarse mode name, covering the basic types and the extended
// (Hierarchical Vehicle Type) ranges some feeds use — 700 is as much a bus as 3 is.
const BASIC = new Map([[0, 'tram'], [1, 'metro'], [2, 'rail'], [3, 'bus'], [4, 'ferry'],
  [5, 'cable tram'], [6, 'aerial lift'], [7, 'funicular'], [11, 'trolleybus'], [12, 'monorail']]);
const EXTENDED = [[100, 'rail'], [200, 'coach'], [400, 'urban rail'], [700, 'bus'],
  [800, 'trolleybus'], [900, 'tram'], [1000, 'water'], [1100, 'air'], [1200, 'ferry'],
  [1300, 'aerial lift'], [1400, 'funicular'], [1500, 'taxi'], [1700, 'other']];
export function modeOf(routeType) {
  const n = Number(routeType);
  if (!Number.isFinite(n)) return null;
  if (n < 100) return BASIC.get(n) || null;
  let mode = null;
  for (const [from, name] of EXTENDED) if (n >= from) mode = name;
  return mode;
}

// One word for what the analyzed routes are: "bus" only when every one of them runs on
// the road (coaches and trolleybuses count), otherwise the neutral "public transport" —
// so a rail feed like WKD, or a mixed one like Istanbul's, is never called a bus feed.
const ON_ROAD = new Set(['bus', 'coach', 'trolleybus']);
export function modeLabel(routeTypes) {
  const modes = new Set();
  for (const t of routeTypes) {
    const m = modeOf(t);
    if (m) modes.add(m);
  }
  return modes.size && [...modes].every((m) => ON_ROAD.has(m)) ? 'bus' : 'public transport';
}
