// Export menu + vector PDF (user requests, 7.09.2026). The panel's three
// export buttons — current view, select area, whole map — each open a small
// PNG / PDF choice: PNG is the raster export app.js has always done, PDF is
// the map itself as vectors — every roadway, water body, park, transit
// stroke, stop disc and label a path or a text object, grouped into PDF
// layers (optional content groups) that Illustrator, Affinity and Inkscape
// show as layers. The source is what MapLibre draws: the style's layers in
// their order, each one's rendered features (so the labels are the ones
// that survived collision placement), every paint and layout property
// evaluated at the export zoom. The current view reads the map on screen;
// select area and whole map tile the bbox through an offscreen map at a
// poster zoom, exactly like the PNG export does. Text is set in the map's
// own Roboto Condensed, embedded from web/vendor. pdf-lib and fontkit load
// on the first PDF, not with the page.
(() => {
  const VERSION = '20260908i'; // stamped into the PDF's Producer, so a sheet says which script made it
  const PAD = 200;           // CSS px of tile overlap for label context
  const TILE = 2048;         // CSS px of the inner tile
  const MAX_PX = 65536;      // long edge of a poster sheet in CSS px — the PNG posters' ceiling
  const MAX_PT = 14000;      // long edge of the PDF page in points (Acrobat's 200-inch limit)
  const STOP_R = 13;         // stop marker radius, CSS px at icon-size 1 (the screen's disc is 7.5 — the poster wants them seen)
  const STOP_RIM = 3.5;      // its rim
  const DOT_R = 9.5;         // the full discs (termini, metro stations): a smaller boost, they sit inside badge grids and under names
  const NUMBER_BOOST = 1;    // the route-number labels, on top of the poster boost (1 = as placed; the panel's A+ buttons scale the export too)
  const STREET_NAME_SCALE = 0.9;                       // street names a touch smaller than the stop names (user rule)
  const STREET_NAME_INK = { r: 0.42, g: 0.42, b: 0.42 }; // and grey, so they read apart from the stop names
  const MAP = () => window.__map || (typeof map !== 'undefined' && map && map.getZoom ? map : null);

  const VARIANTS = [
    { id: 'export-png', label: 'Export — current view', kind: 'view', pngTitle: 'PNG: the visible view re-rendered at print density', pdfTitle: 'PDF: the visible view as vectors — paths and text in PDF layers, editable' },
    { id: 'export-area', label: 'Export — select area', kind: 'area', pngTitle: 'PNG: drag a rectangle, it is rendered at poster density', pdfTitle: 'PDF: drag a rectangle, it is drawn as vectors at poster zoom' },
    { id: 'export-atlas', label: 'Export — whole map', kind: 'whole', pngTitle: 'PNG: the entire network as one poster-grade image (several minutes)', pdfTitle: 'PDF: the entire network as vectors — big file, several minutes, keep the tab open' },
  ];
  const buttons = VARIANTS.map((v) => ({ ...v, btn: document.getElementById(v.id) })).filter((v) => v.btn);
  if (!buttons.length) return;

  // ---------- the menu ----------
  const css = document.createElement('style');
  css.textContent = `
  .export { position: relative; }
  .export .export-menu { position: absolute; z-index: 30; background: #fff; border: 1px solid #c9ced6; border-radius: 9px; box-shadow: 0 8px 24px rgba(0,0,0,.2); padding: 6px; display: flex; gap: 6px; }
  .export .export-menu button { display: block; width: auto; min-width: 104px; margin: 0; padding: 6px 10px; text-align: left; color: var(--kmk, #0b3d91); background: #f3f5f8; border: 1px solid #d5dae2; border-radius: 7px; line-height: 1.25; }
  .export .export-menu button:hover { background: var(--kmk, #0b3d91); color: #fff; }
  .export .export-menu .fmt { display: block; font-weight: 700; font-size: 13px; }
  .export .export-menu .sub { display: block; font-weight: 400; font-size: 11px; opacity: .8; }`;
  document.head.appendChild(css);
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  let passThrough = false;
  for (const v of buttons) {
    v.btn.textContent = v.label;
    v.btn.title = 'PNG or PDF — pick after the click';
    v.btn.addEventListener('click', (e) => {
      if (passThrough || v.btn.disabled) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (menu && menu.dataset.for === v.id) { closeMenu(); return; }
      closeMenu();
      menu = document.createElement('div');
      menu.className = 'export-menu'; menu.dataset.for = v.id;
      const mk = (fmt, title, sub) => {
        const b = document.createElement('button');
        b.type = 'button'; b.title = title;
        b.innerHTML = `<span class="fmt">${fmt}</span><span class="sub">${sub}</span>`;
        return b;
      };
      const bPng = mk('PNG', v.pngTitle, 'image'), bPdf = mk('PDF', v.pdfTitle, 'vector, editable');
      bPng.addEventListener('click', () => { closeMenu(); passThrough = true; try { v.btn.click(); } finally { passThrough = false; } });
      bPdf.addEventListener('click', () => { closeMenu(); runPdf(v).catch(() => {}); });
      menu.append(bPng, bPdf);
      const host = v.btn.parentElement;
      host.appendChild(menu);
      menu.style.left = v.btn.offsetLeft + 'px';
      menu.style.top = (v.btn.offsetTop + v.btn.offsetHeight + 4) + 'px';
    }, true);
    // app.js writes its own "Export PNG — …" back on the button when a raster
    // export ends; the short label wins again
    new MutationObserver(() => {
      if (!v.btn.disabled && /^Export PNG/.test(v.btn.textContent)) v.btn.textContent = v.label;
    }).observe(v.btn, { childList: true, characterData: true, subtree: true, attributes: true });
  }
  const busy = (on) => buttons.forEach((v) => { v.btn.disabled = on; });

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('cannot load ' + src));
    document.head.appendChild(s);
  });
  const ensureLibs = async () => {
    if (!window.PDFLib) await loadScript('vendor/pdf-lib.min.js');
    if (!window.fontkit) await loadScript('vendor/fontkit.umd.min.js');
  };

  async function runPdf(v) {
    const m = MAP();
    if (!m) { alert('The map is not ready yet.'); return; }
    let bbox = null;
    if (v.kind === 'area') {
      bbox = v.__bbox || await selectArea(m);
      if (!bbox) return;
    } else if (v.kind === 'whole') {
      const meta = await (await fetch('data/meta.json')).json();
      bbox = meta.bbox;
    }
    const label = v.label;
    busy(true);
    const setLbl = (t) => { v.btn.textContent = t; };
    try {
      setLbl('Loading the PDF engine…');
      await ensureLibs();
      const bytes = await exportPdf(m, bbox, setLbl);
      window.__lastPdf = bytes; // test hook
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      const city = (document.title.split(/\s+[—–|-]\s+/)[0] || 'map').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'map';
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${city}-${v.kind}-vector_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.pdf`;
      if (!window.__exportNoSave) { document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      setLbl('PDF saved ✓');
      await new Promise((r) => setTimeout(r, 2500));
    } catch (e) {
      console.error(e);
      setLbl('PDF failed — see console');
      await new Promise((r) => setTimeout(r, 2500));
    } finally { busy(false); setLbl(label); }
  }
  window.__pdfExport = (kind, bbox) => runPdf({ ...buttons.find((b) => b.kind === kind), kind, __bbox: bbox }); // test hook

  // ---------- rubber band (same feel as the PNG one) ----------
  function selectArea(m) {
    return new Promise((resolve) => {
      const cont = m.getContainer();
      const box = document.getElementById('area-box');
      const hint = document.getElementById('area-hint');
      if (hint) hint.style.display = 'block';
      cont.style.cursor = 'crosshair';
      m.dragPan.disable(); m.boxZoom.disable(); m.doubleClickZoom.disable();
      let p0 = null;
      const pt = (e) => { const r = cont.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      const move = (e) => {
        if (!p0 || !box) return;
        const p = pt(e);
        Object.assign(box.style, { display: 'block', left: Math.min(p0[0], p[0]) + 'px', top: Math.min(p0[1], p[1]) + 'px', width: Math.abs(p[0] - p0[0]) + 'px', height: Math.abs(p[1] - p0[1]) + 'px' });
      };
      const finish = (result) => {
        cont.removeEventListener('mousedown', down); window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up); window.removeEventListener('keydown', key);
        if (box) box.style.display = 'none'; if (hint) hint.style.display = 'none';
        cont.style.cursor = '';
        m.dragPan.enable(); m.boxZoom.enable(); m.doubleClickZoom.enable();
        resolve(result);
      };
      const down = (e) => { p0 = pt(e); e.preventDefault(); };
      const up = (e) => {
        if (!p0) return;
        const p = pt(e);
        if (Math.abs(p[0] - p0[0]) < 8 || Math.abs(p[1] - p0[1]) < 8) return finish(null);
        const a = m.unproject(p0), b = m.unproject(p);
        finish([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]);
      };
      const key = (e) => { if (e.key === 'Escape') finish(null); };
      cont.addEventListener('mousedown', down); window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up); window.addEventListener('keydown', key);
    });
  }

  // ---------- colour ----------
  const cctx = document.createElement('canvas').getContext('2d');
  const parseColor = (c) => {
    if (!c || typeof c !== 'string') return null;
    if (c[0] === '#') {
      const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
      return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1 };
    }
    const m = c.match(/^(rgba?|hsla?)\(([^)]*)\)/i);
    if (m && /^hsl/i.test(m[1])) {
      const p = m[2].split(',').map((x) => parseFloat(x));
      const [h, s, l] = [p[0] / 360, p[1] / 100, p[2] / 100];
      const k = (n) => (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return { r: f(0), g: f(8), b: f(4), a: p[3] === undefined ? 1 : p[3] };
    }
    if (m) {
      const p = m[2].split(',').map((x) => parseFloat(x));
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p[3] === undefined ? 1 : p[3] };
    }
    cctx.fillStyle = '#000'; cctx.fillStyle = c;
    return parseColor(cctx.fillStyle);
  };

  // ---------- a small evaluator for the style expressions this family uses ----------
  const OPS = new Set(['max', 'min', 'round', 'floor', 'ceil', 'abs', 'sqrt', '%', '^', 'ln', 'log2', 'log10', 'e', 'pi', 'literal', 'zoom', 'get', 'has', 'geometry-type', 'coalesce', 'case', 'match', 'interpolate', 'step', 'all', 'any', '!', '==', '!=', '<', '<=', '>', '>=', 'in', 'length', '*', '+', '-', '/', 'concat', 'to-string', 'to-number', 'upcase', 'downcase', 'string', 'number', 'boolean', 'format', 'let', 'var']);
  const lerp = (a, b, t) => (typeof a === 'number' && typeof b === 'number' ? a + (b - a) * t : (t < 0.5 ? a : b));
  function ev(x, z, p) {
    if (!Array.isArray(x)) return x;
    const op = x[0];
    if (!OPS.has(op)) return x; // a plain array — ["roboto_condensed_bold"], [0, 0.9] — is a value
    switch (op) {
      case 'literal': return x[1];
      case 'zoom': return z;
      case 'get': return p ? p[x[1]] : undefined;
      case 'has': return !!(p && p[x[1]] !== undefined);
      case 'geometry-type': return p && p.__geom;
      case 'coalesce': for (let i = 1; i < x.length; i++) { const v = ev(x[i], z, p); if (v !== undefined && v !== null && v !== '') return v; } return undefined;
      case 'case': for (let i = 1; i + 1 < x.length; i += 2) { if (ev(x[i], z, p)) return ev(x[i + 1], z, p); } return ev(x[x.length - 1], z, p);
      case 'match': {
        const v = ev(x[1], z, p);
        for (let i = 2; i + 1 < x.length; i += 2) { const lab = x[i]; if ((Array.isArray(lab) ? lab : [lab]).includes(v)) return ev(x[i + 1], z, p); }
        return ev(x[x.length - 1], z, p);
      }
      case 'interpolate': {
        const t = x[1][0]; const input = ev(x[2], z, p); const stops = x.slice(3);
        if (input <= stops[0]) return ev(stops[1], z, p);
        for (let i = 0; i + 2 < stops.length; i += 2) {
          if (input <= stops[i + 2]) {
            let f = (input - stops[i]) / (stops[i + 2] - stops[i]);
            if (t === 'exponential') { const b = x[1][1]; f = b === 1 ? f : (Math.pow(b, f * (stops[i + 2] - stops[i])) - 1) / (Math.pow(b, stops[i + 2] - stops[i]) - 1); }
            return lerp(ev(stops[i + 1], z, p), ev(stops[i + 3], z, p), f);
          }
        }
        return ev(stops[stops.length - 1], z, p);
      }
      case 'step': { const input = ev(x[1], z, p); let out = ev(x[2], z, p); for (let i = 3; i + 1 < x.length; i += 2) { if (input >= x[i]) out = ev(x[i + 1], z, p); } return out; }
      case 'all': return x.slice(1).every((c) => ev(c, z, p));
      case 'any': return x.slice(1).some((c) => ev(c, z, p));
      case '!': return !ev(x[1], z, p);
      case '==': return ev(x[1], z, p) == ev(x[2], z, p); // eslint-disable-line eqeqeq
      case '!=': return ev(x[1], z, p) != ev(x[2], z, p); // eslint-disable-line eqeqeq
      case '<': return ev(x[1], z, p) < ev(x[2], z, p);
      case '<=': return ev(x[1], z, p) <= ev(x[2], z, p);
      case '>': return ev(x[1], z, p) > ev(x[2], z, p);
      case '>=': return ev(x[1], z, p) >= ev(x[2], z, p);
      case 'in': { const v = ev(x[1], z, p); const hay = ev(x[2], z, p); return Array.isArray(hay) ? hay.includes(v) : typeof hay === 'string' ? hay.includes(v) : false; }
      case 'length': { const v = ev(x[1], z, p); return v == null ? 0 : v.length; }
      case '*': return x.slice(1).reduce((acc, e) => acc * (ev(e, z, p) ?? 1), 1);
      case '+': return x.slice(1).reduce((acc, e) => acc + (ev(e, z, p) ?? 0), 0);
      case '-': return x.length === 2 ? -ev(x[1], z, p) : ev(x[1], z, p) - ev(x[2], z, p);
      case '/': return ev(x[1], z, p) / ev(x[2], z, p);
      case 'concat': return x.slice(1).map((e) => ev(e, z, p) ?? '').join('');
      case 'to-string': return String(ev(x[1], z, p) ?? '');
      case 'to-number': return Number(ev(x[1], z, p));
      case 'upcase': return String(ev(x[1], z, p) ?? '').toUpperCase();
      case 'downcase': return String(ev(x[1], z, p) ?? '').toLowerCase();
      case 'string': case 'number': case 'boolean': return ev(x[1], z, p);
      case 'format': return x.slice(1).filter((_, i) => i % 2 === 0).map((e) => ev(e, z, p) ?? '').join('');
      case 'max': return Math.max(...x.slice(1).map((e) => ev(e, z, p)));
      case 'min': return Math.min(...x.slice(1).map((e) => ev(e, z, p)));
      case 'round': return Math.round(ev(x[1], z, p));
      case 'floor': return Math.floor(ev(x[1], z, p));
      case 'ceil': return Math.ceil(ev(x[1], z, p));
      case 'abs': return Math.abs(ev(x[1], z, p));
      case 'sqrt': return Math.sqrt(ev(x[1], z, p));
      case '%': return ev(x[1], z, p) % ev(x[2], z, p);
      case '^': return Math.pow(ev(x[1], z, p), ev(x[2], z, p));
      case 'ln': return Math.log(ev(x[1], z, p));
      case 'log2': return Math.log2(ev(x[1], z, p));
      case 'log10': return Math.log10(ev(x[1], z, p));
      case 'e': return Math.E;
      case 'pi': return Math.PI;
      case 'let': return ev(x[x.length - 1], z, p);
      case 'var': return undefined;
      default: return undefined;
    }
  }
  // A text-field as MapLibre's sections: `format` gives runs with their own
  // colour; anything else is one run in the layer's colour.
  function sectionsOf(x, z, p) {
    if (Array.isArray(x) && OPS.has(x[0])) {
      const op = x[0];
      if (op === 'format') {
        const out = [];
        for (let i = 1; i < x.length; i += 2) { const t = ev(x[i], z, p); const o = x[i + 1] && !Array.isArray(x[i + 1]) && typeof x[i + 1] === 'object' ? x[i + 1] : {}; if (t !== undefined && t !== null && t !== '') out.push({ text: String(t), color: o['text-color'] !== undefined ? ev(o['text-color'], z, p) : null }); }
        return out;
      }
      if (op === 'case') { for (let i = 1; i + 1 < x.length; i += 2) { if (ev(x[i], z, p)) return sectionsOf(x[i + 1], z, p); } return sectionsOf(x[x.length - 1], z, p); }
      if (op === 'coalesce') { for (let i = 1; i < x.length; i++) { const s = sectionsOf(x[i], z, p); if (s.length && s.some((q) => q.text !== '')) return s; } return []; }
      if (op === 'match') { const v = ev(x[1], z, p); for (let i = 2; i + 1 < x.length; i += 2) { const lab = x[i]; if ((Array.isArray(lab) ? lab : [lab]).includes(v)) return sectionsOf(x[i + 1], z, p); } return sectionsOf(x[x.length - 1], z, p); }
    }
    const v = ev(x, z, p);
    return v === undefined || v === null || v === '' ? [] : [{ text: String(v), color: null }];
  }
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const mxOf = (lng) => (lng + 180) / 360;
  const myOf = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

  // ---------- the poster styling of app.js (boostStyle is closure-private there) ----------
  const scaleOut = (v, f) => {
    if (typeof v === 'number') return v * f;
    if (Array.isArray(v)) {
      if (v[0] === 'interpolate') return v.map((x, i) => (i >= 3 && i % 2 === 0 ? scaleOut(x, f) : x));
      if (v[0] === 'case') return v.map((x, i) => ((i >= 2 && i % 2 === 0) || i === v.length - 1 ? scaleOut(x, f) : x));
      if (v[0] === '*') { const i = v.findIndex((x, j) => j > 0 && typeof x === 'number'); return i > 0 ? v.map((x, j) => (j === i ? x * f : x)) : ['*', f, v]; }
    }
    return v;
  };
  const boostStyle = (st, f) => {
    st = JSON.parse(JSON.stringify(st));
    for (const l of st.layers) {
      if (l.type === 'symbol') {
        if (l.layout && l.layout['text-size']) l.layout['text-size'] = scaleOut(l.layout['text-size'], f);
        if (l.layout && l.layout['icon-size']) l.layout['icon-size'] = scaleOut(l.layout['icon-size'], f);
        if (l.paint && l.paint['text-halo-width']) l.paint['text-halo-width'] = scaleOut(l.paint['text-halo-width'], f);
      }
      if (/^route-/.test(l.id) && l.paint && l.paint['line-width']) l.paint['line-width'] = scaleOut(l.paint['line-width'], f);
    }
    for (const id of ['highway-name-major', 'transit-street-names']) {
      const mi = st.layers.findIndex((l) => l.id === id);
      if (mi < 0) continue;
      const [lyr] = st.layers.splice(mi, 1);
      let last = -1;
      st.layers.forEach((l, i) => { if (/^street-numbers/.test(l.id)) last = i; });
      st.layers.splice(last >= 0 ? last + 1 : st.layers.length, 0, lyr);
    }
    for (const l of st.layers) {
      if (l.id === 'stops-names') l.layout = { ...l.layout, 'text-radial-offset': 2.0 };
      if (/^big-number-rows/.test(l.id)) l.layout = { ...l.layout, 'text-radial-offset': 1.2 };
    }
    return st;
  };
  const POSTER_BOOST = 1.4; // the PNG posters' factor

  // ---------- the content stream ----------
  // The page content is written directly — operator text deflated on the fly
  // through CompressionStream — not through pdf-lib's drawing API: a whole
  // city at poster zoom is millions of paths, and pdf-lib keeps every
  // operator as an object in memory (and registered a graphics state per
  // opacity per path). Only the compressed bytes ever exist in one piece.
  const enc = new TextEncoder();
  class Content {
    constructor() {
      this.parts = []; this.size = 0; this.chunks = [];
      this.cs = new CompressionStream('deflate'); // zlib framing = /FlateDecode
      this.w = this.cs.writable.getWriter();
      this.reading = (async () => { const rd = this.cs.readable.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; this.chunks.push(value); } })();
    }
    op(s) { this.parts.push(s); this.size += s.length; }
    async flush() { if (!this.parts.length) return; const s = this.parts.join('\n') + '\n'; this.parts = []; this.size = 0; await this.w.write(enc.encode(s)); }
    async finish() {
      await this.flush(); await this.w.close(); await this.reading;
      const n = this.chunks.reduce((a, c) => a + c.length, 0);
      const out = new Uint8Array(n); let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      return out;
    }
  }
  const f1 = (x) => { const r = Math.round(x * 10) / 10; return Number.isFinite(r) ? String(r) : '0'; };
  const f2 = (x) => { const r = Math.round(x * 100) / 100; return Number.isFinite(r) ? String(r) : '0'; };
  const f3 = (x) => String(Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000);
  const rgbS = (c) => f3(c.r) + ' ' + f3(c.g) + ' ' + f3(c.b);
  const KAPPA = 0.5523;

  // ---------- the export ----------
  async function exportPdf(m0, bbox, setLbl) {
    const { PDFDocument, PDFName, PDFString } = PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const [fReg, fBold] = await Promise.all(['vendor/RobotoCondensed-Regular.ttf', 'vendor/RobotoCondensed-Bold.ttf']
      .map(async (u) => doc.embedFont(await (await fetch(u)).arrayBuffer(), { subset: true })));
    const charset = { reg: new Set(fReg.getCharacterSet()), bold: new Set(fBold.getCharacterSet()) };
    doc.setTitle(document.title);
    doc.setProducer('transit-maps pdf-export ' + VERSION);
    doc.setCreator('miqell24.github.io/transit-maps');
    const ctx = doc.context;

    // Sheet geometry. The current view is the viewport at the screen's zoom.
    // The posters (select area, whole map) use the PNG posters' rule: the
    // bbox at z15.3 — or the screen's zoom when that is deeper, up to 17.3 —
    // and the poster boost. The sheet is scaled so its long edge stays
    // within 14 000 pt (Acrobat's 200-inch page limit; vectors lose nothing).
    let W, H, Z, S, tlx, tly, world, tiles = null;
    if (!bbox) {
      const cont = m0.getContainer();
      W = cont.clientWidth; H = cont.clientHeight; Z = m0.getZoom(); S = 0.75;
    } else {
      const fx = mxOf(bbox[2]) - mxOf(bbox[0]), fy = myOf(bbox[1]) - myOf(bbox[3]);
      const zFit = Math.log2(MAX_PX / (512 * Math.max(fx, fy)));
      Z = Math.min(zFit, Math.max(15.3, Math.min(m0.getZoom(), 17.3)));
      world = 512 * 2 ** Z;
      W = Math.round(fx * world); H = Math.round(fy * world);
      S = Math.min(0.75, MAX_PT / Math.max(W, H));
      tlx = mxOf(bbox[0]) * world; tly = myOf(bbox[3]) * world;
      tiles = { cols: Math.ceil(W / TILE), rows: Math.ceil(H / TILE) };
    }
    const PW = W * S, PH = H * S;
    const page = doc.addPage([PW, PH]);
    page.node.setFontDictionary(PDFName.of('F1'), fReg.ref);
    page.node.setFontDictionary(PDFName.of('F2'), fBold.ref);
    const C = new Content();

    // PDF layers: one optional content group per family of style layers
    const ocgs = new Map(); const ocgRefs = []; const props = ctx.obj({});
    const groupOf = (id, type, source) => {
      if (source === 'openmaptiles' || source === 'ne2_shaded' || id === 'background') {
        if (type === 'symbol') return 'Base map · names';
        if (id === 'building') return 'Base map · buildings';
        if (id === 'highway_path') return 'Base map · paths';
        if (/^(highway|road|tunnel|railway|boundary|aeroway-(taxiway|runway))/.test(id)) return 'Base map · roads & rail';
        return 'Base map · land & water';
      }
      if (/^(route|corridor|strand)-/.test(id)) return 'Transit lines';
      if (/^stops-terminus-badges/.test(id)) return 'Terminus badges';
      if (/^stops-terminus-names|^stops-names|^stops-metro-names/.test(id)) return 'Stop names';
      if (/^stops-/.test(id)) return 'Stops';
      if (/street-numbers|number-rows/.test(id)) return 'Line numbers';
      if (/street-names|highway-name/.test(id)) return 'Street names';
      if (/^journey-/.test(id)) return 'Journey';
      return 'Other';
    };
    const ocgFor = (name) => {
      if (ocgs.has(name)) return ocgs.get(name);
      const ref = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
      const key = 'oc' + (ocgs.size + 1);
      props.set(PDFName.of(key), ref); ocgRefs.push(ref); ocgs.set(name, key);
      return key;
    };
    let openGroup = null;
    const enter = (name) => {
      if (openGroup === name) return;
      if (openGroup) C.op('EMC');
      C.op('/OC /' + ocgFor(name) + ' BDC');
      openGroup = name;
    };
    const leave = () => { if (openGroup) { C.op('EMC'); openGroup = null; } };
    // one shared graphics state per opacity value
    const gsKeys = new Map();
    const alphaKey = (a) => {
      const k = Math.round(Math.max(0, Math.min(1, a)) * 100);
      if (k >= 100) return null;
      if (!gsKeys.has(k)) gsKeys.set(k, page.node.newExtGState('GSa', ctx.obj({ Type: 'ExtGState', ca: k / 100, CA: k / 100 })).toString());
      return gsKeys.get(k);
    };
    const withAlpha = (a, fn) => { const k = alphaKey(a); if (!k) return fn(); C.op('q ' + k + ' gs'); fn(); C.op('Q'); };
    const state = {
      C, S, W, H, PW, PH, fReg, fBold, enter, leave, groupOf, withAlpha, alphaKey, symBuf: new Map(),
      seen: new Set(),
      counts: { layers: 0, fills: 0, lines: 0, texts: 0, icons: 0 },
      clean: (t, bold) => [...String(t)].filter((ch) => (bold ? charset.bold : charset.reg).has(ch.codePointAt(0)) || ch === ' ' || ch === '\n').join(''),
      T: { idle: 0, draw: 0, query: 0 },
    };

    if (!bbox) {
      const px = (lng, lat) => { const q = m0.project([lng, lat]); return [q.x * S, (H - q.y) * S]; };
      C.op('q 0 0 ' + f1(PW) + ' ' + f1(PH) + ' re W n');
      drawScene(m0, px, null, state);
      leave(); C.op('Q');
    } else {
      // the offscreen map: the poster style, the live images, a tile-sized viewport
      const contCSS = TILE + 2 * PAD;
      const div = document.createElement('div');
      div.style.cssText = `position:fixed;left:-100000px;top:0;width:${contCSS}px;height:${contCSS}px;`;
      document.body.appendChild(div);
      const px2ll = (x, y) => { const n = Math.PI - (2 * Math.PI * y) / world; return [(x / world) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))]; };
      let m2 = null;
      try {
        // MapLibre parses tiles in one worker by default, and every viewport
        // of the sheet loads ~100 GeoJSON tiles: the export map gets its own
        // pool of four (the live map keeps the workers it has)
        try {
          const pool = m0.style && m0.style.dispatcher && m0.style.dispatcher.workerPool;
          if (pool && typeof maplibregl.setWorkerCount === 'function' && maplibregl.getWorkerCount() < 4) { maplibregl.setWorkerCount(4); pool.workers = null; }
        } catch (e) { /* the default pool then */ }
        m2 = new maplibregl.Map({ container: div, style: boostStyle(m0.getStyle(), POSTER_BOOST), center: px2ll(tlx + W / 2, tly + H / 2), zoom: Z, attributionControl: false, interactive: false, fadeDuration: 0 });
        const idle = () => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('tile render timeout')), 90000); m2.once('idle', () => { clearTimeout(t); res(); }); });
        await idle();
        // the canvas-drawn icons (stop discs, badge boxes) live only in the live map
        try { for (const id of m0.listImages()) { const im = m0.getImage(id); if (im && !m2.hasImage(id)) m2.addImage(id, im.data, { pixelRatio: im.pixelRatio, sdf: im.sdf }); } } catch (e) { console.warn('icons not copied', e); }
        m2.triggerRepaint(); await idle();
        const px = (lng, lat) => [(mxOf(lng) * world - tlx) * S, (H - (myOf(lat) * world - tly)) * S];
        let k = 0; const n = tiles.rows * tiles.cols; const T = state.T;
        for (let j = 0; j < tiles.rows; j++) {
          for (let i = 0; i < tiles.cols; i++) {
            k++;
            setLbl(`Drawing ${k}/${n}…`);
            const x0 = i * TILE, y0 = j * TILE;
            const w = Math.min(TILE, W - x0), h = Math.min(TILE, H - y0);
            m2.jumpTo({ center: px2ll(tlx + x0 + w / 2, tly + y0 + h / 2), zoom: Z });
            m2.triggerRepaint();
            const t0 = performance.now();
            await idle();
            T.idle += performance.now() - t0;
            if (window.__pdfDebug && window.__pdfDebug.snap === k) {
              // test hook: this tile as MapLibre drew it, for a side-by-side with the sheet
              await new Promise((res) => { m2.once('render', () => { try { window.__pdfDebug.png = m2.getCanvas().toDataURL('image/png'); } catch (e) { window.__pdfDebug.png = String(e); } res(); }); m2.triggerRepaint(); });
              window.__pdfDebug.rect = [x0, y0, w, h];
            }
            // page rect of this tile (PDF y up)
            const rect = [x0 * S, (H - y0 - h) * S, (x0 + w) * S, (H - y0) * S];
            C.op('q ' + f1(rect[0]) + ' ' + f1(rect[1]) + ' ' + f1(rect[2] - rect[0]) + ' ' + f1(rect[3] - rect[1]) + ' re W n');
            const t1 = performance.now();
            state.tileK = k;
            drawScene(m2, px, rect, state);
            T.draw += performance.now() - t1;
            leave(); C.op('Q');
            await C.flush();
          }
        }
      } finally {
        if (m2) try { m2.remove(); } catch (e) { /* gone */ }
        div.remove();
      }
    }
    // the symbols of the whole sheet, layer by layer in style order, above every tile
    setLbl('Labels…');
    // Cross-tile placement. Every tile is its own MapLibre viewport with its
    // own collision run, so two labels from neighbouring tiles can land on
    // one spot near the seam (the PNG posters hide this by cutting pixels at
    // the seam). The layers are walked the way MapLibre places them, top of
    // the style first, and a label whose box meets one already kept from
    // ANOTHER tile is dropped; labels of one tile never collide with each
    // other (MapLibre placed them together). Allow-overlap layers keep
    // everything but still claim their boxes, like on screen.
    const order = m0.getStyle().layers.map((l) => l.id).filter((id) => state.symBuf.has(id));
    const cell = 400; const grid = new Map();
    const cellsOf = (bx) => { const r = []; for (let i = Math.floor(bx[0] / cell); i <= Math.floor(bx[2] / cell); i++) for (let j = Math.floor(bx[1] / cell); j <= Math.floor(bx[3] / cell); j++) r.push(i + ':' + j); return r; };
    const hits = (bx, tile) => { for (const key of cellsOf(bx)) { const a = grid.get(key); if (!a) continue; for (const q of a) if (q.tile !== tile && q.b[0] < bx[2] && q.b[2] > bx[0] && q.b[1] < bx[3] && q.b[3] > bx[1]) return true; } return false; };
    const insert = (bx, tile) => { for (const key of cellsOf(bx)) { let a = grid.get(key); if (!a) grid.set(key, a = []); a.push({ b: bx, tile }); } };
    state.counts.dropped = 0;
    for (const id of [...order].reverse()) {
      for (const r of state.symBuf.get(id).recs) {
        if (!r.box) { r.keep = true; continue; }
        if (r.allow || !hits(r.box, r.tile)) { r.keep = true; if (!r.ignore) insert(r.box, r.tile); } else { r.keep = false; state.counts.dropped++; }
      }
    }
    for (const id of order) { const buf = state.symBuf.get(id); enter(buf.group); for (const r of buf.recs) if (r.keep) for (const o of r.ops) C.op(o); leave(); await C.flush(); }
    state.symBuf.clear();
    // attribution, bottom right, as text
    const attr = (document.querySelector('.maplibregl-ctrl-attrib-inner') || {}).textContent || '© OpenStreetMap contributors · OpenFreeMap';
    enter('Attribution');
    const at = state.clean(attr.replace(/\s+/g, ' ').trim(), false);
    const asz = Math.max(6, Math.min(9, PW / 120));
    const aw = fReg.widthOfTextAtSize(at, asz);
    withAlpha(0.82, () => C.op('1 1 1 rg ' + f2(PW - aw - asz) + ' 0 ' + f2(aw + asz) + ' ' + f2(asz * 1.8) + ' re f'));
    C.op('BT /F1 ' + f2(asz) + ' Tf 0.2 0.2 0.2 rg 1 0 0 1 ' + f2(PW - aw - asz / 2) + ' ' + f2(asz * 0.5) + ' Tm ' + fReg.encodeText(at).toString() + ' Tj ET');
    leave();
    setLbl('Saving…');
    const bytes = await C.finish();
    const stream = ctx.stream(bytes, { Filter: 'FlateDecode' });
    page.node.set(PDFName.of('Contents'), ctx.register(stream));
    if (ocgRefs.length) {
      page.node.set(PDFName.of('Resources'), page.node.Resources() || ctx.obj({}));
      page.node.Resources().set(PDFName.of('Properties'), props);
      doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: ocgRefs, D: ctx.obj({ Order: ocgRefs, ON: ocgRefs, BaseState: 'ON' }) }));
    }
    window.__pdfStats = { W, H, Z, S, tiles, ...state.counts, content: bytes.length, ms: state.T }; console.log('pdf-export', { W, H, Z: Math.round(Z * 100) / 100, S: Math.round(S * 1000) / 1000, tiles, ...state.counts, content: bytes.length, ms: Object.fromEntries(Object.entries(state.T).map(([k, v]) => [k, Math.round(v)])) });
    return doc.save({ useObjectStreams: false });
  }

  // Draws everything the map m has on screen into the page, through px()
  // (lon/lat → page points). rect (page space) is the tile's own area: fills
  // and lines are clipped to it by the caller, symbols are taken only when
  // their anchor is inside it, so the overlap between tiles is context, not
  // duplication.
  function drawScene(m, px, rect, st) {
    const { C, S, PH, fReg, fBold, clean, seen, counts, enter, leave, groupOf, withAlpha, alphaKey } = st;
    const z = m.getZoom();
    const col = (c, alphaMul) => { const k = parseColor(c); return k ? { r: k.r, g: k.g, b: k.b, a: Math.max(0, Math.min(1, k.a * (alphaMul ?? 1))) } : null; };
    const asRings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
    const asLines = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : []);
    const asPoints = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : []);
    // a path in page space, vertices closer than 0.15 pt to the last one
    // written dropped (invisible at any print size, a third of the file)
    const EPS = 0.15;
    const pathOf = (coords, close) => {
      let d = '', lx = NaN, ly = NaN, n = 0;
      for (let i = 0; i < coords.length; i++) {
        const [x, y] = px(coords[i][0], coords[i][1]);
        if (i && i < coords.length - 1 && Math.abs(x - lx) < EPS && Math.abs(y - ly) < EPS) continue;
        d += f1(x) + ' ' + f1(y) + (n ? ' l ' : ' m '); lx = x; ly = y; n++;
      }
      if (n < 2 && !close) return '';
      return d + (close ? 'h' : '');
    };
    const inRect = (x, y) => !rect || (x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]);
    const cw = m.getContainer().clientWidth, ch = m.getContainer().clientHeight;
    const rectOnScreen = rect ? [PAD, PAD, cw - PAD, ch - PAD] : null;
    // MapLibre's line breaking (shaping.ts): break candidates after spaces
    // (and forced at newlines), the target line width = total / ceil(total /
    // max width), the least-bad set of breaks by squared raggedness — so the
    // rows come out the shape the collision boxes were placed with
    const breakLines = (chars, adv, maxW) => {
      const n = chars.length;
      const total = adv.reduce((a, b) => a + b, 0);
      const hasNl = chars.some((q) => q.ch === '\n');
      const rowsOf = (breaks) => { const rows = []; let start = 0; for (const b of [...breaks, n]) { const row = []; for (let i = start; i < b; i++) if (chars[i].ch !== '\n' && !(i === b - 1 && chars[i].ch === ' ')) row.push(i); rows.push(row); start = b; } return rows; };
      if (!maxW || (total <= maxW && !hasNl)) return [chars.map((_, i) => i)];
      const target = total / Math.max(1, Math.ceil(total / maxW));
      const cand = []; let x = 0;
      for (let i = 0; i < n; i++) { x += adv[i]; if (chars[i].ch === ' ' || chars[i].ch === '\n') cand.push({ index: i + 1, x, penalty: chars[i].ch === '\n' ? -10000 : 0 }); }
      const bad = (lw, penalty, last) => { const r = (lw - target) * (lw - target); return last && lw < target ? r / 2 : r + penalty * Math.abs(penalty); }; // a newline's negative penalty forces the break
      const memo = new Map();
      const evalBreak = (idx, bx, penalty, last) => {
        const key = idx + '|' + last; if (memo.has(key)) return memo.get(key);
        let best = { badness: bad(bx, penalty, last), prior: null, index: idx };
        for (const c of cand) { if (c.index >= idx) break; const prior = evalBreak(c.index, c.x, c.penalty, false); const b = bad(bx - c.x, penalty, last) + prior.badness; if (b <= best.badness) best = { badness: b, prior, index: idx }; }
        memo.set(key, best); return best;
      };
      const breaks = []; let node = evalBreak(n, total, 0, true);
      while (node && node.prior) { breaks.unshift(node.prior.index); node = node.prior; }
      return rowsOf(breaks);
    };
    const circle = (x, y, r) => {
      const k = KAPPA * r;
      return f2(x + r) + ' ' + f2(y) + ' m ' +
        f2(x + r) + ' ' + f2(y + k) + ' ' + f2(x + k) + ' ' + f2(y + r) + ' ' + f2(x) + ' ' + f2(y + r) + ' c ' +
        f2(x - k) + ' ' + f2(y + r) + ' ' + f2(x - r) + ' ' + f2(y + k) + ' ' + f2(x - r) + ' ' + f2(y) + ' c ' +
        f2(x - r) + ' ' + f2(y - k) + ' ' + f2(x - k) + ' ' + f2(y - r) + ' ' + f2(x) + ' ' + f2(y - r) + ' c ' +
        f2(x + k) + ' ' + f2(y - r) + ' ' + f2(x + r) + ' ' + f2(y - k) + ' ' + f2(x + r) + ' ' + f2(y) + ' c h';
    };
    // a rounded rectangle path (corner radius r)
    const rrect = (x, y, w, h, r) => {
      const k = KAPPA * r;
      return f2(x + r) + ' ' + f2(y) + ' m ' + f2(x + w - r) + ' ' + f2(y) + ' l ' +
        f2(x + w - r + k) + ' ' + f2(y) + ' ' + f2(x + w) + ' ' + f2(y + r - k) + ' ' + f2(x + w) + ' ' + f2(y + r) + ' c ' +
        f2(x + w) + ' ' + f2(y + h - r) + ' l ' +
        f2(x + w) + ' ' + f2(y + h - r + k) + ' ' + f2(x + w - r + k) + ' ' + f2(y + h) + ' ' + f2(x + w - r) + ' ' + f2(y + h) + ' c ' +
        f2(x + r) + ' ' + f2(y + h) + ' l ' +
        f2(x + r - k) + ' ' + f2(y + h) + ' ' + f2(x) + ' ' + f2(y + h - r + k) + ' ' + f2(x) + ' ' + f2(y + h - r) + ' c ' +
        f2(x) + ' ' + f2(y + r) + ' l ' +
        f2(x) + ' ' + f2(y + r - k) + ' ' + f2(x + r - k) + ' ' + f2(y) + ' ' + f2(x + r) + ' ' + f2(y) + ' c h';
    };
    const textOp = (font, key, str, size, x, y, ang, colorOp) => {
      const th = (-ang) * Math.PI / 180, a = Math.cos(th), b = Math.sin(th);
      return 'BT /' + key + ' ' + f2(size) + ' Tf ' + colorOp + f2(a) + ' ' + f2(b) + ' ' + f2(-b) + ' ' + f2(a) + ' ' + f2(x) + ' ' + f2(y) + ' Tm ' + font.encodeText(str).toString() + ' Tj ET';
    };

    // one query for the whole scene, bucketed by layer id; the style order
    // still drives the drawing
    const byLayer = new Map();
    const tq = performance.now();
    try {
      const all = rectOnScreen ? m.queryRenderedFeatures([[rectOnScreen[0] - 40, rectOnScreen[1] - 40], [rectOnScreen[2] + 40, rectOnScreen[3] + 40]]) : m.queryRenderedFeatures();
      for (const f of all) { const id = f.layer && f.layer.id; if (!id) continue; let a = byLayer.get(id); if (!a) byLayer.set(id, a = []); a.push(f); }
    } catch (e) { console.warn('pdf-export query', e); }
    st.T.query += performance.now() - tq;
    const layers = m.getStyle().layers.filter((L) => !(L.layout && L.layout.visibility === 'none') && !(L.minzoom !== undefined && z < L.minzoom) && !(L.maxzoom !== undefined && z >= L.maxzoom));
    const propsOf = (f) => {
      const p = { ...f.properties, __geom: f.geometry.type };
      for (const k in p) { const v = p[k]; if (typeof v === 'string' && (v[0] === '[' || v[0] === '{')) { try { p[k] = JSON.parse(v); } catch (e) { /* a real string */ } } } // queryRenderedFeatures stringifies nested values
      return p;
    };

    // ---- pass 1: the symbols — exactly the ones MapLibre placed, where it
    // placed them. Read from the renderer's own state (symbol instances,
    // placement, the label's line vertices), so the sheet carries the same
    // labels as the screen and the PNG posters: every placed street name
    // runs along its street glyph by glyph, every stop name sits at the
    // anchor MapLibre chose. ----
    const symOps = new Map();
    for (const L of layers) {
      if (L.type !== 'symbol') continue;
      const out = [];
      try {
        const items = placedSymbolsOf(L);
        if (items) drawSymbols(L, items, out);
        else { const feats = byLayer.get(L.id); if (feats) drawSymbols(L, feats.map(fallbackItem), out); }
      } catch (e) { console.warn('pdf-export symbols', L.id, e); }
      symOps.set(L.id, out);
    }

    // ---- pass 2: everything in style order ----
    for (const L of layers) {
      const group = groupOf(L.id, L.type, L.source);
      if (L.type === 'background') {
        enter(group);
        const c = col(ev(m.getPaintProperty(L.id, 'background-color'), z, {}), num(ev(m.getPaintProperty(L.id, 'background-opacity'), z, {}), 1));
        if (c) withAlpha(c.a, () => C.op(rgbS(c) + ' rg ' + (rect ? f1(rect[0]) + ' ' + f1(rect[1]) + ' ' + f1(rect[2] - rect[0]) + ' ' + f1(rect[3] - rect[1]) : '0 0 ' + f1(st.PW) + ' ' + f1(PH)) + ' re f'));
        continue;
      }
      if (L.type === 'symbol') {
        const ops = symOps.get(L.id);
        if (!ops || !ops.some((r) => r.ops.length)) continue;
        counts.layers++;
        // symbols are kept for the end of the sheet: a label reaching past
        // its tile's edge would otherwise be painted over by the next tile's
        // ground (and they must not be clipped to the tile)
        let buf = st.symBuf.get(L.id);
        if (!buf) st.symBuf.set(L.id, buf = { group, recs: [] });
        for (const r of ops) if (r.ops.length) buf.recs.push(r);
        continue;
      }
      if (!['fill', 'line', 'circle'].includes(L.type)) continue;
      const feats = byLayer.get(L.id);
      if (!feats || !feats.length) continue;
      feats.reverse(); // the query lists the top-most feature first
      counts.layers++;
      enter(group);
      const paint = (k) => m.getPaintProperty(L.id, k);
      const layout = (k) => m.getLayoutProperty(L.id, k);
      for (const f of feats) {
        const p = propsOf(f);
        const g = f.geometry;
        if (L.type === 'fill') {
          const c = col(ev(paint('fill-color'), z, p), num(ev(paint('fill-opacity'), z, p), 1));
          if (!c) continue;
          withAlpha(c.a, () => {
            for (const rings of asRings(g)) { const d = rings.map((r) => pathOf(r, true)).join(' '); if (d) { C.op(rgbS(c) + ' rg ' + d + ' f*'); counts.fills++; } }
          });
          const oc = col(ev(paint('fill-outline-color'), z, p), 1);
          if (oc) withAlpha(oc.a, () => { for (const rings of asRings(g)) { const d = rings.map((r) => pathOf(r, true)).join(' '); if (d) C.op(rgbS(oc) + ' RG ' + f2(0.4 * S) + ' w ' + d + ' S'); } });
        } else if (L.type === 'line') {
          const c = col(ev(paint('line-color'), z, p), num(ev(paint('line-opacity'), z, p), 1));
          const w = num(ev(paint('line-width'), z, p), 1) * S;
          if (!c || w <= 0) continue;
          const dash = ev(paint('line-dasharray'), z, p);
          const cap = ev(layout('line-cap'), z, p);
          const pre = rgbS(c) + ' RG ' + f2(w) + ' w ' + (cap === 'round' ? '1 J 1 j' : cap === 'square' ? '2 J 0 j' : '0 J 0 j') + (Array.isArray(dash) ? ' [' + dash.map((d) => f2(Math.max(0.01, d * w))).join(' ') + '] 0 d' : ' [] 0 d');
          withAlpha(c.a, () => {
            for (const line of asLines(g)) {
              if (line.length < 2) continue;
              const d = pathOf(line, false);
              if (d) { C.op(pre + ' ' + d + ' S'); counts.lines++; }
            }
          });
        } else if (L.type === 'circle') {
          const c = col(ev(paint('circle-color'), z, p), num(ev(paint('circle-opacity'), z, p), 1));
          const r = num(ev(paint('circle-radius'), z, p), 3) * S;
          if (!c) continue;
          for (const pt of asPoints(g)) { const [x, y] = px(pt[0], pt[1]); if (!inRect(x, y)) continue; withAlpha(c.a, () => C.op(rgbS(c) + ' rg ' + circle(x, y, r) + ' f')); counts.icons++; }
        }
      }
    }

    // The placed symbols of one layer, read from MapLibre's renderer state.
    // The renderer keeps, per tile bucket, every glyph quad it drew: four
    // vertices carrying the quad's offsets from the label's point (24-px em
    // units, rotation and offsets baked in), the point itself in the
    // dynamic array — screen pixels for line labels and variable anchors,
    // pixels from the tile's origin for map-pitched text, tile units for
    // fixed anchors — the glyph's rotation, its paint colour (the `format`
    // sections' own colours included), and an opacity that is zero for
    // everything collision placement dropped. So the sheet gets each glyph
    // exactly where the screen and the PNG posters have it: wrapping,
    // justification, the variable anchor chosen, offsets, rotation and the
    // curve along a street included. Returns null when the internals are
    // not there (another MapLibre build) — the caller then falls back to
    // the rendered-feature query and its own layout.
    function placedSymbolsOf(L) {
      const style = m.style;
      const cache = style && style.sourceCaches && style.sourceCaches[L.source];
      const placement = style && style.placement;
      if (!cache || !placement || !placement.placements || typeof cache.getRenderableIds !== 'function') return null;
      const layout = (k) => m.getLayoutProperty(L.id, k);
      const isLine = (layout('symbol-placement') || 'point') !== 'point';
      const va = layout('text-variable-anchor');
      const variable = Array.isArray(va) && va.length > 0;
      let ra = layout('text-rotation-alignment') || 'auto'; if (ra === 'auto') ra = isLine ? 'map' : 'viewport';
      let pa = layout('text-pitch-alignment') || 'auto'; if (pa === 'auto') pa = ra;
      const mode = pa === 'map' ? 'tilepx' : (isLine || variable) ? 'css' : 'tile';
      // container px → page: linear at pitch 0
      const q0 = m.unproject([0, 0]), q1 = m.unproject([1, 1]);
      const P0 = px(q0.lng, q0.lat), P1 = px(q1.lng, q1.lat);
      const kx = P1[0] - P0[0], ky = P1[1] - P0[1];
      const cssToPage = (x, y) => [P0[0] + x * kx, P0[1] + y * ky];
      const items = [];
      const EXT = 8192;
      for (const id of cache.getRenderableIds(true)) {
        const tile = cache.getTileByID(id);
        if (!tile || !tile.buckets) continue;
        const b = tile.buckets[L.id];
        if (!b || !b.symbolInstances || !b.text || !b.text.placedSymbolArray) continue;
        const fi = tile.latestFeatureIndex;
        if (!fi || typeof fi.loadVTLayers !== 'function') return null;
        const vt = fi.loadVTLayers();
        const name = fi.sourceLayerCoder.decode(b.sourceLayerIndex);
        const vl = vt[name];
        if (!vl) continue;
        const c = tile.tileID.canonical; const n = 2 ** c.z;
        const ll = (x, y) => { const X = (c.x + x / EXT) / n, Y = (c.y + y / EXT) / n; return [X * 360 - 180, (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * Y)))]; };
        const o = m.project(ll(0, 0)); // the tile's origin on the container
        const lv = b.text.layoutVertexArray && b.text.layoutVertexArray.int16;
        const dv = b.text.dynamicLayoutVertexArray && b.text.dynamicLayoutVertexArray.float32;
        const ov = b.text.opacityVertexArray && b.text.opacityVertexArray.uint8;
        const sd = b.textSizeData || {};
        let bucketSize = null;
        if (sd.kind === 'constant') bucketSize = sd.layoutSize;
        else if (sd.kind === 'camera') { const t = sd.maxZoom > sd.minZoom ? Math.max(0, Math.min(1, (z - sd.minZoom) / (sd.maxZoom - sd.minZoom))) : 0; bucketSize = sd.minSize + (sd.maxSize - sd.minSize) * t; }
        let binders = null;
        try { const pc = b.text.programConfigurations; const cfg = pc && pc.programConfigurations && pc.programConfigurations[L.id]; binders = cfg && cfg.binders; } catch (e) { binders = null; }
        // a data-driven paint value at a vertex (null when the property is a uniform)
        const colorAt = (key, v) => { const bd = binders && binders[key]; const arr = bd && bd.paintVertexArray && bd.paintVertexArray.uint16; if (!arr) return null; const per = bd.paintVertexArray.bytesPerElement / 2; const a = arr[v * per], bb = arr[v * per + 1]; return { r: Math.floor(a / 256) / 255, g: (a % 256) / 255, b: Math.floor(bb / 256) / 255, a: (bb % 256) / 255 }; };
        const numAt = (key, v) => { const bd = binders && binders[key]; const arr = bd && bd.paintVertexArray && bd.paintVertexArray.float32; if (!arr) return null; const per = bd.paintVertexArray.bytesPerElement / 4; const x = arr[v * per]; return Number.isFinite(x) ? x : null; };
        for (let i = 0; i < b.symbolInstances.length; i++) {
          const si = b.symbolInstances.get(i);
          const pl = placement.placements[si.crossTileID];
          const vf = vl.feature(si.featureIndex);
          if (!vf) continue;
          const a = ll(si.anchorX, si.anchorY);
          const item = { p: propsOf({ properties: vf.properties, geometry: { type: vf.type === 1 ? 'Point' : vf.type === 2 ? 'LineString' : 'Polygon' } }), anchor: px(a[0], a[1]), line: null, segment: 0, anchorName: null, text: false, icon: !!(pl && pl.icon), glyphs: null, size: bucketSize };
          // a data-driven text-size (the badges: per-feature shrink) is evaluated here per feature
          if (item.size == null) { const s = ev(layout('text-size'), z, item.p); item.size = typeof s === 'number' && Number.isFinite(s) ? s : null; }
          const size = item.size;
          const psis = [si.centerJustifiedTextSymbolIndex, si.leftJustifiedTextSymbolIndex, si.rightJustifiedTextSymbolIndex];
          if (lv && dv && ov && size != null) {
            for (const psi of psis) {
              if (!(psi >= 0)) continue;
              const ps = b.text.placedSymbolArray.get(psi);
              if (ps.hidden) continue;
              const v0 = ps.vertexStartIndex;
              if (!ov[v0] || !Number.isFinite(dv[v0 * 3])) continue;
              const fs = size / 24;
              const glyphs = [];
              let ok = true;
              for (let g = 0; g < ps.numGlyphs && ok; g++) {
                const corners = [];
                for (let k = 0; k < 4; k++) {
                  const v = v0 + g * 4 + k;
                  let bx, by;
                  if (mode === 'css') { bx = dv[3 * v]; by = dv[3 * v + 1]; }
                  else if (mode === 'tilepx') { bx = o.x + dv[3 * v]; by = o.y + dv[3 * v + 1]; }
                  else { const q = m.project(ll(lv[12 * v], lv[12 * v + 1])); bx = q.x; by = q.y; }
                  if (!Number.isFinite(bx) || !Number.isFinite(by)) { ok = false; break; }
                  const ang = dv[3 * v + 2]; const ox = lv[12 * v + 2] / 32 * fs, oy = lv[12 * v + 3] / 32 * fs;
                  const ca = Math.cos(ang), sa = Math.sin(ang);
                  corners.push(cssToPage(bx + ca * ox - sa * oy, by + sa * ox + ca * oy));
                }
                if (!ok) break;
                const gv = v0 + g * 4;
                glyphs.push({ c: corners, color: colorAt('text-color', gv), halo: colorAt('text-halo-color', gv), hw: numAt('text-halo-width', gv), op: numAt('text-opacity', gv) });
              }
              if (ok && glyphs.length) { item.text = true; item.glyphs = glyphs; }
              break;
            }
          }
          if (!item.text && pl && pl.text) {
            // placed, but its quads could not be read: the fallback layout gets the line and the anchor
            item.text = true;
            const psi = psis.find((x) => x >= 0);
            const ps = psi >= 0 ? b.text.placedSymbolArray.get(psi) : null;
            if (ps && ps.lineLength > 1 && b.lineVertexArray) {
              item.line = [];
              for (let k = 0; k < ps.lineLength; k++) { const q = ll(b.lineVertexArray.getx(ps.lineStartIndex + k), b.lineVertexArray.gety(ps.lineStartIndex + k)); item.line.push(px(q[0], q[1])); }
              item.segment = ps.segment;
            }
            const vo = placement.variableOffsets[si.crossTileID];
            item.anchorName = vo ? vo.anchor : null;
          }
          if (item.text || item.icon) items.push(item);
        }
      }
      return items;
    }
    // the fallback: a rendered feature as a symbol item at its point, or at
    // the middle of its line
    function fallbackItem(f) {
      const g = f.geometry;
      let a = asPoints(g)[0];
      let line = null, segment = 0;
      if (!a) { const ln = asLines(g)[0]; if (!ln) return null; a = ln[Math.floor(ln.length / 2)]; line = ln.map((c) => px(c[0], c[1])); segment = Math.max(0, Math.floor(ln.length / 2) - 1); }
      return { p: propsOf(f), anchor: px(a[0], a[1]), line, segment, anchorName: null, text: true, icon: true, glyphs: null, size: null };
    }

    // Draws the symbols of one layer: icons (stop discs, badge boxes) and
    // labels. A label with its glyph quads read from the renderer is set
    // glyph by glyph onto those quads — each glyph's ink box centred where
    // MapLibre's is — merged into one text object per straight row with
    // TJ position adjustments, so it stays one editable line in Illustrator.
    // Without quads (another MapLibre build, a glyph the sheet's font lacks)
    // the label is laid out here: a point label at its anchor with the
    // chosen variable anchor, a line label glyph by glyph along its line.
    function drawSymbols(L, items, out) {
      const paint = (k) => m.getPaintProperty(L.id, k);
      const layout = (k) => m.getLayoutProperty(L.id, k);
      // one record per symbol: its operators, its text box (page pts) for
      // the cross-tile placement, and whether the layer lets it overlap
      let cur = null;
      const push = (s) => cur.ops.push(s);
      const alpha = (a, fn) => { const k = alphaKey(a); if (!k) return fn(); push('q ' + k + ' gs'); fn(); push('Q'); };
      const allowOverlap = !!ev(layout('text-allow-overlap'), z, {}), ignorePlacement = !!ev(layout('text-ignore-placement'), z, {});
      const padding = num(ev(layout('text-padding'), z, {}), 2);
      const boxOf = (pts, grow) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; } return x0 < x1 ? [x0 - grow, y0 - grow, x1 + grow, y1 + grow] : null; };
      const numberLayer = /street-numbers|number-rows/.test(L.id);
      const streetLayer = /street-names|highway-name/.test(L.id);
      const inkBox = (font, ch) => {
        // the glyph's ink box in text space, em units (fontkit through pdf-lib)
        try {
          const fk = font.embedder && font.embedder.font;
          const gl = fk && fk.glyphForCodePoint(ch.codePointAt(0));
          const bb = gl && gl.bbox;
          if (!bb || !Number.isFinite(bb.minX) || bb.maxX < bb.minX) return null;
          return { cx: (bb.minX + bb.maxX) / 2 / fk.unitsPerEm, cy: (bb.minY + bb.maxY) / 2 / fk.unitsPerEm };
        } catch (e) { return null; }
      };
      const sameColor = (a, b) => a === b || (a && b && Math.abs(a.r - b.r) < 0.004 && Math.abs(a.g - b.g) < 0.004 && Math.abs(a.b - b.b) < 0.004);
      for (const it of items) {
        if (!it) continue;
        const p = it.p;
        const [ax, ay] = it.anchor;
        if (!inRect(ax, ay)) continue;
        cur = { ops: [], box: null, allow: allowOverlap, ignore: ignorePlacement, tile: st.tileK || 0 };
        out.push(cur);
        // the text as MapLibre's `format` sections: runs with their own colour
        const sections = it.text ? sectionsOf(layout('text-field'), z, p) : [];
        const tt = ev(layout('text-transform'), z, p);
        const size0 = it.size != null ? it.size : num(ev(layout('text-size'), z, p), 12);
        const size = size0 * S * (numberLayer ? NUMBER_BOOST : 1) * (streetLayer ? STREET_NAME_SCALE : 1);
        const fonts = ev(layout('text-font'), z, p);
        const bold = Array.isArray(fonts) ? /bold/i.test(fonts[0] || '') : /bold/i.test(String(fonts || ''));
        const font = bold ? fBold : fReg, fkey = bold ? 'F2' : 'F1';
        const tc0 = col(ev(paint('text-color'), z, p), num(ev(paint('text-opacity'), z, p), 1)) || { r: 0, g: 0, b: 0, a: 1 };
        const tc = streetLayer ? { ...STREET_NAME_INK, a: tc0.a } : tc0;
        const hw = num(ev(paint('text-halo-width'), z, p), 0);
        const hc = hw > 0 ? col(ev(paint('text-halo-color'), z, p), 1) : null;
        const rot = num(ev(layout('text-rotate'), z, p), 0);
        const off = ev(layout('text-offset'), z, p) || [0, 0];
        const radial = num(ev(layout('text-radial-offset'), z, p), 0);
        const lh = num(ev(layout('text-line-height'), z, p), 1.2);
        const vanch = ev(layout('text-variable-anchor'), z, p);
        const anchor = it.anchorName || (Array.isArray(vanch) && vanch.length ? vanch[0] : (ev(layout('text-anchor'), z, p) || 'center'));
        const icon = it.icon ? ev(layout('icon-image'), z, p) : null;
        const iconSize = num(ev(layout('icon-size'), z, p), 1);
        const iconRot = num(ev(layout('icon-rotate'), z, p), 0);
        const maxWidthEm = num(ev(layout('text-max-width'), z, p), 10);
        // the characters with their colours, in the fonts the sheet carries
        const chars = [];
        for (const sec of sections) {
          const c = sec.color ? (col(sec.color, tc.a) || tc) : tc;
          let txt = sec.text;
          if (tt === 'uppercase') txt = txt.toUpperCase(); else if (tt === 'lowercase') txt = txt.toLowerCase();
          for (const ch of clean(txt, bold)) chars.push({ ch, c });
        }
        while (chars.length && /\s/.test(chars[chars.length - 1].ch) && chars[chars.length - 1].ch !== '\n') chars.pop();
        const t = chars.map((q) => q.ch).join('');
        // one drawing per symbol: the same symbol comes back from every viewport tile it touches
        const key = L.id + '|' + t + '|' + Math.round(ax / 2) + ',' + Math.round(ay / 2) + '|' + (icon || '');
        if (seen.has(key)) continue;
        seen.add(key);
        const adv = chars.map((q) => (q.ch === '\n' ? 0 : font.widthOfTextAtSize(q.ch, size)));
        const rows = t ? breakLines(chars, adv, maxWidthEm * size) : [];
        const rowW = rows.map((r) => r.reduce((a, i) => a + adv[i], 0));
        const tw = Math.max(0, ...rowW);
        const th = rows.length * lh * size;
        if (typeof icon === 'string' && icon) {
          const rim = col((icon.match(/#[0-9a-f]{6}/i) || [null])[0], 1);
          if (/^badge-/.test(icon)) {
            const boxW = tw + 7 * S, boxH = th + 3 * S, dx = off[0] * size, dy = -off[1] * size;
            const rc = rim || { r: 0.2, g: 0.2, b: 0.2 };
            alpha(0.92, () => push('1 1 1 rg ' + rgbS(rc) + ' RG ' + f2(1.1 * S) + ' w 0 J 1 j [] 0 d ' + rrect(ax + dx - boxW / 2, ay + dy - boxH / 2, boxW, boxH, Math.min(2.5 * S, boxH / 3)) + ' B'));
            counts.icons++;
          } else if (/^(stop|dot)-/.test(icon)) {
            // The stop markers, larger than on screen (user rule: they must
            // be visible on the poster): a white half disc rimmed in the
            // line colour with the bulge on the pole's side, the terminus
            // (-t) filled with a darker rim, metro stations a full disc.
            const c = rim || { r: 0, g: 0.35, b: 0.66 };
            const term = /-t$/.test(icon);
            const fill = term ? c : { r: 1, g: 1, b: 1 };
            const edge = term ? { r: c.r * 0.65, g: c.g * 0.65, b: c.b * 0.65 } : c;
            const r = (/^dot-/.test(icon) ? DOT_R : STOP_R) * iconSize * S, lw = STOP_RIM * iconSize * S;
            const pre = rgbS(fill) + ' rg ' + rgbS(edge) + ' RG ' + f2(lw) + ' w 1 J 1 j [] 0 d ';
            if (/^dot-/.test(icon)) {
              push(pre + circle(ax, ay, r) + ' B');
            } else {
              const th0 = (-iconRot) * Math.PI / 180; let d = '';
              for (let k = 0; k <= 16; k++) { const a0 = th0 + Math.PI * k / 16; d += f2(ax + r * Math.cos(a0)) + ' ' + f2(ay + r * Math.sin(a0)) + (k ? ' l ' : ' m '); }
              push(pre + d + 'h B');
            }
            counts.icons++;
          }
        }
        if (!t) continue;

        // ---- the glyphs on MapLibre's quads ----
        // MapLibre keeps a quad per character except the line breaks (a
        // space's quad is empty); the counts must agree for the mapping
        // (a space at a wrap point is trimmed with the row, so it has none
        // either: the quads are matched to the characters row by row)
        let inked = null;
        if (it.glyphs) {
          // a space's quad is the glyph's empty rect plus its 4-unit border: a
          // square of a third of an em, where every inked glyph is wider
          const gq = it.glyphs; const sq = 0.36 * size0 * S;
          const isSpaceQuad = (q) => Math.hypot(q.c[1][0] - q.c[0][0], q.c[1][1] - q.c[0][1]) < sq && Math.hypot(q.c[2][0] - q.c[0][0], q.c[2][1] - q.c[0][1]) < sq;
          inked = []; let qi = 0; let ok = true;
          for (const c of chars) {
            if (c.ch === '\n') continue;
            const ws = /\s/.test(c.ch);
            if (qi >= gq.length) { if (ws) continue; ok = false; break; }
            const spq = isSpaceQuad(gq[qi]);
            if (ws && !spq) continue; // the space was trimmed at a wrap: no quad
            if (!ws && spq) { ok = false; break; }
            inked.push(c); qi++;
          }
          if (!ok || qi !== gq.length) inked = null;
        }
        if (window.__pdfDebug) (window.__pdfDebug.labels = window.__pdfDebug.labels || []).push(L.id + '|' + t.replace(/\n/g, '/') + '|' + (it.glyphs ? it.glyphs.length : 'none') + '/' + (inked ? inked.length : 'x'));
        if (inked) {
          // each glyph: its origin (page pts), its direction, its colour
          const gs = [];
          for (let i = 0; i < inked.length; i++) {
            if (/\s/.test(inked[i].ch)) continue;
            const q = it.glyphs[i];
            const cx = (q.c[0][0] + q.c[1][0] + q.c[2][0] + q.c[3][0]) / 4, cy = (q.c[0][1] + q.c[1][1] + q.c[2][1] + q.c[3][1]) / 4;
            let dx = q.c[1][0] - q.c[0][0], dy = q.c[1][1] - q.c[0][1];
            const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
            const ib = inkBox(font, inked[i].ch) || { cx: 0.25, cy: 0.3 };
            const ox = ib.cx * size, oy = ib.cy * size;
            let c = q.color || inked[i].c;
            if (streetLayer) c = { ...STREET_NAME_INK, a: c.a };
            const op = q.op != null ? q.op : tc.a;
            gs.push({ ch: inked[i].ch, x: cx - dx * ox + dy * oy, y: cy - dy * ox - dx * oy, dx, dy, c: { r: c.r, g: c.g, b: c.b, a: op }, hw: q.hw != null ? q.hw : hw, hc: q.halo || hc });
          }
          if (!gs.length) continue;
          cur.box = boxOf(it.glyphs.flatMap((q) => q.c), (gs[0].hw + padding) * S);
          if (streetLayer && STREET_NAME_SCALE !== 1 && gs.length > 1) {
            // the smaller street name keeps its letter spacing: the whole
            // label shrinks about its centre, not each glyph about its own
            let mx = 0, my = 0; for (const g of gs) { mx += g.x; my += g.y; } mx /= gs.length; my /= gs.length;
            for (const g of gs) { g.x = mx + (g.x - mx) * STREET_NAME_SCALE; g.y = my + (g.y - my) * STREET_NAME_SCALE; }
          }
          // straight rows: consecutive glyphs on one baseline and direction
          const rowsG = [];
          for (const g of gs) {
            const r = rowsG[rowsG.length - 1];
            if (r) {
              const f = r.g[0];
              const cross = Math.abs(f.dx * g.dy - f.dy * g.dx);
              const v = (g.x - f.x) * -f.dy + (g.y - f.y) * f.dx;
              if (cross < 0.006 && Math.abs(v) < 0.08 * size) { r.g.push(g); continue; }
            }
            rowsG.push({ g: [g] });
          }
          // one text object per row: Tm at the first glyph, TJ with the
          // adjustment (thousandths of em, positive = back) that puts each
          // next glyph where its quad is
          const rowOps = (r, halo) => {
            const f = r.g[0];
            const th1 = Math.atan2(f.dy, f.dx), a = Math.cos(th1), b = Math.sin(th1);
            let s = 'BT /' + fkey + ' ' + f2(size) + ' Tf ' + f2(a) + ' ' + f2(b) + ' ' + f2(-b) + ' ' + f2(a) + ' ' + f2(f.x) + ' ' + f2(f.y) + ' Tm ';
            let pen = 0; let cur = null; let arr = null;
            for (const g of r.g) {
              const u = (g.x - f.x) * f.dx + (g.y - f.y) * f.dy;
              const adj = Math.round((pen - u) / size * 1000);
              if (!halo && !sameColor(cur, g.c)) {
                if (arr !== null) s += arr + '] TJ ';
                s += rgbS(g.c) + ' rg '; cur = g.c; arr = '[';
              } else if (arr === null) arr = '[';
              if (adj) arr += (adj > 0 ? ' ' : ' ') + adj + ' ';
              arr += font.encodeText(g.ch).toString();
              pen = u + font.widthOfTextAtSize(g.ch, size);
            }
            if (arr !== null) s += arr + '] TJ';
            return s + ' ET';
          };
          const rhw = gs[0].hw, rhc = gs[0].hc;
          if (rhc && rhw > 0) {
            push('q 1 Tr ' + f2(rhw * 2 * S) + ' w 1 j ' + rgbS(rhc) + ' RG');
            for (const r of rowsG) push(rowOps(r, true));
            push('Q');
          }
          alpha(gs[0].c.a, () => { for (const r of rowsG) { push(rowOps(r, false)); counts.texts++; } });
          continue;
        }

        // ---- the fallback layout ----
        // glyph runs: {s, x, y, ang, c} — a run of same-coloured characters
        const haloOps = (runs) => {
          if (!hc) return;
          push('q 1 Tr ' + f2(hw * 2 * S) + ' w 1 j ' + rgbS(hc) + ' RG');
          for (const r of runs) push(textOp(font, fkey, r.s, size, r.x, r.y, r.ang, ''));
          push('Q');
        };
        const fillOps = (runs) => alpha(tc.a, () => { for (const r of runs) { push(textOp(font, fkey, r.s, size, r.x, r.y, r.ang, rgbS(r.c) + ' rg ')); counts.texts++; } });
        const boxOfRuns = (runs) => { const pts = []; for (const r of runs) { const w = font.widthOfTextAtSize(r.s, size); const th2 = (-r.ang) * Math.PI / 180, cx = Math.cos(th2), sx = Math.sin(th2); pts.push([r.x, r.y], [r.x + cx * w, r.y + sx * w], [r.x - sx * size, r.y + cx * size], [r.x + cx * w - sx * size, r.y + sx * w + cx * size]); } return boxOf(pts, (hw + padding) * S); };

        if (it.line && it.line.length > 1) {
          // ---- along the line, glyph by glyph ----
          const pts = it.line;
          const acc = [0];
          for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
          const total = acc[acc.length - 1];
          if (total <= 0) continue;
          const sg = Math.min(Math.max(0, it.segment), pts.length - 2);
          const s0 = acc[sg] + Math.hypot(ax - pts[sg][0], ay - pts[sg][1]); // the anchor's own arc position
          const at = (d) => {
            d = Math.max(0, Math.min(total, d));
            let i = 1; while (i < acc.length - 1 && acc[i] < d) i++;
            const seg = Math.max(1e-6, acc[i] - acc[i - 1]);
            const tt2 = (d - acc[i - 1]) / seg;
            const dx = (pts[i][0] - pts[i - 1][0]) / seg, dy = (pts[i][1] - pts[i - 1][1]) / seg;
            return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * tt2, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * tt2, dx, dy];
          };
          const w = adv.reduce((a, b) => a + b, 0);
          // read left to right: walk the line the way that keeps the text upright
          const e0 = at(s0 - w / 2), e1 = at(s0 + w / 2);
          const flip = e1[0] < e0[0];
          const runs = [];
          let run = -w / 2;
          for (let i = 0; i < chars.length; i++) {
            const centre = run + adv[i] / 2; run += adv[i];
            if (/\s/.test(chars[i].ch)) continue;
            const q = at(s0 + (flip ? -centre : centre));
            const dx = flip ? -q[2] : q[2], dy = flip ? -q[3] : q[3];
            const ang = -Math.atan2(dy, dx) * 180 / Math.PI; // textOp takes MapLibre's clockwise degrees
            // glyph centred on the line: back by half its advance along the
            // text, down by a third of the size to the baseline
            runs.push({ s: chars[i].ch, x: q[0] - dx * adv[i] / 2 + dy * 0.33 * size, y: q[1] - dy * adv[i] / 2 - dx * 0.33 * size, ang, c: chars[i].c });
          }
          haloOps(runs); fillOps(runs); cur.box = boxOfRuns(runs);
        } else {
          // ---- at the point: the block placed by anchor, offset in the
          // label's own (rotated) frame, rows justified by the anchor ----
          const th1 = (-rot) * Math.PI / 180;
          const dir = [Math.cos(th1), Math.sin(th1)], perp = [-Math.sin(th1), Math.cos(th1)];
          const R = radial * size;
          const map8 = { left: [R, 0], right: [-R, 0], top: [0, -R], bottom: [0, R], 'top-left': [R * 0.7, -R * 0.7], 'top-right': [-R * 0.7, -R * 0.7], 'bottom-left': [R * 0.7, R * 0.7], 'bottom-right': [-R * 0.7, R * 0.7], center: [0, 0] };
          let hx = 0.5, hy = 0.5;
          if (/left/.test(anchor)) hx = 0; if (/right/.test(anchor)) hx = 1;
          if (/top/.test(anchor)) hy = 1; if (/bottom/.test(anchor)) hy = 0;
          let ox = off[0] * size, oy = -off[1] * size;
          if (radial) { const v = map8[anchor] || [0, 0]; ox += v[0]; oy += v[1]; }
          const cx = ax + dir[0] * ox + perp[0] * oy, cy = ay + dir[1] * ox + perp[1] * oy;
          const top = th * (1 - hy); // the block's top edge, up from the anchor point
          const runs = [];
          rows.forEach((row, i) => {
            const rowY = top - i * lh * size - lh * size / 2 - 0.32 * size;
            let x = hx === 0 ? 0 : hx === 1 ? -rowW[i] : -rowW[i] / 2;
            let j = 0;
            while (j < row.length) {
              let k = j; let s = ''; let wdt = 0;
              while (k < row.length && chars[row[k]].c === chars[row[j]].c) { s += chars[row[k]].ch; wdt += adv[row[k]]; k++; }
              runs.push({ s, x: cx + dir[0] * x + perp[0] * rowY, y: cy + dir[1] * x + perp[1] * rowY, ang: rot, c: chars[row[j]].c });
              x += wdt; j = k;
            }
          });
          haloOps(runs); fillOps(runs); cur.box = boxOfRuns(runs);
        }
      }
    }
  }
})();
