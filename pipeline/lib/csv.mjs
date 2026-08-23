// Streaming CSV parser for GTFS (large stop_times.txt): handles quotes, commas
// inside fields, BOM and CRLF. GTFS ZTP fields contain no embedded line breaks,
// so line-by-line parsing is safe.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Iterates over records as {column: value} objects.
export async function* iterCsv(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let header = null;
  for await (let line of rl) {
    if (line === '') continue;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!header) {
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      header = parseCsvLine(line).map((h) => h.trim());
      continue;
    }
    const vals = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = vals[i] ?? '';
    yield row;
  }
}

export async function readCsv(filePath) {
  const rows = [];
  for await (const r of iterCsv(filePath)) rows.push(r);
  return rows;
}
