// Vector PDF export of the current view (user request, 7.09.2026): not a
// picture of the map but the map itself — every roadway, water body, park,
// transit stroke, stop disc and label lands in the PDF as a path or a text
// object, grouped into PDF layers (optional content groups) that Illustrator,
// Affinity and Inkscape show as layers. The source is what MapLibre has on
// screen: the style's layers in their draw order, each one's rendered
// features (so the labels are the ones that survived collision placement),
// each paint and layout property evaluated at the current zoom. Text is set
// in the map's own Roboto Condensed, embedded from web/vendor. pdf-lib and
// fontkit load on the first click, not with the page.
(() => {
  const btn = document.getElementById('export-pdf');
  if (!btn) return;
  const S = 0.75; // PDF points per CSS pixel

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('cannot load ' + src));
    document.head.appendChild(s);
  });
  const ensureLibs = async () => {
    if (!window.PDFLib) await loadScript('vendor/pdf-lib.min.js');
    if (!window.fontkit) await loadScript('vendor/fontkit.umd.min.js');
  };

  btn.addEventListener('click', async () => {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Building the PDF…';
    try {
      await ensureLibs();
      const bytes = await exportPdf();
      window.__lastPdf = bytes; // test hook
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (document.title.split(/\s+[—–|-]\s+/)[0] || 'map').replace(/[^\w]+/g, '-').toLowerCase() + '-vector.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      btn.textContent = 'PDF saved ✓';
      setTimeout(() => { btn.textContent = label; }, 3000);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + e.message);
      btn.textContent = label;
    } finally { btn.disabled = false; }
  });

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
  const lerp = (a, b, t) => (typeof a === 'number' && typeof b === 'number' ? a + (b - a) * t : (t < 0.5 ? a : b));
  const OPS = new Set(['literal', 'zoom', 'get', 'has', 'geometry-type', 'coalesce', 'case', 'match', 'interpolate', 'step', 'all', 'any', '!', '==', '!=', '<', '<=', '>', '>=', 'in', 'length', '*', '+', '-', '/', 'concat', 'to-string', 'to-number', 'upcase', 'downcase', 'string', 'number', 'boolean', 'format', 'let', 'var']);
  function ev(x, z, p) {
    if (!Array.isArray(x)) return x;
    const op = x[0];
    // a plain array — ["roboto_condensed_bold"], [0, 0.9], the anchor list — is a value, not an expression
    if (!OPS.has(op)) return x;
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

  // ---------- the export ----------
  async function exportPdf() {
    const { PDFDocument, rgb, degrees, PDFName, PDFString, PDFOperator, LineCapStyle } = PDFLib;
    // not window.map — that is the <div id="map"> by named access; app.js exposes the MapLibre object as __map
    const m = window.__map || (typeof map !== 'undefined' && map && map.getZoom ? map : null);
    if (!m) throw new Error('no map');
    const z = m.getZoom();
    const cont = m.getContainer();
    const W = cont.clientWidth, H = cont.clientHeight;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const [fReg, fBold] = await Promise.all(['vendor/RobotoCondensed-Regular.ttf', 'vendor/RobotoCondensed-Bold.ttf']
      .map(async (u) => doc.embedFont(await (await fetch(u)).arrayBuffer(), { subset: true }))); // eslint-disable-line no-undef
    const charset = { reg: new Set(fReg.getCharacterSet()), bold: new Set(fBold.getCharacterSet()) };
    const clean = (t, bold) => [...String(t)].filter((ch) => (bold ? charset.bold : charset.reg).has(ch.codePointAt(0)) || ch === ' ').join('');
    const page = doc.addPage([W * S, H * S]);
    doc.setTitle(document.title);
    doc.setProducer('transit-maps pdf-export');
    doc.setCreator('miqell24.github.io/transit-maps');
    const px = (lng, lat) => { const q = m.project([lng, lat]); return [q.x * S, (H - q.y) * S]; };
    const col = (c, alphaMul) => { const k = parseColor(c); return k ? { color: rgb(Math.max(0, Math.min(1, k.r)), Math.max(0, Math.min(1, k.g)), Math.max(0, Math.min(1, k.b))), opacity: Math.max(0, Math.min(1, k.a * (alphaMul ?? 1))) } : null; };

    // PDF layers: one optional content group per family of style layers
    const ctx = doc.context;
    const ocgs = new Map();
    const ocgRefs = [];
    const props = ctx.obj({});
    const groupOf = (id, type, source) => {
      if (source === 'openmaptiles' || source === 'ne2_shaded' || id === 'background') return type === 'symbol' ? 'Base map · names' : 'Base map';
      if (/^(route|corridor|strand)-/.test(id)) return 'Transit lines';
      if (/^stops-terminus-badges/.test(id)) return 'Terminus badges';
      if (/^stops-terminus-names|^stops-names/.test(id)) return 'Stop names';
      if (/^stops-/.test(id)) return 'Stops';
      if (/street-numbers|number-rows/.test(id)) return 'Line numbers';
      if (/street-names|highway-name/.test(id)) return 'Street names';
      if (/^journey-/.test(id)) return 'Journey';
      return 'Other';
    };
    const ocgFor = (name) => {
      if (ocgs.has(name)) return ocgs.get(name);
      const dict = ctx.obj({ Type: 'OCG', Name: PDFString.of(name) });
      const ref = ctx.register(dict);
      const key = 'oc' + (ocgs.size + 1);
      props.set(PDFName.of(key), ref);
      ocgRefs.push(ref);
      ocgs.set(name, key);
      return key;
    };
    let openGroup = null;
    const enter = (name) => {
      if (openGroup === name) return;
      if (openGroup) page.pushOperators(PDFOperator.of('EMC'));
      const key = ocgFor(name);
      page.pushOperators(PDFOperator.of('BDC', [PDFName.of('OC'), PDFName.of(key)]));
      openGroup = name;
    };
    const leave = () => { if (openGroup) { page.pushOperators(PDFOperator.of('EMC')); openGroup = null; } };

    // clip everything to the page
    page.pushOperators(
      PDFOperator.of('re', [PDFLib.PDFNumber.of(0), PDFLib.PDFNumber.of(0), PDFLib.PDFNumber.of(W * S), PDFLib.PDFNumber.of(H * S)]),
      PDFOperator.of('W'), PDFOperator.of('n'));

    const style = m.getStyle();
    const inBounds = (f) => true; // rendered features are on screen by definition
    const geomOf = (f) => f.geometry;
    const asRings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
    const asLines = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : []);
    const asPoints = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : []);

    const pathOf = (coords, close) => {
      let d = '';
      coords.forEach((c, i) => { const [x, y] = px(c[0], c[1]); d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + (H * S - y).toFixed(2); });
      return d + (close ? 'Z' : '');
    };
    // drawSvgPath treats y downward from the given origin, hence the flip above and y: H*S below
    const svgOpts = (o) => ({ x: 0, y: H * S, ...o });

    let counts = { layers: 0, fills: 0, lines: 0, texts: 0, icons: 0 };
    const perLayer = {};
    const placed = []; // label boxes drawn so far, page space
    const layers = style.layers;
    for (const L of layers) {
      if (L.layout && L.layout.visibility === 'none') continue;
      if (L.minzoom !== undefined && z < L.minzoom) continue;
      if (L.maxzoom !== undefined && z >= L.maxzoom) continue;
      const group = groupOf(L.id, L.type, L.source);
      if (L.type === 'background') {
        enter(group);
        const c = col(ev(m.getPaintProperty(L.id, 'background-color'), z, {}), num(ev(m.getPaintProperty(L.id, 'background-opacity'), z, {}), 1));
        if (c) page.drawRectangle({ x: 0, y: 0, width: W * S, height: H * S, color: c.color, opacity: c.opacity });
        continue;
      }
      if (!['fill', 'line', 'symbol', 'circle'].includes(L.type)) continue;
      let feats;
      try { feats = m.queryRenderedFeatures({ layers: [L.id] }); } catch (e) { continue; }
      if (!feats.length) continue;
      counts.layers++;
      enter(group);
      const before = { ...counts };
      const paint = (k) => m.getPaintProperty(L.id, k);
      const layout = (k) => m.getLayoutProperty(L.id, k);
      const seen = new Set();
      for (const f of feats) {
        const p = { ...f.properties, __geom: f.geometry.type };
        const g = geomOf(f);
        if (L.type === 'fill') {
          const c = col(ev(paint('fill-color'), z, p), num(ev(paint('fill-opacity'), z, p), 1));
          if (!c) continue;
          for (const rings of asRings(g)) {
            const d = rings.map((r) => pathOf(r, true)).join(' ');
            page.drawSvgPath(d, svgOpts({ color: c.color, opacity: c.opacity, borderWidth: 0 }));
            counts.fills++;
          }
          const oc = col(ev(paint('fill-outline-color'), z, p), 1);
          if (oc) for (const rings of asRings(g)) page.drawSvgPath(rings.map((r) => pathOf(r, true)).join(' '), svgOpts({ borderColor: oc.color, borderOpacity: oc.opacity, borderWidth: 0.4 * S }));
        } else if (L.type === 'line') {
          const c = col(ev(paint('line-color'), z, p), num(ev(paint('line-opacity'), z, p), 1));
          const w = num(ev(paint('line-width'), z, p), 1) * S;
          if (!c || w <= 0) continue;
          const dash = ev(paint('line-dasharray'), z, p);
          const cap = ev(layout('line-cap'), z, p), join = ev(layout('line-join'), z, p);
          for (const line of asLines(g)) {
            if (line.length < 2) continue;
            page.drawSvgPath(pathOf(line, false), svgOpts({
              borderColor: c.color, borderOpacity: c.opacity, borderWidth: w,
              borderLineCap: cap === 'round' ? LineCapStyle.Round : cap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Butt,
              borderDashArray: Array.isArray(dash) ? dash.map((d) => Math.max(0.01, d * w)) : undefined,
            }));
            counts.lines++;
          }
        } else if (L.type === 'circle') {
          const c = col(ev(paint('circle-color'), z, p), num(ev(paint('circle-opacity'), z, p), 1));
          const r = num(ev(paint('circle-radius'), z, p), 3) * S;
          for (const pt of asPoints(g)) { const [x, y] = px(pt[0], pt[1]); if (c) page.drawCircle({ x, y, size: r, color: c.color, opacity: c.opacity }); counts.icons++; }
        } else if (L.type === 'symbol') try {
          // one symbol per feature id (a line-placed label repeats along its line: keep the first)
          const key = f.id !== undefined ? f.id + '|' + JSON.stringify(f.properties) : JSON.stringify(f.properties);
          if (seen.has(key)) continue;
          seen.add(key);
          const textRaw = ev(layout('text-field'), z, p);
          const text = textRaw === undefined || textRaw === null ? '' : String(textRaw);
          const size = num(ev(layout('text-size'), z, p), 12) * S;
          const fonts = ev(layout('text-font'), z, p);
          const bold = Array.isArray(fonts) ? /bold/i.test(fonts[0] || '') : /bold/i.test(String(fonts || ''));
          const font = bold ? fBold : fReg;
          const tc = col(ev(paint('text-color'), z, p), num(ev(paint('text-opacity'), z, p), 1)) || { color: rgb(0, 0, 0), opacity: 1 };
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
          // where: a point symbol at its anchor, a line symbol at the line's middle
          let anchors = [];
          let lineAngle = 0;
          if (placement === 'point' || g.type === 'Point' || g.type === 'MultiPoint') {
            anchors = asPoints(g).length ? asPoints(g) : (asLines(g)[0] ? [asLines(g)[0][Math.floor(asLines(g)[0].length / 2)]] : []);
          } else {
            const line = asLines(g)[0];
            if (!line || line.length < 2) continue;
            // the midpoint by length, and the segment's bearing there
            const pts = line.map((c) => px(c[0], c[1]));
            let total = 0; const acc = [0];
            for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(total); }
            const half = total / 2; let i = 1; while (i < acc.length && acc[i] < half) i++;
            const t = (half - acc[i - 1]) / Math.max(1e-6, acc[i] - acc[i - 1]);
            const ax = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, ay = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
            lineAngle = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI;
            if (lineAngle > 90) lineAngle -= 180; if (lineAngle < -90) lineAngle += 180; // never upside down
            const w = font.widthOfTextAtSize(clean(text, bold), size);
            if (w > total * 0.95) continue; // the label would not fit the piece on screen either
            anchors = [[ax, ay, true]];
          }
          for (const a of anchors) {
            const [ax, ay] = a[2] ? [a[0], a[1]] : px(a[0], a[1]);
            // icons: the generated badge boxes, stop half-discs and terminus dots
            let boxW = 0, boxH = 0;
            const t = clean(text, bold).replace(/\s+$/, '');
            const lines = wrap(t, font, size, maxWidthEm * size);
            const tw = Math.max(0, ...lines.map((l) => font.widthOfTextAtSize(l, size)));
            const th = lines.length * size * 1.1;
            if (typeof icon === 'string' && icon) {
              const rim = col((icon.match(/#[0-9a-f]{6}/i) || [null])[0], 1);
              if (/^badge-/.test(icon)) {
                boxW = tw + 7 * S; boxH = th + 3 * S;
                const dx = off[0] * size, dy = -off[1] * size;
                page.drawRectangle({ x: ax + dx - boxW / 2, y: ay + dy - boxH / 2, width: boxW, height: boxH, color: rgb(1, 1, 1), opacity: 0.92, borderColor: rim ? rim.color : rgb(0.2, 0.2, 0.2), borderWidth: 1.1 * S });
                counts.icons++;
              } else if (/^stop-/.test(icon)) {
                const r = 4.2 * iconSize * S;
                const th0 = (-iconRot) * Math.PI / 180;
                const pts = [];
                for (let k = 0; k <= 12; k++) { const a0 = th0 + Math.PI * k / 12; pts.push([ax + r * Math.cos(a0), ay + r * Math.sin(a0)]); }
                const d = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(2) + ' ' + (H * S - q[1]).toFixed(2)).join('') + 'Z';
                page.drawSvgPath(d, svgOpts({ color: rim ? rim.color : rgb(0, 0.35, 0.66), borderColor: rgb(1, 1, 1), borderWidth: 0.6 * S }));
                counts.icons++;
              } else if (/^dot-/.test(icon)) {
                page.drawCircle({ x: ax, y: ay, size: 4.5 * iconSize * S, color: rim ? rim.color : rgb(0, 0.35, 0.66), borderColor: rgb(1, 1, 1), borderWidth: 0.8 * S });
                counts.icons++;
              }
            }
            if (!t) continue;
            // Placement. MapLibre placed this label somewhere without a
            // collision, but for a variable-anchor label (stop names: eight
            // anchors around the pole) it does not say WHERE — so the same
            // rule is replayed here: the first anchor whose box is free of
            // every label drawn so far. Fixed labels (the number rows, the
            // badges) go where MapLibre put them and only register their box.
            const ang = a[2] ? lineAngle : rot;
            const th1 = (-ang) * Math.PI / 180; // PDF rotates counter-clockwise
            const dir = [Math.cos(th1), Math.sin(th1)], perp = [-Math.sin(th1), Math.cos(th1)];
            const R = radial * size;
            const map8 = { left: [R, 0], right: [-R, 0], top: [0, -R], bottom: [0, R], 'top-left': [R * 0.7, -R * 0.7], 'top-right': [-R * 0.7, -R * 0.7], 'bottom-left': [R * 0.7, R * 0.7], 'bottom-right': [-R * 0.7, R * 0.7], center: [0, 0] };
            const candidates = Array.isArray(vanch) && vanch.length && !a[2] ? vanch : [anchor];
            let chosen = null;
            for (const an of candidates) {
              let hx = 0.5, hy = 0.5; // fractions of the box to the left of / below the anchor
              if (/left/.test(an)) hx = 0; if (/right/.test(an)) hx = 1;
              if (/top/.test(an)) hy = 1; if (/bottom/.test(an)) hy = 0;
              let ox = off[0] * size, oy = -off[1] * size;
              if (radial && !a[2]) { const v = map8[an] || [0, 0]; ox += v[0]; oy += v[1]; }
              const cx = ax + ox, cy = ay + oy;
              // the block's centre in page space, then its axis-aligned bounds
              const bx = cx + dir[0] * (tw / 2 - tw * hx) + perp[0] * (th / 2 - th * hy);
              const by = cy + dir[1] * (tw / 2 - tw * hx) + perp[1] * (th / 2 - th * hy);
              const ex = Math.abs(dir[0]) * tw / 2 + Math.abs(perp[0]) * th / 2, ey = Math.abs(dir[1]) * tw / 2 + Math.abs(perp[1]) * th / 2;
              const box = [bx - ex, by - ey, bx + ex, by + ey];
              const free = candidates.length === 1 || !placed.some((q) => q[0] < box[2] && q[2] > box[0] && q[1] < box[3] && q[3] > box[1]);
              if (free) { chosen = { hx, hy, cx, cy, box }; break; }
            }
            if (!chosen) continue;
            placed.push(chosen.box);
            lines.forEach((ln, i) => {
              const lw = font.widthOfTextAtSize(ln, size);
              const rowY = (lines.length - 1 - i) * size * 1.1 - th * chosen.hy + th / 2 - size * 0.32;
              const rowX = chosen.hx === 0 ? 0 : chosen.hx === 1 ? -lw : -lw / 2;
              const x0 = chosen.cx + dir[0] * rowX + perp[0] * rowY, y0 = chosen.cy + dir[1] * rowX + perp[1] * rowY;
              page.drawText(ln, { x: x0, y: y0, size, font, color: tc.color, opacity: tc.opacity, rotate: degrees(-ang) });
              counts.texts++;
            });
          }
        } catch (e) { perLayer[L.id + '!'] = String(e.message || e); }
      }
      perLayer[L.id] = [feats.length, counts.texts - before.texts, counts.icons - before.icons, counts.lines - before.lines, counts.fills - before.fills];
    }
    leave();
    // register the layers with the document
    if (ocgRefs.length) {
      page.node.set(PDFName.of('Resources'), page.node.Resources() || ctx.obj({}));
      page.node.Resources().set(PDFName.of('Properties'), props);
      doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: ocgRefs, D: ctx.obj({ Order: ocgRefs, ON: ocgRefs, BaseState: 'ON' }) }));
    }
    console.log('pdf-export', counts, window.__pdfDebug ? perLayer : '');
    return doc.save();

    function wrap(t, font, size, maxW) {
      if (!t.includes(' ') || font.widthOfTextAtSize(t, size) <= maxW) return t.split('\n');
      const out = []; let cur = '';
      for (const w of t.split(/\s+/)) {
        const cand = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(cand, size) > maxW && cur) { out.push(cur); cur = w; } else cur = cand;
      }
      if (cur) out.push(cur);
      return out;
    }
  }
})();
