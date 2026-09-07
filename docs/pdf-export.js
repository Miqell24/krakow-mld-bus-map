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
  const S = 0.75;            // PDF points per CSS pixel
  const PAD = 200;           // CSS px of tile overlap for label context
  const TILE = 1024;         // CSS px of the inner tile
  const MAX_PX = 12000;      // long edge of a tiled sheet, CSS px (9000 pt)
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
      const city = (document.title.split(/\s+[—–|-]\s+/)[0] || 'map').replace(/[^\w]+/g, '-').toLowerCase();
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
  const OPS = new Set(['literal', 'zoom', 'get', 'has', 'geometry-type', 'coalesce', 'case', 'match', 'interpolate', 'step', 'all', 'any', '!', '==', '!=', '<', '<=', '>', '>=', 'in', 'length', '*', '+', '-', '/', 'concat', 'to-string', 'to-number', 'upcase', 'downcase', 'string', 'number', 'boolean', 'format', 'let', 'var']);
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
      case 'let': return ev(x[x.length - 1], z, p);
      case 'var': return undefined;
      default: return undefined;
    }
  }
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const mxOf = (lng) => (lng + 180) / 360;
  const myOf = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

  // ---------- the export ----------
  async function exportPdf(m0, bbox, setLbl) {
    const { PDFDocument, rgb, degrees, PDFName, PDFString, PDFOperator, PDFNumber, LineCapStyle } = PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const [fReg, fBold] = await Promise.all(['vendor/RobotoCondensed-Regular.ttf', 'vendor/RobotoCondensed-Bold.ttf']
      .map(async (u) => doc.embedFont(await (await fetch(u)).arrayBuffer(), { subset: true }))); // eslint-disable-line no-undef
    const charset = { reg: new Set(fReg.getCharacterSet()), bold: new Set(fBold.getCharacterSet()) };
    doc.setTitle(document.title);
    doc.setProducer('transit-maps pdf-export');
    doc.setCreator('miqell24.github.io/transit-maps');

    // sheet geometry: the viewport, or the bbox at a poster zoom
    let W, H, Z, tlx, tly, world, tiles = null;
    if (!bbox) {
      const cont = m0.getContainer();
      W = cont.clientWidth; H = cont.clientHeight; Z = m0.getZoom();
    } else {
      const fx = mxOf(bbox[2]) - mxOf(bbox[0]), fy = myOf(bbox[1]) - myOf(bbox[3]);
      const zFit = Math.log2(MAX_PX / (512 * Math.max(fx, fy)));
      Z = Math.min(zFit, Math.max(15.3, Math.min(m0.getZoom(), 17.3)));
      world = 512 * 2 ** Z;
      W = Math.round(fx * world); H = Math.round(fy * world);
      tlx = mxOf(bbox[0]) * world; tly = myOf(bbox[3]) * world;
      const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
      tiles = { cols, rows };
    }
    const page = doc.addPage([W * S, H * S]);
    const ctx = doc.context;

    // PDF layers: one optional content group per family of style layers
    const ocgs = new Map(); const ocgRefs = []; const props = ctx.obj({});
    const groupOf = (id, type, source) => {
      if (source === 'openmaptiles' || source === 'ne2_shaded' || id === 'background') return type === 'symbol' ? 'Base map · names' : 'Base map';
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
      if (openGroup) page.pushOperators(PDFOperator.of('EMC'));
      page.pushOperators(PDFOperator.of('BDC', [PDFName.of('OC'), PDFName.of(ocgFor(name))]));
      openGroup = name;
    };
    const leave = () => { if (openGroup) { page.pushOperators(PDFOperator.of('EMC')); openGroup = null; } };
    const clipTo = (x0, y0, x1, y1) => page.pushOperators(PDFOperator.of('re', [PDFNumber.of(x0), PDFNumber.of(y0), PDFNumber.of(x1 - x0), PDFNumber.of(y1 - y0)]), PDFOperator.of('W'), PDFOperator.of('n'));
    const gsave = () => page.pushOperators(PDFOperator.of('q'));
    const grestore = () => page.pushOperators(PDFOperator.of('Q'));

    // placed label boxes in a 48-pt grid: the anchor replay asks "is this box
    // free" for every stop name, and a whole-map sheet has tens of thousands
    const G = 48; const cells = new Map();
    const placed = {
      hit(b) { for (let i = Math.floor(b[0] / G); i <= Math.floor(b[2] / G); i++) for (let j = Math.floor(b[1] / G); j <= Math.floor(b[3] / G); j++) { const c = cells.get(i + ',' + j); if (c && c.some((q) => q[0] < b[2] && q[2] > b[0] && q[1] < b[3] && q[3] > b[1])) return true; } return false; },
      add(b) { for (let i = Math.floor(b[0] / G); i <= Math.floor(b[2] / G); i++) for (let j = Math.floor(b[1] / G); j <= Math.floor(b[3] / G); j++) { const k = i + ',' + j; let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(b); } },
    };
    // pdf-lib registers a NEW ExtGState (and a new font resource key) on
    // every draw call that carries opacity or a font, and looks each key up
    // linearly — quadratic on a sheet with 200 000 paths. One shared state
    // per opacity value instead, and the font switched only when it changes.
    const gsKeys = new Map();
    const alpha = (a) => {
      const k = Math.round(Math.max(0, Math.min(1, a)) * 100);
      if (k >= 100) return null;
      if (!gsKeys.has(k)) gsKeys.set(k, page.node.newExtGState('GSa', ctx.obj({ Type: 'ExtGState', ca: k / 100, CA: k / 100 })));
      return gsKeys.get(k);
    };
    const withAlpha = (a, fn) => { const key = alpha(a); if (!key) return fn(); page.pushOperators(PDFOperator.of('q'), PDFOperator.of('gs', [key])); fn(); page.pushOperators(PDFOperator.of('Q')); };
    let curFont = null;
    const useFont = (f) => { if (f !== curFont) { page.setFont(f); curFont = f; } };
    const halo = (c, lw, fn) => {
      page.pushOperators(PDFOperator.of('q'), PDFOperator.of('RG', [PDFNumber.of(c.color.red), PDFNumber.of(c.color.green), PDFNumber.of(c.color.blue)]), PDFOperator.of('w', [PDFNumber.of(lw)]), PDFOperator.of('j', [PDFNumber.of(1)]), PDFOperator.of('Tr', [PDFNumber.of(1)]));
      fn();
      page.pushOperators(PDFOperator.of('Q'));
    };
    const state = { withAlpha, useFont, halo, placed, seen: new Set(), counts: { layers: 0, fills: 0, lines: 0, texts: 0, icons: 0 }, clean: (t, bold) => [...String(t)].filter((ch) => (bold ? charset.bold : charset.reg).has(ch.codePointAt(0)) || ch === ' ').join(''), fReg, fBold, rgb, degrees, LineCapStyle, page, W, H, Z, enter, leave, groupOf, gsave, grestore, clipTo };

    if (!bbox) {
      const px = (lng, lat) => { const q = m0.project([lng, lat]); return [q.x * S, (H - q.y) * S]; };
      gsave(); clipTo(0, 0, W * S, H * S);
      drawScene(m0, px, null, state);
      leave(); grestore();
    } else {
      // the offscreen map: the live style, the live images, a tile-sized viewport
      const contCSS = TILE + 2 * PAD;
      const div = document.createElement('div');
      div.style.cssText = `position:fixed;left:-100000px;top:0;width:${contCSS}px;height:${contCSS}px;`;
      document.body.appendChild(div);
      const px2ll = (x, y) => { const n = Math.PI - (2 * Math.PI * y) / world; return [(x / world) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))]; };
      let m2 = null;
      try {
        m2 = new maplibregl.Map({ container: div, style: m0.getStyle(), center: px2ll(tlx + W / 2, tly + H / 2), zoom: Z, attributionControl: false, interactive: false, fadeDuration: 0 });
        const idle = () => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('tile render timeout')), 60000); m2.once('idle', () => { clearTimeout(t); res(); }); });
        await idle();
        // the canvas-drawn icons (stop discs, badge boxes) live only in the live map
        try { for (const id of m0.listImages()) { const im = m0.getImage(id); if (im && !m2.hasImage(id)) m2.addImage(id, im.data, { pixelRatio: im.pixelRatio, sdf: im.sdf }); } } catch (e) { console.warn('icons not copied', e); }
        m2.triggerRepaint(); await idle();
        // the base colour once, under everything
        const px = (lng, lat) => [(mxOf(lng) * world - tlx) * S, (H - (myOf(lat) * world - tly)) * S];
        let k = 0; const T = { idle: 0, draw: 0, query: 0 }; state.T = T;
        for (let j = 0; j < tiles.rows; j++) {
          for (let i = 0; i < tiles.cols; i++) {
            setLbl(`Drawing ${++k}/${tiles.rows * tiles.cols}…`);
            const x0 = i * TILE, y0 = j * TILE;
            const w = Math.min(TILE, W - x0), h = Math.min(TILE, H - y0);
            m2.jumpTo({ center: px2ll(tlx + x0 + w / 2, tly + y0 + h / 2), zoom: Z });
            m2.triggerRepaint();
            const t0 = performance.now();
            await idle();
            T.idle += performance.now() - t0;
            // page rect of this tile (PDF y up)
            const rect = [x0 * S, (H - y0 - h) * S, (x0 + w) * S, (H - y0) * S];
            gsave(); clipTo(rect[0], rect[1], rect[2], rect[3]);
            const t1 = performance.now();
            drawScene(m2, px, rect, state);
            T.draw += performance.now() - t1;
            leave(); grestore();
          }
        }
      } finally {
        if (m2) try { m2.remove(); } catch (e) { /* gone */ }
        div.remove();
      }
    }
    // attribution, bottom right, as text
    const attr = (document.querySelector('.maplibregl-ctrl-attrib-inner') || {}).textContent || '© OpenStreetMap contributors · OpenFreeMap';
    enter('Attribution');
    const at = state.clean(attr.replace(/\s+/g, ' ').trim(), false);
    const asz = Math.max(6, Math.min(9, W * S / 120));
    const aw = fReg.widthOfTextAtSize(at, asz);
    withAlpha(0.82, () => page.drawRectangle({ x: W * S - aw - asz, y: 0, width: aw + asz, height: asz * 1.8, color: rgb(1, 1, 1) }));
    useFont(fReg);
    page.drawText(at, { x: W * S - aw - asz / 2, y: asz * 0.5, size: asz, color: rgb(0.2, 0.2, 0.2) });
    leave();
    if (ocgRefs.length) {
      page.node.set(PDFName.of('Resources'), page.node.Resources() || ctx.obj({}));
      page.node.Resources().set(PDFName.of('Properties'), props);
      doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: ocgRefs, D: ctx.obj({ Order: ocgRefs, ON: ocgRefs, BaseState: 'ON' }) }));
    }
    console.log('pdf-export', { W, H, Z: Math.round(Z * 100) / 100, tiles, ...state.counts, ...(state.T ? { ms: Object.fromEntries(Object.entries(state.T).map(([k, v]) => [k, Math.round(v)])) } : {}) });
    setLbl('Saving…');
    return doc.save();
  }

  // Draws everything the map m has on screen into the page, through px()
  // (lon/lat → page points). rect (page space) is the tile's own area: fills
  // and lines are clipped to it by the caller, symbols are taken only when
  // their anchor is inside it, so the overlap between tiles is context, not
  // duplication.
  function drawScene(m, px, rect, st) {
    const { page, W, H, Z: z0, rgb, degrees, LineCapStyle, fReg, fBold, clean, placed, seen, counts, enter, leave, groupOf, gsave, grestore, clipTo, withAlpha, useFont, halo } = st;
    const z = m.getZoom();
    const col = (c, alphaMul) => { const k = parseColor(c); return k ? { color: rgb(Math.max(0, Math.min(1, k.r)), Math.max(0, Math.min(1, k.g)), Math.max(0, Math.min(1, k.b))), opacity: Math.max(0, Math.min(1, k.a * (alphaMul ?? 1))) } : null; };
    const asRings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
    const asLines = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : []);
    const asPoints = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : []);
    const PH = H * S;
    const pathOf = (coords, close) => {
      let d = '';
      coords.forEach((c, i) => { const [x, y] = px(c[0], c[1]); d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + (PH - y).toFixed(2); });
      return d + (close ? 'Z' : '');
    };
    const svgOpts = (o) => ({ x: 0, y: PH, ...o });
    const inRect = (x, y) => !rect || (x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]);
    const cw = m.getContainer().clientWidth, ch = m.getContainer().clientHeight;
    const rectOnScreen = rect ? [PAD, PAD, cw - PAD, ch - PAD] : null;
    const wrap = (t, font, size, maxW) => {
      if (!t.includes(' ') || font.widthOfTextAtSize(t, size) <= maxW) return t.split('\n');
      const out = []; let cur = '';
      for (const w of t.split(/\s+/)) { const cand = cur ? cur + ' ' + w : w; if (font.widthOfTextAtSize(cand, size) > maxW && cur) { out.push(cur); cur = w; } else cur = cand; }
      if (cur) out.push(cur);
      return out;
    };

    // one query for the whole scene (400 layers × 120 tiles was the slow
    // part), bucketed by layer id; the style order still drives the drawing
    const byLayer = new Map();
    const tq = performance.now();
    try {
      const all = rectOnScreen ? m.queryRenderedFeatures([[rectOnScreen[0] - 40, rectOnScreen[1] - 40], [rectOnScreen[2] + 40, rectOnScreen[3] + 40]]) : m.queryRenderedFeatures();
      for (const f of all) { const id = f.layer && f.layer.id; if (!id) continue; let a = byLayer.get(id); if (!a) byLayer.set(id, a = []); a.push(f); }
    } catch (e) { console.warn('pdf-export query', e); }
    if (st.T) st.T.query += performance.now() - tq;
    for (const L of m.getStyle().layers) {
      if (L.layout && L.layout.visibility === 'none') continue;
      if (L.minzoom !== undefined && z < L.minzoom) continue;
      if (L.maxzoom !== undefined && z >= L.maxzoom) continue;
      const group = groupOf(L.id, L.type, L.source);
      if (L.type === 'background') {
        enter(group);
        const c = col(ev(m.getPaintProperty(L.id, 'background-color'), z, {}), num(ev(m.getPaintProperty(L.id, 'background-opacity'), z, {}), 1));
        if (c) withAlpha(c.opacity, () => page.drawRectangle({ x: rect ? rect[0] : 0, y: rect ? rect[1] : 0, width: rect ? rect[2] - rect[0] : W * S, height: rect ? rect[3] - rect[1] : PH, color: c.color }));
        continue;
      }
      if (!['fill', 'line', 'symbol', 'circle'].includes(L.type)) continue;
      const feats = byLayer.get(L.id);
      if (!feats || !feats.length) continue;
      feats.reverse(); // the query lists the top-most feature first
      counts.layers++;
      // a label whose anchor sits inside the tile reaches past its edge:
      // symbols are drawn outside the tile clip (their anchor test keeps
      // the overlap from duplicating them)
      const unclipped = rect && L.type === 'symbol';
      if (unclipped) { leave(); grestore(); }
      enter(group);
      const paint = (k) => m.getPaintProperty(L.id, k);
      const layout = (k) => m.getLayoutProperty(L.id, k);
      for (const f of feats) {
        const p = { ...f.properties, __geom: f.geometry.type };
        for (const k in p) { const v = p[k]; if (typeof v === 'string' && (v[0] === '[' || v[0] === '{')) { try { p[k] = JSON.parse(v); } catch (e) { /* a real string */ } } } // queryRenderedFeatures stringifies nested values
        const g = f.geometry;
        if (L.type === 'fill') {
          const c = col(ev(paint('fill-color'), z, p), num(ev(paint('fill-opacity'), z, p), 1));
          if (!c) continue;
          withAlpha(c.opacity, () => { for (const rings of asRings(g)) { page.drawSvgPath(rings.map((r) => pathOf(r, true)).join(' '), svgOpts({ color: c.color, borderWidth: 0 })); counts.fills++; } });
          const oc = col(ev(paint('fill-outline-color'), z, p), 1);
          if (oc) withAlpha(oc.opacity, () => { for (const rings of asRings(g)) page.drawSvgPath(rings.map((r) => pathOf(r, true)).join(' '), svgOpts({ borderColor: oc.color, borderWidth: 0.4 * S })); });
        } else if (L.type === 'line') {
          const c = col(ev(paint('line-color'), z, p), num(ev(paint('line-opacity'), z, p), 1));
          const w = num(ev(paint('line-width'), z, p), 1) * S;
          if (!c || w <= 0) continue;
          const dash = ev(paint('line-dasharray'), z, p);
          const cap = ev(layout('line-cap'), z, p);
          withAlpha(c.opacity, () => {
            for (const line of asLines(g)) {
              if (line.length < 2) continue;
              page.drawSvgPath(pathOf(line, false), svgOpts({ borderColor: c.color, borderWidth: w, borderLineCap: cap === 'round' ? LineCapStyle.Round : cap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Butt, borderDashArray: Array.isArray(dash) ? dash.map((d) => Math.max(0.01, d * w)) : undefined }));
              counts.lines++;
            }
          });
        } else if (L.type === 'circle') {
          const c = col(ev(paint('circle-color'), z, p), num(ev(paint('circle-opacity'), z, p), 1));
          const r = num(ev(paint('circle-radius'), z, p), 3) * S;
          for (const pt of asPoints(g)) { const [x, y] = px(pt[0], pt[1]); if (!inRect(x, y)) continue; if (c) withAlpha(c.opacity, () => page.drawCircle({ x, y, size: r, color: c.color })); counts.icons++; }
        } else if (L.type === 'symbol') try {
          const textRaw = ev(layout('text-field'), z, p);
          const text = textRaw === undefined || textRaw === null ? '' : String(textRaw);
          const size = num(ev(layout('text-size'), z, p), 12) * S;
          const fonts = ev(layout('text-font'), z, p);
          const bold = Array.isArray(fonts) ? /bold/i.test(fonts[0] || '') : /bold/i.test(String(fonts || ''));
          const font = bold ? fBold : fReg;
          const tc = col(ev(paint('text-color'), z, p), num(ev(paint('text-opacity'), z, p), 1)) || { color: rgb(0, 0, 0), opacity: 1 };
          const hw = num(ev(paint('text-halo-width'), z, p), 0);
          const hc = hw > 0 ? col(ev(paint('text-halo-color'), z, p), 1) : null;
          const rot = num(ev(layout('text-rotate'), z, p), 0);
          const off = ev(layout('text-offset'), z, p) || [0, 0];
          const radial = num(ev(layout('text-radial-offset'), z, p), 0);
          let anchor = ev(layout('text-anchor'), z, p) || 'center';
          const vanch = ev(layout('text-variable-anchor'), z, p);
          if (Array.isArray(vanch) && vanch.length) anchor = vanch[0];
          const placement = ev(layout('symbol-placement'), z, p) || 'point';
          const icon = ev(layout('icon-image'), z, p);
          const iconSize = num(ev(layout('icon-size'), z, p), 1);
          const iconRot = num(ev(layout('icon-rotate'), z, p), 0);
          const maxWidthEm = num(ev(layout('text-max-width'), z, p), 10);
          const t = clean(text, bold).replace(/\s+$/, '');
          // where: a point symbol at its anchor, a line symbol at the line's middle
          let anchors = []; let lineAngle = 0;
          if (placement === 'point' || g.type === 'Point' || g.type === 'MultiPoint') {
            anchors = asPoints(g).length ? asPoints(g).map((c) => px(c[0], c[1])) : (asLines(g)[0] ? [px(...asLines(g)[0][Math.floor(asLines(g)[0].length / 2)])] : []);
          } else {
            const line = asLines(g)[0];
            if (!line || line.length < 2) continue;
            const pts = line.map((c) => px(c[0], c[1]));
            let total = 0; const acc = [0];
            for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(total); }
            const half = total / 2; let i = 1; while (i < acc.length && acc[i] < half) i++;
            const tt = (half - acc[i - 1]) / Math.max(1e-6, acc[i] - acc[i - 1]);
            const ax = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * tt, ay = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * tt;
            lineAngle = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI;
            if (lineAngle > 90) lineAngle -= 180; if (lineAngle < -90) lineAngle += 180;
            if (font.widthOfTextAtSize(t, size) > total * 0.95) continue;
            anchors = [[ax, ay, true]];
          }
          for (const a of anchors) {
            const [ax, ay] = a;
            if (!inRect(ax, ay)) continue;
            // one drawing per symbol: the same label comes back from every tile it touches
            const key = L.id + '|' + t + '|' + Math.round(ax / 3) + ',' + Math.round(ay / 3) + '|' + (icon || '');
            if (seen.has(key)) continue;
            seen.add(key);
            const lines = wrap(t, font, size, maxWidthEm * size);
            const tw = Math.max(0, ...lines.map((l) => font.widthOfTextAtSize(l, size)));
            const th = lines.length * size * 1.1;
            if (typeof icon === 'string' && icon) {
              const rim = col((icon.match(/#[0-9a-f]{6}/i) || [null])[0], 1);
              if (/^badge-/.test(icon)) {
                const boxW = tw + 7 * S, boxH = th + 3 * S, dx = off[0] * size, dy = -off[1] * size;
                withAlpha(0.92, () => page.drawRectangle({ x: ax + dx - boxW / 2, y: ay + dy - boxH / 2, width: boxW, height: boxH, color: rgb(1, 1, 1), borderColor: rim ? rim.color : rgb(0.2, 0.2, 0.2), borderWidth: 1.1 * S }));
                counts.icons++;
              } else if (/^stop-/.test(icon)) {
                const r = 4.2 * iconSize * S, th0 = (-iconRot) * Math.PI / 180, pts = [];
                for (let k = 0; k <= 12; k++) { const a0 = th0 + Math.PI * k / 12; pts.push([ax + r * Math.cos(a0), ay + r * Math.sin(a0)]); }
                page.drawSvgPath(pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(2) + ' ' + (PH - q[1]).toFixed(2)).join('') + 'Z', svgOpts({ color: rim ? rim.color : rgb(0, 0.35, 0.66), borderColor: rgb(1, 1, 1), borderWidth: 0.6 * S }));
                counts.icons++;
              } else if (/^dot-/.test(icon)) {
                page.drawCircle({ x: ax, y: ay, size: 4.5 * iconSize * S, color: rim ? rim.color : rgb(0, 0.35, 0.66), borderColor: rgb(1, 1, 1), borderWidth: 0.8 * S });
                counts.icons++;
              }
            }
            if (!t) continue;
            // Placement: MapLibre placed this label collision-free but, for a
            // variable-anchor label (stop names: eight anchors), does not say
            // where — the same rule is replayed against every label drawn so
            // far: the first anchor whose box is free. Fixed labels only
            // register their box.
            const ang = a[2] ? lineAngle : rot;
            const th1 = (-ang) * Math.PI / 180;
            const dir = [Math.cos(th1), Math.sin(th1)], perp = [-Math.sin(th1), Math.cos(th1)];
            const R = radial * size;
            const map8 = { left: [R, 0], right: [-R, 0], top: [0, -R], bottom: [0, R], 'top-left': [R * 0.7, -R * 0.7], 'top-right': [-R * 0.7, -R * 0.7], 'bottom-left': [R * 0.7, R * 0.7], 'bottom-right': [-R * 0.7, R * 0.7], center: [0, 0] };
            const candidates = Array.isArray(vanch) && vanch.length && !a[2] ? vanch : [anchor];
            let chosen = null;
            for (const an of candidates) {
              let hx = 0.5, hy = 0.5;
              if (/left/.test(an)) hx = 0; if (/right/.test(an)) hx = 1;
              if (/top/.test(an)) hy = 1; if (/bottom/.test(an)) hy = 0;
              let ox = off[0] * size, oy = -off[1] * size;
              if (radial && !a[2]) { const v = map8[an] || [0, 0]; ox += v[0]; oy += v[1]; }
              const cx = ax + ox, cy = ay + oy;
              const bx = cx + dir[0] * (tw / 2 - tw * hx) + perp[0] * (th / 2 - th * hy);
              const by = cy + dir[1] * (tw / 2 - tw * hx) + perp[1] * (th / 2 - th * hy);
              const ex = Math.abs(dir[0]) * tw / 2 + Math.abs(perp[0]) * th / 2, ey = Math.abs(dir[1]) * tw / 2 + Math.abs(perp[1]) * th / 2;
              const box = [bx - ex, by - ey, bx + ex, by + ey];
              const free = candidates.length === 1 || !placed.hit(box);
              if (free) { chosen = { hx, hy, cx, cy, box }; break; }
            }
            if (!chosen) continue;
            placed.add(chosen.box);
            useFont(font);
            const rows = lines.map((ln, i) => {
              const lw = font.widthOfTextAtSize(ln, size);
              const rowY = (lines.length - 1 - i) * size * 1.1 - th * chosen.hy + th / 2 - size * 0.32;
              const rowX = chosen.hx === 0 ? 0 : chosen.hx === 1 ? -lw : -lw / 2;
              return { ln, x: chosen.cx + dir[0] * rowX + perp[0] * rowY, y: chosen.cy + dir[1] * rowX + perp[1] * rowY };
            });
            // the halo: the same text once more underneath, stroked (render
            // mode 1) in the halo colour, the stroke twice the halo width
            if (hc) {
              halo(hc, hw * 2 * S, () => rows.forEach((r) => page.drawText(r.ln, { x: r.x, y: r.y, size, rotate: degrees(-ang) })));
            }
            withAlpha(tc.opacity, () => rows.forEach((r) => {
              page.drawText(r.ln, { x: r.x, y: r.y, size, color: tc.color, rotate: degrees(-ang) });
              counts.texts++;
            }));
          }
        } catch (e) { console.warn('pdf-export symbol', L.id, e); }
      }
      if (unclipped) { leave(); gsave(); clipTo(rect[0], rect[1], rect[2], rect[3]); }
    }
  }
})();
