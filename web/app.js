// Frontend: MapLibre GL + OpenFreeMap vector tiles (positron) + KMK line layers
// in the visual logic of a classic printed network map.
const KMK = '#0059a9';
const KMK_DARK = '#00294f';
const TROLLEY_GREEN = '#149a3f';
// The LINES view spends all of its colour on the lines themselves, so its base,
// its stops and its street names are pure neutral ink — nothing else may spend
// a hue there or it competes with a strand for the same meaning.
const STOP_INK = '#464c55';
// Narrow label face. Arial Narrow itself cannot be used: MapLibre text comes from
// pre-rendered glyph PBFs on a font server, and no server hosts that licensed
// font — Roboto Condensed is the hosted narrow equivalent (with Greek coverage).
const NARROW = 'roboto_condensed_regular';
const NARROW_BOLD = 'roboto_condensed_bold';

let map;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Scales the outputs of a size value (plain number, interpolate stops, case
// branches) by f — used by the label-size buttons and by the poster export,
// which blows up the whole symbology the same way.
const scaleOut = (v, f) => {
  if (typeof v === 'number') return v * f;
  if (Array.isArray(v)) {
    if (v[0] === 'interpolate') return v.map((x, i) => (i >= 3 && i % 2 === 0 ? scaleOut(x, f) : x));
    if (v[0] === 'case') return v.map((x, i) => ((i >= 2 && i % 2 === 0) || i === v.length - 1 ? scaleOut(x, f) : x));
    if (v[0] === '*') {
      // badge sizes are ['*', const, per-feature sc] — boost the constant
      const i = v.findIndex((x, j) => j > 0 && typeof x === 'number');
      return i > 0 ? v.map((x, j) => (j === i ? x * f : x)) : ['*', f, v];
    }
  }
  return v;
};

async function init() {
  // The OpenFreeMap glyph server only hosts Noto Sans, so the style is fetched
  // and its glyphs endpoint swapped to VersaTiles, which serves BOTH Noto Sans
  // (for the base style) and Roboto Condensed (for our labels). VersaTiles names
  // stacks in snake_case and has no Noto Sans Italic — remap the base style's
  // fonts (italic degrades to regular, cosmetic only).
  const style = await (await fetch('https://tiles.openfreemap.org/styles/positron')).json();
  style.glyphs = 'https://tiles.versatiles.org/assets/glyphs/{fontstack}/{range}.pbf';
  const FONT_MAP = {
    'Noto Sans Regular': 'noto_sans_regular',
    'Noto Sans Bold': 'noto_sans_bold',
    'Noto Sans Italic': 'noto_sans_regular',
  };
  // "Paper map" recolor of the pale positron base — the look of the printed KMK
  // poster: warm tinted districts, green parks, real-blue water, pale-yellow
  // motorways, darker street names, brown-gray railways.
  const BASE_RECOLOR = {
    background: { 'background-color': '#e8e4d8' },
    landuse_residential: { 'fill-color': '#e6d2c2' },
    park: { 'fill-color': '#c4dfa4' },
    landcover_wood: { 'fill-color': '#b3d295' },
    water: { 'fill-color': '#9dc2e0' },
    waterway: { 'line-color': '#9dc2e0' },
    building: { 'fill-color': '#dccdb9', 'fill-outline-color': '#c9b8a2' },
    road_area_pier: { 'fill-color': '#e8e4d8' },
    road_pier: { 'line-color': '#e8e4d8' },
    'aeroway-area': { 'fill-color': '#f0ece0' },
    'aeroway-runway': { 'line-color': '#f0ece0' },
    'aeroway-taxiway': { 'line-color': '#d8d2c2' },
    'aeroway-runway-casing': { 'line-color': '#d8d2c2' },
    highway_path: { 'line-color': '#d9d3c3' },
    highway_minor: { 'line-color': '#fdfcf6' },
    highway_major_casing: { 'line-color': '#c8bfab' },
    highway_major_inner: { 'line-color': '#fffdf6' },
    highway_major_subtle: { 'line-color': 'hsla(38,25%,74%,0.69)' },
    highway_motorway_casing: { 'line-color': '#c2b28e' },
    highway_motorway_inner: { 'line-color': '#f8e9b0' },
    highway_motorway_subtle: { 'line-color': 'hsla(45,45%,70%,0.55)' },
    highway_motorway_bridge_casing: { 'line-color': '#c2b28e' },
    highway_motorway_bridge_inner: { 'line-color': '#f8e9b0' },
    tunnel_motorway_casing: { 'line-color': '#d3cab4' },
    tunnel_motorway_inner: { 'line-color': '#efe8d2' },
    railway: { 'line-color': '#a2968a' },
    railway_dashline: { 'line-color': '#f4efe2' },
    railway_service: { 'line-color': '#a2968a' },
    railway_service_dashline: { 'line-color': '#f4efe2' },
    railway_transit: { 'line-color': '#a2968a' },
    railway_transit_dashline: { 'line-color': '#f4efe2' },
    boundary_3: { 'line-color': '#a89f8e' },
    boundary_2: { 'line-color': '#a89f8e' },
    // WIDE WHITE halo, not the paper-cream one: street names cross the transit
    // strokes and the building fill, and a thin tinted outline let them sink
    // into both (user report). The same halo is used by our own street-name
    // layers below, so base and transit names read as one typographic system.
    'highway-name-minor': { 'text-color': '#33312b', 'text-halo-color': '#ffffff', 'text-halo-width': 2.4, 'text-halo-blur': 0.3 },
    'highway-name-major': { 'text-color': '#2b2924', 'text-halo-color': '#ffffff', 'text-halo-width': 2.8, 'text-halo-blur': 0.3 },
    'highway-name-path': { 'text-color': '#8a8171', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
  };

  // THE SECOND BASE (ported from the Tricity map, 21.08.2026). Every colour
  // positron declares is flattened to its own luminance and faded toward
  // white — layers nobody thought about still come out grey. The few that
  // carry meaning (water, parks, the built-up ground) are named by hand.
  const gctx = document.createElement('canvas').getContext('2d');
  const greyOf = (col, keepInk) => {
    gctx.fillStyle = '#000000';
    gctx.fillStyle = col;
    const t = gctx.fillStyle;
    let r, g, b, al = 1;
    if (t[0] === '#') { r = parseInt(t.slice(1, 3), 16); g = parseInt(t.slice(3, 5), 16); b = parseInt(t.slice(5, 7), 16); }
    else { const mm = (t.match(/[\d.]+/g) || ['0', '0', '0']).map(Number); [r, g, b] = mm; if (mm[3] !== undefined) al = mm[3]; }
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // text keeps its full darkness; fills and strokes are pulled 28 % toward
    // white, which is the headroom the coloured strokes need to read as ink
    const v = Math.round(Math.max(0, Math.min(255, keepInk ? lum : 255 - (255 - lum) * 0.72)));
    return al < 1 ? `rgba(${v},${v},${v},${al})` : '#' + [v, v, v].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  const COLOR_PROPS = ['background-color', 'fill-color', 'fill-outline-color', 'line-color',
    'text-color', 'text-halo-color', 'icon-color', 'icon-halo-color', 'circle-color', 'fill-extrusion-color'];
  const greyDeep = (v, keepInk) => {
    if (typeof v === 'string') return greyOf(v, keepInk);
    if (Array.isArray(v)) return v.map((x, i) => (i === 0 ? x : greyDeep(x, keepInk)));
    return v;
  };
  // Roads stay WHITE and the ground goes a step darker: positron paints
  // service roads and ramps as a hairline, and on a pale grey ground they
  // disappeared — a stroke riding one then looks like it left the street.
  const GREY_RECOLOR = {
    background: { 'background-color': '#e9e9e9' },
    landuse_residential: { 'fill-color': '#e4e4e4' },
    park: { 'fill-color': '#dfdfdf' },
    landcover_wood: { 'fill-color': '#d9d9d9' },
    water: { 'fill-color': '#cfcfcf' },
    waterway: { 'line-color': '#cfcfcf' },
    building: { 'fill-color': '#e0e0e0', 'fill-outline-color': '#d4d4d4' },
    highway_minor: { 'line-color': '#ffffff' },
    highway_major_casing: { 'line-color': '#cfcfcf' },
    highway_major_inner: { 'line-color': '#ffffff' },
    highway_motorway_casing: { 'line-color': '#c2c2c2' },
    highway_motorway_inner: { 'line-color': '#f4f4f4' },
    railway: { 'line-color': '#c4c4c4' },
    railway_transit: { 'line-color': '#c4c4c4' },
    'highway-name-minor': { 'text-color': '#4f4f4f', 'text-halo-color': '#ffffff', 'text-halo-width': 2.4, 'text-halo-blur': 0.3 },
    'highway-name-major': { 'text-color': '#3c3c3c', 'text-halo-color': '#ffffff', 'text-halo-width': 2.8, 'text-halo-blur': 0.3 },
    'highway-name-path': { 'text-color': '#8c8c8c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
  };
  // both palettes, per layer and per property, captured while the style is
  // still a plain object — switching is then a loop of setPaintProperty
  const BASE_PAINT = [];
  // Stock positron holds street names back (minor z15+, major z12.2) — far too
  // late for a transit map, where the streets carry the content. Pull them in
  // earlier (minor stays at 13: the tiles only carry minor names from there)
  // and halve the 250 px default spacing so long streets repeat their name
  // instead of showing it once. They still lose collisions to line numbers and
  // stop names, by design.
  const BASE_MINZOOM = { 'highway-name-minor': 13, 'highway-name-major': 13 };
  const BASE_SPACING = { 'highway-name-minor': 130, 'highway-name-major': 130 };
  for (const l of style.layers) {
    const tf = l.layout && l.layout['text-font'];
    if (Array.isArray(tf)) l.layout['text-font'] = tf.map((f) => FONT_MAP[f] || f);
    const o = BASE_RECOLOR[l.id], gr = GREY_RECOLOR[l.id];
    if (o) l.paint = { ...l.paint, ...o };
    if (l.paint) for (const k of COLOR_PROPS) {
      if (l.paint[k] === undefined) continue;
      BASE_PAINT.push({ id: l.id, prop: k, paper: l.paint[k],
        grey: (gr && gr[k] !== undefined) ? gr[k] : greyDeep(l.paint[k], k === 'text-color' || k === 'icon-color') });
    }
    // halo widths differ too, and they are not colours
    if (gr) for (const k of ['text-halo-width', 'text-halo-blur']) {
      if (gr[k] === undefined) continue;
      BASE_PAINT.push({ id: l.id, prop: k, paper: (l.paint && l.paint[k]) ?? (k === 'text-halo-width' ? 1 : 0), grey: gr[k] });
    }
    if (BASE_MINZOOM[l.id]) l.minzoom = BASE_MINZOOM[l.id];
    if (BASE_SPACING[l.id]) l.layout = { ...l.layout, 'symbol-spacing': BASE_SPACING[l.id] };
    // road-number shields (433, S11…) read as line badges on a transit map
    if (/shield/.test(l.id)) l.layout = { ...l.layout, visibility: 'none' };
  }
  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [19.94, 50.06],
    zoom: 10.2,
    attributionControl: false,
  });
  window.__map = map; // debug/test hook (jumpTo, queryRenderedFeatures)
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true, fitBoundsOptions: { maxZoom: 15.5 } }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Timetables: GTFS ZTP Kraków · MLD (Koleje Małopolskie) · WST Wieliczka' }));

  const [meta, linesMeta] = await Promise.all([
    fetch('data/meta.json').then((r) => r.json()),
    // small (a colour per line + the geometry constants the lines view needs)
    fetch('data/lines-meta.json').then((r) => r.json()).catch(() => null),
    // Do not hang on 'load' (one stuck tile blocks it forever) —
    // a loaded style is enough, tiles catch up in the background.
    new Promise((res) => {
      if (map.loaded()) return res();
      map.once('load', res);
      const t = setInterval(() => {
        if (map.isStyleLoaded()) { clearInterval(t); res(); }
      }, 400);
    }),
  ]);

  // The map can be constructed before the stylesheet lays out #map (style
  // fetched from disk cache beats CSSOM) — the canvas then sticks at the
  // 400×300 fallback (this maplibre build only watches window.resize).
  // Re-measure now that layout is settled; the initial jumpTo below sets the view.
  map.resize();

  // Panel (English, minimal): legend + mode toggles + expandable clickable line list.
  const nBus = meta.lines.filter((l) => l.mode === 'bus').length;
  const nTram = meta.lines.filter((l) => l.mode === 'tram').length;
  document.getElementById('count').textContent = `(${nBus} bus · ${nTram} tram)`;
  document.getElementById('stamp').textContent = new Date(meta.generatedAt).toLocaleDateString('en-GB');
  // In the corridor view a chip carries its MODE's colour (navy bus, green
  // trolleybus, red tram); in the lines view it carries the colour that line is
  // actually drawn in, and the cloud doubles as the legend.
  const LINE_COLORS = (linesMeta && linesMeta.colors) || {};
  const CORRIDOR_INK = '#6f757e';
  const lineColor = (l) => LINE_COLORS[l] || CORRIDOR_INK;
  const LINE_COLOR_MATCH = ['match', ['get', 'line'],
    ...Object.entries(LINE_COLORS).flatMap(([l, c]) => [l, c]), CORRIDOR_INK];
  const paintChips = (linesView) => {
    document.getElementById('chips').innerHTML = meta.lines
      .map((l) => `<button class="chip${l.line === state.selected ? ' active' : ''}" data-line="${esc(l.line)}" ` +
        `style="background:${esc(linesView ? lineColor(l.line) : l.color)}">${esc(l.line)}</button>`)
      .join(' ');
  };

  // Panel state. `view` is the big one: 'corridors' is this map as it has always
  // been — one stroke per roadway, the whole network in its mode colours — and
  // 'lines' redraws the same data line by line, up to four coloured strands
  // side by side, everything busier as one grey trunk. Both views are built from
  // the same files; the switch is layers and paint, never a reload.
  const state = { bus: true, tram: true, selected: null, journey: null, view: 'corridors', bg: 'auto' };
  paintChips(false);

  // Line layers go below the base style labels (street names stay readable).
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  // Strokes come from the merged-streets layer (one stroke per roadway regardless
  // of line count — the KMK map logic), not from overlapping per-line routes.
  map.addSource('streets', { type: 'geojson', data: 'data/streets.geojson' });
  map.addSource('stops', { type: 'geojson', data: 'data/stops.geojson' });

  // Trams/trolleybuses drawn with the same logic as buses (both tracks at their
  // true OSM positions). Metro is the exception: a WIDE translucent ribbon with
  // no white casing, laid over the street network like on printed transit maps.
  const metroC = ['==', ['get', 'metro'], 1];
  map.addLayer({
    id: 'route-casing', type: 'line', source: 'streets',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 14, 4.6, 17, 9],
      'line-opacity': ['case', metroC, 0, 1],
    },
  }, firstSymbol);
  map.addLayer({
    id: 'route-line', type: 'line', source: 'streets',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], KMK],
      'line-width': ['interpolate', ['linear'], ['zoom'],
        10, ['case', metroC, 3, 1.1],
        14, ['case', metroC, 7, 2.3],
        17, ['case', metroC, 14, 4.5]],
      'line-opacity': ['case', metroC, 0.4, 1],
    },
  }, firstSymbol);
  // Shared bus+trolleybus roadways: green dashes over the navy stroke, so the
  // alternation reads as "both ride here". Trolleybus-only roadways are simply
  // green via properties.color from the pipeline.
  map.addLayer({
    id: 'route-trolley-dash', type: 'line', source: 'streets',
    filter: ['==', ['get', 'trolley'], 'mix'],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': TROLLEY_GREEN,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.1, 14, 2.3, 17, 4.5],
      'line-dasharray': [1.6, 2.2],
    },
  }, firstSymbol);

  // ---- THE LINES VIEW's strokes, built now and hidden until it is asked for.
  // Same data, drawn line by line: a roadway with up to 4 lines arrives as one
  // feature PER LINE (its slot baked in as `oi`), anything busier as a single
  // grey trunk. The pipeline (pipeline/lines.mjs) decides which is which; here
  // they are two more layers. (Ported from the Tricity map, 21.08.2026.)
  const linesOK = !!linesMeta;
  // The sources start EMPTY and are filled the first time the lines view is
  // asked for. Its files are the heavy ones (the swings alone are megabytes of
  // short pieces), and the corridor view — the default, the one most readers
  // will only ever see — has no business paying for them.
  const EMPTY = { type: 'FeatureCollection', features: [] };
  let linesLoaded = false;
  const loadLines = () => {
    if (linesLoaded) return;
    linesLoaded = true;
    map.getSource('corridors').setData('data/lines-corridors.geojson');
    map.getSource('strands').setData('data/lines-strands.geojson');
  };
  if (linesOK) {
    map.addSource('corridors', { type: 'geojson', data: EMPTY });
    map.addSource('strands', { type: 'geojson', data: EMPTY });
  }
  // pitch barely above the stroke width (1.0 / 2.2 / 3.9): neighbours nearly
  // touch, separated by a ~half-pixel hairline of casing. The Line width
  // buttons scale stroke AND pitch together, so the proportion holds at every
  // thickness.
  const [P11, P14, P17] = [1.45, 2.7, 4.5];
  const zoomStops = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 11, a, 14, b, 17, c];
  const STRAND_W = zoomStops(1.0, 2.2, 3.9);
  // the casing covers the hairline between neighbours and ends flush with the
  // outer strand
  const STRAND_CASE = zoomStops(1.8, 3.0, 4.9);
  const CORRIDOR_W = zoomStops(2.0, 4.4, 7.6);
  // NOT ['*', ['get','oi'], PITCH]: MapLibre only accepts a zoom expression at
  // the TOP level of interpolate/step, so the slot multiplies inside each stop.
  const SLOT_OFFSET = zoomStops(['*', ['get', 'oi'], P11], ['*', ['get', 'oi'], P14], ['*', ['get', 'oi'], P17]);
  if (linesOK) {
    map.addLayer({
      id: 'corridor-casing', type: 'line', source: 'corridors',
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: { 'line-color': '#ffffff', 'line-width': zoomStops(3.4, 6.4, 10.6) },
    }, firstSymbol);
    map.addLayer({
      id: 'corridor-line', type: 'line', source: 'corridors',
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: { 'line-color': CORRIDOR_INK, 'line-width': CORRIDOR_W },
    }, firstSymbol);
    // every casing first, then every colour: a casing drawn after its
    // neighbour's colour would eat the strand next to it
    map.addLayer({
      id: 'strand-casing', type: 'line', source: 'strands',
      // no casing on the pieces of a swing — see pipeline/lines.mjs
      filter: ['!=', ['get', 'sw'], 1],
      // BUTT caps, not round: a strand is cut into pieces wherever its offset
      // changes, and a round cap would stick out sideways from the next piece
      layout: { 'line-join': 'round', 'line-cap': 'butt', visibility: 'none' },
      paint: { 'line-color': '#ffffff', 'line-width': STRAND_CASE, 'line-offset': SLOT_OFFSET },
    }, firstSymbol);
    map.addLayer({
      id: 'strand-line', type: 'line', source: 'strands',
      layout: { 'line-join': 'round', 'line-cap': 'butt', visibility: 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': STRAND_W, 'line-offset': SLOT_OFFSET },
    }, firstSymbol);
  }

  // Line numbers: pipeline points carry the street bearing (angle) — the text is
  // rotated PARALLEL to the road and offset sideways in text space (anchor bottom
  // + offset), so it stands BESIDE the roadway along its course, never on the stroke.
  // A shared bus+rail corridor = one segment: the metro/tram row (in that line's
  // own color — M1 green, M2 red, M3 azure, tram purple) above the bus row.
  const TRAM_RED = '#d6212b';
  const railColor = ['coalesce', ['get', 'color'], TRAM_RED];
  const corridorRow = ['case', ['has', 'busLines'],
    ['format',
      ['get', 'lines'], { 'text-color': railColor },
      '\n', {},
      ['get', 'busLines'], { 'text-color': KMK }],
    ['format', ['get', 'lines'], {}]];
  // The row source is SWAPPED between the two views (labels.geojson ↔
  // lines-rows.geojson) rather than duplicated, so one set of layers, one
  // collision ladder and one density control serve both. The rows of the lines
  // view carry their numbers one per property (l0/c0, l1/c1 …) because MapLibre
  // paints one colour per `format` SECTION and there every number keeps its own
  // line's colour.
  const TRUNK_INK = '#41464e';
  const colouredRow = ['format'];
  for (let i = 0; i < ((linesMeta && linesMeta.rowSlots) || 41); i++) {
    colouredRow.push(['coalesce', ['get', 'l' + i], ''], { 'text-color': ['coalesce', ['get', 'c' + i], TRUNK_INK] });
  }
  // one field for both: a row that carries l0 came from the lines view
  const numberField = ['case', ['has', 'l0'], colouredRow, corridorRow];
  map.addSource('labels', { type: 'geojson', data: 'data/labels.geojson' });
  const numbersLayout = {
    'text-field': numberField,
    'text-font': [NARROW_BOLD],
    // a quarter smaller than the stop names' scale: the rows are the most
    // repeated element on the map, and at the old size they crowded whole
    // corridors out of the placement (the Label size buttons scale from here)
    'text-size': ['interpolate', ['linear'], ['zoom'], 11, 6.8, 14, 8.6, 17, 10.9],
    'text-rotate': ['get', 'angle'],
    'text-rotation-alignment': 'map',
    // 'auto' inherits pitch-alignment 'map', and that path in MapLibre 5.6 kills
    // rotated point symbols (0 rendered); the map has no pitch anyway
    'text-pitch-alignment': 'viewport',
    // both sides of the street are candidates: when a stop name (or another
    // row) holds the preferred side, the row flips instead of dying
    'text-variable-anchor': ['bottom', 'top'],
    'text-radial-offset': 0.6,
    // Long rows WRAP into a stacked block (the printed-KMK convention). This
    // also matters for collisions: a symbol that rotates with the map is
    // reserved through the AXIS-ALIGNED ENVELOPE of its rotated box, so a wide
    // flat block set diagonally claims up to twice its own area and dies
    // against anything placed earlier. The envelope is smallest when the block
    // is SQUARE, so the wrap width follows the row length: w ≈ 1.45·√chars
    // (measured in Rybnik centre at z14: 16 → 22 rows placed).
    'text-max-width': ['max', 4, ['min', 11, ['round', ['*', 1.45, ['sqrt', ['length', ['get', 'lines']]]]]]],
    'text-line-height': 1.15,
    // 2 px of collision padding around every block is a whole extra row's worth
    // of margin once the map is packed
    'text-padding': 1,
    // when not everything fits, the busiest corridors are the ones worth
    // keeping: MapLibre places ascending sort keys first
    'symbol-sort-key': ['-', 0, ['length', ['get', 'lines']]],
  };
  const numbersPaint = { 'text-color': ['coalesce', ['get', 'color'], KMK], 'text-halo-color': '#ffffff', 'text-halo-width': 2 };
  // Every label is collision-managed (allow-overlap turned whole districts into
  // digit soup — user report, twice). Numbers still win against stop names
  // because their layers sit ABOVE them in the style: MapLibre places symbols
  // top-most layer first, so numbers claim their spot and names yield. Repeats
  // (extra:1) exist only on very long avenues, emitted sparsely by the pipeline,
  // and rank BELOW the once-per-street anchors.
  const NUM_LAYERS = [
    { id: 'street-numbers-low', minzoom: 11, maxzoom: 13, cond: ['!', ['has', 'extra']] },
    { id: 'street-numbers', minzoom: 13, cond: ['all', ['!', ['has', 'extra']], ['<=', ['length', ['get', 'lines']], 40]] },
    { id: 'street-numbers-extra', minzoom: 13, cond: ['has', 'extra'] },
  ];
  // Each number layer exists twice: the pipeline marks rows whose default
  // (north-ish) box side lies on a foreign stroke with side:-1, and the -flip
  // variant tries the opposite side of the street first. The anchor order is
  // a layout CONSTANT in MapLibre, so a per-feature preference needs the split.
  const SIDE_VARIANTS = [
    { suf: '', anchors: ['bottom', 'top'], cond: ['!=', ['get', 'side'], -1] },
    { suf: '-flip', anchors: ['top', 'bottom'], cond: ['==', ['get', 'side'], -1] },
  ];
  for (const d of NUM_LAYERS) for (const v of SIDE_VARIANTS) {
    const def = {
      id: d.id + v.suf, type: 'symbol', source: 'labels',
      minzoom: d.minzoom,
      filter: ['all', d.cond, v.cond],
      layout: { ...numbersLayout, 'text-variable-anchor': v.anchors },
      paint: { ...numbersPaint },
    };
    if (d.maxzoom) def.maxzoom = d.maxzoom;
    map.addLayer(def);
  }
  // Rows past ~9 numbers are the trunk corridors. Their content outranks the
  // neighbours (user decision: a trunk with no numbers on the poster is a hole
  // in the map, slight crowding is fine), so they place BEFORE stop and street
  // names. The id deliberately does NOT match /^street-numbers/: the poster
  // boost slots street names above that prefix, and these must stay on top.
  for (const v of SIDE_VARIANTS) map.addLayer({
    id: 'big-number-rows' + v.suf, type: 'symbol', source: 'labels',
    minzoom: 13,
    filter: ['all', ['!', ['has', 'extra']], ['>', ['length', ['get', 'lines']], 40], v.cond],
    layout: { ...numbersLayout, 'text-variable-anchor': v.anchors },
    paint: { ...numbersPaint },
  });

  // STREET NAMES OF THE NETWORK, drawn from our own source instead of the base
  // tiles. The tiles carry minor-road names only from z13, publish them once
  // every few hundred metres and drop most of them in collisions — so the
  // streets the lines actually ride on ran nameless (user report: "far too few
  // street names"). A geojson source has no zoom gate: every roadway with a
  // name in OSM can print it at any zoom, repeated along its whole course, with
  // the wide white halo that keeps it readable over the strokes.
  // The geometry is NOT the stroke layer: that one is cut wherever the line set
  // changes (median fragment at z12.6: 21 px, shorter than the name itself), so
  // the pipeline re-joins the runs by name into whole streets. Roundabouts are
  // left out — text bent around a 20 m circle is unreadable, and the streets
  // meeting there carry the name anyway.
  map.addSource('street-names', { type: 'geojson', data: 'data/street-names.geojson' });
  const streetNamesDef = (id, extra) => ({
    id, type: 'symbol', source: 'street-names',
    ...extra,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [NARROW],
      'symbol-placement': 'line',
      // tighter than the base style's 250 px: a long avenue should repeat its
      // name every couple of blocks, the way printed network maps do
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 11, 190, 14, 260, 17, 380],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9.5, 14, 11.5, 17, 13.5],
      // beside the stroke, on the opposite side from the line numbers
      // (those sit 0.6 em above it), so name and numbers never fight
      'text-offset': [0, 0.9],
      'text-max-angle': 32,
      'text-padding': 2,
      'text-pitch-alignment': 'viewport',
    },
    // the widest halo on the map: these names lie across the transit strokes
    // themselves, where a thin outline disappeared into the navy
    paint: { 'text-color': '#2b2924', 'text-halo-color': '#ffffff', 'text-halo-width': 3, 'text-halo-blur': 0.3 },
  });
  map.addLayer(streetNamesDef('transit-street-names', { minzoom: 13 }));

  // Stops as HALF-DISCS: flat edge lying on the line, bulge pointing to the
  // pole's side of the street (angle from the pipeline). Canvas-drawn icon per
  // color pair — regular: white fill + colored rim; terminus: filled + dark rim.
  const PALETTE = [
    [KMK, KMK_DARK], [TROLLEY_GREEN, '#0a5121'],
    ['#009550', '#00512b'], ['#e30613', '#7c060e'], ['#1e9cd7', '#0d567a'],
    ['#7d2b8b', '#45164e'], ['#d6212b', '#7c1116'],
  ];
  const discIcon = (fill, rim, half) => {
    const S = 48;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');
    x.beginPath();
    // half: upper semicircle (bulge up at angle 0); full: whole disc (metro)
    x.arc(S / 2, S / 2, 15, half ? Math.PI : 0, 2 * Math.PI);
    if (half) x.closePath();
    x.fillStyle = fill; x.fill();
    x.lineWidth = 5; x.lineJoin = 'round'; x.strokeStyle = rim; x.stroke();
    return x.getImageData(0, 0, S, S);
  };
  // Terminus badge box: translucent rounded rectangle rimmed in the line color;
  // registered as a STRETCHABLE image so icon-text-fit wraps it around any number.
  const badgeBox = (rim) => {
    const W = 26, H = 20, LW = 2.5;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.beginPath();
    x.roundRect(LW / 2 + 0.5, LW / 2 + 0.5, W - LW - 1, H - LW - 1, 5);
    x.fillStyle = 'rgba(255,255,255,0.72)'; x.fill();
    x.lineWidth = LW; x.strokeStyle = rim; x.stroke();
    return x.getImageData(0, 0, W, H);
  };
  const addStopIcons = (m) => {
    for (const [c, cd] of PALETTE) {
      m.addImage('stop-' + c, discIcon('#ffffff', c, true), { pixelRatio: 2 });
      m.addImage('stop-' + c + '-t', discIcon(c, cd, true), { pixelRatio: 2 });
      m.addImage('dot-' + c, discIcon('#ffffff', c, false), { pixelRatio: 2 });
      m.addImage('dot-' + c + '-t', discIcon(c, cd, false), { pixelRatio: 2 });
      m.addImage('badge-' + c, badgeBox(c), {
        pixelRatio: 2,
        stretchX: [[10, 16]], stretchY: [[8, 12]], content: [6, 4, 20, 16],
      });
    }
  };
  // Safety net: a line color the palette misses must never strip a badge of
  // its box or a station of its dot — generate the icon on demand, deriving
  // the dark rim from the color itself.
  const darkenHex = (hex) => '#' + (hex.match(/[0-9a-f]{2}/gi) || [])
    .map((h) => Math.round(parseInt(h, 16) * 0.45).toString(16).padStart(2, '0')).join('');
  const addMissingIcon = (m) => (e) => {
    const g = /^(stop|dot|badge)-(#[0-9a-f]{6})(-t)?$/.exec(e.id);
    if (!g || m.hasImage(e.id)) return;
    const [, kind, c, t] = g;
    if (kind === 'badge') {
      m.addImage(e.id, badgeBox(c), {
        pixelRatio: 2,
        stretchX: [[10, 16]], stretchY: [[8, 12]], content: [6, 4, 20, 16],
      });
    } else {
      m.addImage(e.id, discIcon(t ? c : '#ffffff', t ? darkenHex(c) : c, kind === 'stop'), { pixelRatio: 2 });
    }
  };
  map.on('styleimagemissing', addMissingIcon(map));
  addStopIcons(map);
  // the lines view paints terminus badges in each line's own colour — one box
  // per colour of the lines palette, and the neutral stop ink for the discs
  {
    const extra = new Set([STOP_INK, ...Object.values(LINE_COLORS)]);
    for (const c of extra) {
      if (!map.hasImage('badge-' + c)) map.addImage('badge-' + c, badgeBox(c), {
        pixelRatio: 2, stretchX: [[10, 16]], stretchY: [[8, 12]], content: [6, 4, 20, 16],
      });
      const cd = darkenHex(c);
      if (!map.hasImage('stop-' + c)) {
        map.addImage('stop-' + c, discIcon('#ffffff', c, true), { pixelRatio: 2 });
        map.addImage('stop-' + c + '-t', discIcon(c, cd, true), { pixelRatio: 2 });
        map.addImage('dot-' + c, discIcon('#ffffff', c, false), { pixelRatio: 2 });
        map.addImage('dot-' + c + '-t', discIcon(c, cd, false), { pixelRatio: 2 });
      }
    }
  }
  map.addLayer({
    id: 'stops-dots', type: 'symbol', source: 'stops',
    minzoom: 11,
    layout: {
      // metro stations and TERMINI are ALWAYS full discs; ordinary street stops
      // are half-discs with the bulge on the pole's side of the roadway
      'icon-image': ['concat',
        ['case', ['any', ['==', ['get', 'metro'], 1], ['==', ['get', 'terminus'], 1]], 'dot-', 'stop-'],
        ['coalesce', ['get', 'color'], KMK],
        ['case', ['==', ['get', 'terminus'], 1], '-t', '']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.34, 14, 0.62, 17, 1.05],
      'icon-rotate': ['get', 'angle'],
      'icon-rotation-alignment': 'map',
      // same MapLibre pitfall as rotated text: pitch-alignment must be explicit
      'icon-pitch-alignment': 'viewport',
      'icon-allow-overlap': true,
    },
  });
  map.addLayer({
    id: 'stops-names', type: 'symbol', source: 'stops',
    minzoom: 13,
    // metro station names live in their own top-priority layer (see below)
    filter: ['all', ['!=', ['get', 'terminus'], 1], ['!=', ['get', 'metro'], 1], ['==', ['get', 'label'], 1]],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [NARROW],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 17, 13.5],
      // 8 candidate anchors: in the densest blocks (badge complexes, terminus
      // names) the four straight ones are all taken and the name must be able
      // to dodge diagonally — a stop without its name is a hard error here
      'text-variable-anchor': ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
      'text-radial-offset': 0.75,
      'text-justify': 'auto',
    },
    paint: { 'text-color': '#000000', 'text-halo-color': '#ffffff', 'text-halo-width': 1.7 },
  });
  map.addLayer({
    id: 'stops-terminus-names', type: 'symbol', source: 'stops',
    // below z13 only — from z13 the terminus names ride with the badge
    // complexes (pipeline-reserved rows, never dropped), see below
    minzoom: 10.5, maxzoom: 13,
    filter: ['all', ['==', ['get', 'terminus'], 1], ['!=', ['get', 'metro'], 1], ['==', ['get', 'label'], 1]],
    layout: {
      // terminus: name only — the terminating lines render as boxed badges in
      // their own layer (grid under the dot)
      'text-field': ['get', 'name'],
      'text-font': [NARROW_BOLD],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10.5, 11, 17, 14.5],
      // radial 1.15: at the heaviest nodes (Kaponiera) 0.9 em left no free
      // spot between the badge complex below and the neighbour's name above
      'text-variable-anchor': ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
      'text-radial-offset': 1.15,
      'text-justify': 'auto',
    },
    paint: { 'text-color': '#000000', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  });
  // Every metro station is labeled, always: the tunnels run under busy avenues,
  // so in the shared stop-name layer their names lost the collision fight against
  // bus stops and street numbers. Own layer + moveLayer to the very top = first in
  // symbol placement, so these names are never dropped.
  map.addLayer({
    id: 'stops-metro-names', type: 'symbol', source: 'stops',
    minzoom: 11.5,
    filter: ['all', ['==', ['get', 'metro'], 1], ['==', ['get', 'label'], 1]],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [NARROW_BOLD],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 10.5, 17, 14],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
    },
    paint: { 'text-color': '#000000', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  });
  // Terminus line badges: one small translucent box per line, laid out as a
  // centered grid below the loop (offsets precomputed by the pipeline). The same
  // badges exist in several ZOOM BANDS — in each band the pipeline fused the grids
  // that would collide at that scale into one complex, so only the band matching
  // the current zoom is drawn.
  map.addSource('badges', { type: 'geojson', data: 'data/badges.geojson' });
  const BADGE_BANDS = meta.badgeBands || [[13, 14], [14, 15], [15, 16.5], [16.5, 22]];
  // legacy data without `band` passes every band filter — the disjoint zoom
  // ranges still draw it exactly once, so a stale badges.geojson degrades to the
  // unfused layout instead of an empty map
  const bandC = (b) => ['any', ['!', ['has', 'band']], ['==', ['get', 'band'], b]];
  // CONSTANT text size per band layer — never zoom-interpolated. MapLibre fits
  // the icon-text-fit box at the tile-layout text size but renders the text at
  // the interpolated size, so at fractional zooms the em grid offsets diverge
  // and the drift accumulates row by row (and exports always render at
  // fractional zooms). One number per band = layout and render always agree.
  const BADGE_EM = [7.7, 8.1, 8.7, 9.5, 10];
  const NAME_EM = [9.7, 10.3, 11, 11.9, 12.5];
  const BADGE_LAYERS = BADGE_BANDS.map(([z0, z1], b) => {
    const id = 'stops-terminus-badges-' + b;
    map.addLayer({
      id, type: 'symbol', source: 'badges',
      minzoom: z0, maxzoom: z1,
      filter: ['all', bandC(b), ['has', 'line']],
      layout: {
        'text-field': ['get', 'line'],
        'text-font': [NARROW_BOLD],
        // × sc: crowded complexes arrive pre-shrunk from the pipeline — the
        // per-feature constant keeps layout and render in agreement (the same
        // guarantee as the per-band constant; only ZOOM-interpolated sizes
        // drift against icon-text-fit)
        'text-size': ['*', BADGE_EM[b] ?? 10, ['coalesce', ['get', 'sc'], 1]],
        'text-offset': ['get', 'off'],
        'icon-image': ['concat', 'badge-', ['coalesce', ['get', 'color'], KMK]],
        'icon-text-fit': 'both',
        // top/bottom padding is deliberately uneven: the text box MapLibre fits
        // the icon around includes descender space digits never use (~0.12 em),
        // so a symmetric padding leaves the number hugging the TOP edge of the
        // box — measured on canvas pixels and split back evenly.
        'icon-text-fit-padding': [2.1, 3.5, 0.9, 3.5],
        // a grid must stay complete — a collision-hidden middle badge would read
        // as a data bug, so badges win overlap unconditionally (the pipeline is
        // what keeps separate grids from landing on top of each other)
        'text-allow-overlap': true,
        'icon-allow-overlap': true,
      },
      paint: { 'text-color': ['coalesce', ['get', 'colorDark'], KMK_DARK] },
    });
    return id;
  });
  // Terminus names from z13 up: pipeline-emitted rows riding right above each
  // badge complex, drawn unconditionally like the boxes themselves — so a
  // loop can NEVER be nameless, even at the most saturated nodes where the
  // collision-based layer (kept for z<13) always lost.
  const BADGE_NAME_LAYERS = BADGE_BANDS.map(([z0, z1], b) => {
    const id = 'stops-terminus-names-grid-' + b;
    map.addLayer({
      id, type: 'symbol', source: 'badges',
      minzoom: z0, maxzoom: z1,
      filter: ['all', bandC(b), ['has', 'name']],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [NARROW_BOLD],
        'text-size': ['*', NAME_EM[b] ?? 12.5, ['coalesce', ['get', 'sc'], 1]],
        'text-anchor': 'bottom',
        'text-offset': ['get', 'off'],
        // pinned so the wrap matches the pipeline's row-height estimate
        'text-max-width': 10,
        'text-line-height': 1.1,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#000000', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
    return id;
  });
  // Collision-priority ladder — symbol placement runs the TOP layer first, so
  // the stacking below IS the priority order. Top → bottom:
  //   metro station names   — never dropped
  //   terminus badge grids  — placed unconditionally anyway
  //   arterial-name clone   — the 11.5–13 band, see below
  //   terminus names        — the bold anchors of the network
  //   stop names            — MANDATORY: a stop must never lose its name to a
  //                           line number (numbers repeat along the street and
  //                           reappear a block further; a stop name cannot)
  //   line numbers          — the once-per-street anchors
  //   network street names  — the names of the roadways the lines ride on:
  //                           worth more than the THIRD copy of the same number
  //                           row, worth less than its first
  //   number repeats        — the fallback anchors, filling what is left
  //   arterial street names — the base tiles' own names
  //   minor street names
  //   stop dots, then the rest of the base style
  if (map.getLayer('highway-name-minor')) map.moveLayer('highway-name-minor');
  if (map.getLayer('highway-name-major')) map.moveLayer('highway-name-major');
  map.moveLayer('street-numbers-extra');
  map.moveLayer('street-numbers-extra-flip');
  map.moveLayer('transit-street-names');
  for (const d of NUM_LAYERS) if (d.id !== 'street-numbers-extra') for (const v of SIDE_VARIANTS) map.moveLayer(d.id + v.suf);
  map.moveLayer('stops-names');
  map.moveLayer('stops-terminus-names');
  for (const v of SIDE_VARIANTS) map.moveLayer('big-number-rows' + v.suf); // trunk rows above even the names
  // Below z13 arterial names need to outrank even the numbers — the
  // wall-to-wall low-zoom number labels otherwise leave the city unnamed
  // (measured at z12.5: 36 arterial names in the tiles, 4 rendered). A CLONE
  // of the arterial layer covers the 11.5–13 band up here; from z13 the
  // original (below the numbers) takes over.
  const majorDef = style.layers.find((l) => l.id === 'highway-name-major');
  if (majorDef) map.addLayer({ ...majorDef, id: 'highway-name-major-low', minzoom: 11.5, maxzoom: 13 });
  // …and the network's own street names need the same lift below z13, for the
  // same reason: down there the numbers cover the whole region wall to wall.
  map.addLayer(streetNamesDef('transit-street-names-low', { minzoom: 10.5, maxzoom: 13 }));
  for (const id of [...BADGE_LAYERS, ...BADGE_NAME_LAYERS]) map.moveLayer(id);
  map.moveLayer('stops-metro-names');

  // ---- label size (two independent A− / A+ rows) ----
  // Every symbol layer's authored text size is captured once, base style
  // included — but the layers fall into TWO groups scaled by their own factor
  // (user request): 't' = the transit content (line numbers, stop names,
  // terminus badges), 's' = the street and place names, ours and the base
  // map's. Bigger text also means fewer labels survive the collisions and
  // smaller text means more of them fit — exactly the trade-off the buttons
  // hand to the reader, now separately for each world. The PNG export clones
  // the live style, so a sheet inherits both chosen sizes.
  const TEXT_BASE = map.getStyle().layers
    .filter((l) => l.type === 'symbol')
    .map((l) => ({
      id: l.id,
      grp: /^(street-numbers|big-number-rows|stops-)/.test(l.id) ? 't' : 's',
      // an omitted text-size means MapLibre's default of 16 — scale that too
      size: (l.layout && l.layout['text-size']) ?? 16,
      halo: l.paint ? l.paint['text-halo-width'] : undefined,
    }));
  // 25 % … 190 %, in roughly even steps and finer around 1. The bottom end is
  // there for the posters: on a 16 000 px sheet a quarter-size label is still
  // sharp when you zoom into the file, and at that size the whole network fits
  // its numbers and names in.
  const LABEL_SCALES = [0.25, 0.35, 0.45, 0.6, 0.75, 0.85, 1, 1.15, 1.35, 1.6, 1.9];
  const labelScale = { t: 1, s: 1 };
  const SCALE_UI = {
    t: { smaller: 'label-smaller', bigger: 'label-bigger', val: 'label-size-val' },
    s: { smaller: 'street-smaller', bigger: 'street-bigger', val: 'street-size-val' },
  };
  function applyLabelScale() {
    for (const t of TEXT_BASE) {
      if (!map.getLayer(t.id)) continue;
      const f = labelScale[t.grp];
      // Halos shrink proportionally but grow only with the square root: a 1.9×
      // outline drawn linearly turns dense text into white blobs, while a halo
      // kept near full width around quarter-size glyphs swallows them.
      const h = f < 1 ? f : Math.sqrt(f);
      map.setLayoutProperty(t.id, 'text-size', scaleOut(t.size, f));
      if (t.halo !== undefined) map.setPaintProperty(t.id, 'text-halo-width', scaleOut(t.halo, h));
    }
    for (const g of Object.keys(SCALE_UI)) {
      const ui = SCALE_UI[g];
      const out = document.getElementById(ui.val);
      if (out) out.textContent = Math.round(labelScale[g] * 100) + '%';
      const i = LABEL_SCALES.indexOf(labelScale[g]);
      for (const [id, dir] of [[ui.smaller, -1], [ui.bigger, 1]]) {
        const b = document.getElementById(id);
        if (b) b.disabled = (i + dir < 0 || i + dir >= LABEL_SCALES.length);
      }
    }
  }
  const stepLabelScale = (g, dir) => {
    const i = LABEL_SCALES.indexOf(labelScale[g]);
    labelScale[g] = LABEL_SCALES[Math.min(LABEL_SCALES.length - 1, Math.max(0, i + dir))];
    applyLabelScale();
  };
  for (const g of Object.keys(SCALE_UI)) {
    for (const [id, dir] of [[SCALE_UI[g].smaller, -1], [SCALE_UI[g].bigger, 1]]) {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => stepLabelScale(g, dir));
    }
  }
  // test hook: one factor sets both groups; pass a second argument for one group
  window.__labelScale = (f, g) => { if (g) labelScale[g] = f; else { labelScale.t = f; labelScale.s = f; } applyLabelScale(); };
  applyLabelScale();

  // ---- route stroke width (the − / + row; user request 21.08.2026) ----
  // Captured generically: every line layer drawn from OUR geojson sources
  // that exists at this point — routes, casings, dashes, ribbons, ferry
  // diagrams — but not the journey overlay (added later) and not the base
  // map's vector roads. The PNG exports clone the live widths.
  const WIDTH_BASE = map.getStyle().layers
    .filter((l) => l.type === 'line' && l.source && !/^journey/.test(l.id)
      && map.getSource(l.source) && map.getSource(l.source).type === 'geojson')
    .map((l) => ({ id: l.id, w: map.getPaintProperty(l.id, 'line-width') }));
  const WIDTH_SCALES = [0.6, 0.8, 1, 1.25, 1.6, 2];
  let lineScale = 1;
  // in the lines view the SLOT PITCH scales with the strokes — fatter strands
  // on the original pitch would swallow the hairline that keeps neighbours apart
  const slotOffset = () => scaleOut(SLOT_OFFSET, lineScale);
  function applyLineWidth() {
    for (const b of WIDTH_BASE) if (map.getLayer(b.id)) map.setPaintProperty(b.id, 'line-width', scaleOut(b.w, lineScale));
    for (const id of ['strand-casing', 'strand-line'])
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-offset', state.selected ? 0 : slotOffset());
    const out = document.getElementById('width-val');
    if (out) out.textContent = Math.round(lineScale * 100) + '%';
    const i = WIDTH_SCALES.indexOf(lineScale);
    for (const [id, dir] of [['width-smaller', -1], ['width-bigger', 1]]) {
      const b = document.getElementById(id);
      if (b) b.disabled = (i + dir < 0 || i + dir >= WIDTH_SCALES.length);
    }
  }
  for (const [id, dir] of [['width-smaller', -1], ['width-bigger', 1]]) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => {
      const i = WIDTH_SCALES.indexOf(lineScale);
      lineScale = WIDTH_SCALES[Math.min(WIDTH_SCALES.length - 1, Math.max(0, i + dir))];
      applyLineWidth();
    });
  }
  // test hook
  window.__lineScale = (f) => { lineScale = f; applyLineWidth(); };
  applyLineWidth();


  // Mode filters (bus/tram) + line selection: clicking a chip shows only that
  // line's route with all of its stops (properties.arr carry the line lists).
  let densityCond = true; // repeat-thinning condition, set by the Number density row below
  let densityMainCond = true; // sparsest step: one main row per same-content corridor chain
  const busOnlyNumbers = ['case', ['has', 'busLines'],
    ['format', ['get', 'busLines'], { 'text-color': KMK }],
    ['format', ['get', 'lines'], {}]];
  const tramOnlyNumbers = ['format', ['get', 'lines'], {}];
  function applyFilters() {
    const modes = [state.bus ? 'bus' : null, state.tram ? 'tram' : null].filter(Boolean);
    const modeC = ['in', ['get', 'mode'], ['literal', modes]];
    // an active journey hides the WHOLE regular network (user request: the
    // line's return run and the rest of its route were noise) — the ride is
    // drawn complete by the journey overlay: legs, via stops, numbers
    const selC = state.journey ? false
      : state.selected ? ['in', state.selected, ['get', 'arr']] : true;
    map.setFilter('route-casing', ['all', modeC, selC]);
    map.setFilter('route-line', ['all', modeC, selC]);
    map.setFilter('route-trolley-dash', ['all', ['==', ['get', 'trolley'], 'mix'], modeC, selC]);
    map.setFilter('stops-dots', ['all', modeC, selC]);
    // with a line selected, names of ALL its stops (no label clustering)
    const lblC = state.selected || state.journey ? true : ['==', ['get', 'label'], 1];
    map.setFilter('stops-names', ['all', ['!=', ['get', 'terminus'], 1], ['!=', ['get', 'metro'], 1], modeC, selC, lblC]);
    map.setFilter('stops-terminus-names', ['all', ['==', ['get', 'terminus'], 1], ['!=', ['get', 'metro'], 1], modeC, selC, lblC]);
    map.setFilter('stops-metro-names', ['all', ['==', ['get', 'metro'], 1], modeC, selC, lblC]);
    // with a line selected only ITS badge stays at the loop
    BADGE_LAYERS.forEach((id, b) => {
      map.setFilter(id, ['all', bandC(b), ['has', 'line'], modeC,
        state.journey ? false
          : state.selected ? ['==', ['get', 'line'], state.selected] : true]);
    });
    // complex name rows follow: shown while any of the complex's modes is on
    // ('in' does substring search on the "bus,tram" string), and with a line
    // selected only complexes where that line terminates keep their name
    const nameModeC = ['any',
      state.bus ? ['in', 'bus', ['get', 'modes']] : false,
      state.tram ? ['in', 'tram', ['get', 'modes']] : false];
    BADGE_NAME_LAYERS.forEach((id, b) => {
      map.setFilter(id, ['all', bandC(b), ['has', 'name'], nameModeC,
        state.journey ? false
          : state.selected ? ['in', state.selected, ['get', 'arr']] : true]);
    });
    let numC, numField;
    if (state.bus && !state.tram) {
      // trams hidden: shared corridor labels (mode=tram with busLines) must stay,
      // but they show only the bus part
      numC = ['all', ['any', ['==', ['get', 'mode'], 'bus'], ['has', 'busLines']], selC];
      numField = busOnlyNumbers;
    } else {
      numC = ['all', modeC, selC];
      numField = state.tram && !state.bus ? tramOnlyNumbers : numberField;
    }
    for (const d of NUM_LAYERS) {
      const thinC = d.id === 'street-numbers-extra' ? densityCond : densityMainCond;
      for (const v of SIDE_VARIANTS) {
        map.setFilter(d.id + v.suf, ['all', d.cond, v.cond, numC, thinC]);
        map.setLayoutProperty(d.id + v.suf, 'text-field', numField);
      }
    }
    // trunk rows follow the same mode/selection state as the other number layers
    for (const v of SIDE_VARIANTS) {
      map.setFilter('big-number-rows' + v.suf, ['all', ['!', ['has', 'extra']], ['>', ['length', ['get', 'lines']], 40], v.cond, numC, densityMainCond]);
      map.setLayoutProperty('big-number-rows' + v.suf, 'text-field', numField);
    }
    if (linesOK) {
      // A picked line keeps only its own strands, and they step back onto the
      // roadway centre: a slot is only meaningful inside a bundle being drawn.
      const strandSel = state.journey ? false
        : state.selected ? ['==', ['get', 'line'], state.selected] : true;
      map.setFilter('strand-casing', ['all', ['!=', ['get', 'sw'], 1], modeC, strandSel]);
      map.setFilter('strand-line', ['all', modeC, strandSel]);
      for (const id of ['strand-casing', 'strand-line'])
        map.setPaintProperty(id, 'line-offset', state.selected ? 0 : slotOffset());
      // The trunks are grey for the whole network, but a picked line is
      // repainted in its own colour exactly where it rides through them — so the
      // line reads end to end and the grey never swallows it.
      map.setFilter('corridor-casing', ['all', modeC, selC]);
      map.setFilter('corridor-line', ['all', modeC, selC]);
      map.setPaintProperty('corridor-line', 'line-color', state.selected ? lineColor(state.selected) : CORRIDOR_INK);
      map.setPaintProperty('corridor-line', 'line-width', state.selected ? STRAND_W : CORRIDOR_W);
    }
  }
  // ---- VIEW SWITCH ----
  // Everything either view needs is already in the style; switching is paint and
  // visibility, never a reload — so the position, the zoom, the picked line and
  // the label-size settings all survive it.
  const CORRIDOR_ONLY = ['route-casing', 'route-line', 'route-trolley-dash', 'route-mline-dash'];
  const LINES_ONLY = ['corridor-casing', 'corridor-line', 'strand-casing', 'strand-line'];
  // the stop discs as this map paints them in the corridor view — restored
  // verbatim when the reader comes back from the lines view
  const STOPS_ICON_CORRIDORS = map.getLayoutProperty('stops-dots', 'icon-image');
  const STOPS_ICON_LINES = ['concat',
    ['case', ['any', ['==', ['get', 'metro'], 1], ['==', ['get', 'terminus'], 1]], 'dot-', 'stop-'],
    STOP_INK,
    ['case', ['==', ['get', 'terminus'], 1], '-t', '']];
  function applyView() {
    const linesView = state.view === 'lines' && linesOK;
    if (linesView) loadLines();
    for (const id of CORRIDOR_ONLY) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', linesView ? 'none' : 'visible');
    for (const id of LINES_ONLY) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', linesView ? 'visible' : 'none');
    // the base: paper-cream districts and blue water, or flat grey. The view
    // only supplies the DEFAULT — a click on the base switch decouples them,
    // and the choice then holds in both views.
    const greyBase = state.bg === 'auto' ? linesView : state.bg === 'grey';
    for (const b of BASE_PAINT) {
      if (!map.getLayer(b.id)) continue;
      map.setPaintProperty(b.id, b.prop, greyBase ? b.grey : b.paper);
    }
    // our own street names sit on top of the strokes in both views
    for (const id of ['transit-street-names', 'transit-street-names-low'])
      if (map.getLayer(id)) map.setPaintProperty(id, 'text-color', greyBase ? '#3c3c3c' : '#2b2924');
    for (const b of document.querySelectorAll('#base-switch button'))
      b.classList.toggle('on', (b.dataset.bg === 'grey') === greyBase);
    // A stop belongs to every line passing it, so on a map where colour means
    // "which line" it has to go neutral; in the corridor view it keeps the mode
    // colour it has always had.
    map.setLayoutProperty('stops-dots', 'icon-image', linesView ? STOPS_ICON_LINES : STOPS_ICON_CORRIDORS);
    for (const id of BADGE_LAYERS) {
      map.setLayoutProperty(id, 'icon-image', ['concat', 'badge-', linesView ? LINE_COLOR_MATCH : ['coalesce', ['get', 'color'], KMK]]);
      map.setPaintProperty(id, 'text-color', linesView ? '#1e2126' : ['coalesce', ['get', 'colorDark'], KMK_DARK]);
    }
    // the rows come from a different file in each view — same layers, same
    // collision ladder, same density control
    map.getSource('labels').setData(linesView ? 'data/lines-rows.geojson' : 'data/labels.geojson');
    paintChips(linesView);
    document.body.classList.toggle('lines-view', linesView);
    for (const b of document.querySelectorAll('#view-switch button'))
      b.classList.toggle('on', (b.dataset.view === 'lines') === linesView);
    applyFilters();
  }
  const sw = document.getElementById('view-switch');
  if (sw) {
    if (!linesOK) sw.hidden = true;
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.view === state.view) return;
      state.view = b.dataset.view;
      applyView();
    });
  }
  const bsw = document.getElementById('base-switch');
  if (bsw) bsw.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.bg === state.bg) return;
    state.bg = b.dataset.bg;
    applyView();
  });
  applyView();

  document.getElementById('chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.selected = state.selected === b.dataset.line ? null : b.dataset.line;
    document.querySelectorAll('#chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.line === state.selected));
    applyFilters();
  });
  for (const [id, key] of [['toggle-bus', 'bus'], ['toggle-tram', 'tram']]) {
    document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.checked; applyFilters(); });
  }
  applyFilters();

  // ---- number density (the − / + row) ----
  // Every repeat along a street carries an ordinal (ei) from the pipeline, so
  // density is DETERMINISTIC thinning: 100 % keeps every repeat, the sparse
  // steps keep every 2nd/3rd/…, the sparsest drops the repeats entirely (the
  // main row per street always stays), and the dense end lets the repeats in
  // from z11 instead of z13. No collision-padding tricks: with variable
  // anchors MapLibre folds the padding into the anchor shift and the rows
  // drifted off their streets (user report, Praska).
  const DENSITY_STEPS = [0.25, 0.35, 0.45, 0.6, 0.75, 0.85, 1, 1.35];
  const DENSITY_MOD = { 0.25: 0, 0.35: 0, 0.45: 6, 0.6: 4, 0.75: 3, 0.85: 2 }; // 1+: all repeats
  let labelDensity = 1;
  function applyLabelDensity() {
    const m = DENSITY_MOD[labelDensity];
    densityCond = m === 0 ? false : (m ? ['==', ['%', ['coalesce', ['get', 'ei'], 0], m], 0] : true);
    // 25 %: beyond dropping the repeats, identical rows chained along one
    // corridor collapse to their single mi-free representative
    densityMainCond = labelDensity <= 0.25 ? ['!', ['has', 'mi']] : true;
    for (const id of ['street-numbers-extra', 'street-numbers-extra-flip'])
      if (map.getLayer(id)) map.setLayerZoomRange(id, labelDensity >= 1.35 ? 11 : 13, 24);
    applyFilters();
    const out = document.getElementById('density-val');
    if (out) out.textContent = Math.round(labelDensity * 100) + '%';
    for (const [id, dir] of [['density-smaller', -1], ['density-bigger', 1]]) {
      const b = document.getElementById(id);
      const i = DENSITY_STEPS.indexOf(labelDensity);
      if (b) b.disabled = (i + dir < 0 || i + dir >= DENSITY_STEPS.length);
    }
  }
  for (const [id, dir] of [['density-smaller', -1], ['density-bigger', 1]]) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => {
      const i = DENSITY_STEPS.indexOf(labelDensity);
      labelDensity = DENSITY_STEPS[Math.min(DENSITY_STEPS.length - 1, Math.max(0, i + dir))];
      applyLabelDensity();
    });
  }
  window.__labelDensity = (d) => { labelDensity = d; applyLabelDensity(); }; // test hook
  applyLabelDensity();

  // POSTER-mode PNG export (the look of the official printed KMK city map),
  // three entry points sharing one engine: the CURRENT VIEW, a hand-drawn
  // RECTANGLE, or the WHOLE NETWORK. The requested bbox is rendered in TILES
  // on a hidden map instance and stitched into one image whose long edge
  // targets MAX_OUT pixels — the GPU texture limit constrains a single tile
  // only, not the whole. The zoom is chosen so the bbox exactly fills that
  // budget (DETAIL first: a wider area simply renders at a bigger absolute
  // size instead of losing labels); once the zoom would pass Z_CAP — where the
  // style stops adding content — the leftover budget turns into text pixel
  // density (ratio up to 2, sharp when zooming the file). The PAD overlap
  // reconciles labels at tile seams. map.getStyle() carries the FULL user
  // state: bus/tram filters, selected line, QA overlay.
  const btnView = document.getElementById('export-png');
  const btnArea = document.getElementById('export-area');
  const btnAtlas = document.getElementById('export-atlas');
  const exportBusy = (on) => [btnView, btnArea, btnAtlas].forEach((b) => { b.disabled = on; });
  // Area-poster styling: every label (street/stop names, numbers, badges),
  // the stop discs and the transit strokes grow by f while the base street
  // grid keeps its scale — the KMK look, where the typography dominates the
  // geometry. All em-based offsets (badge grids, radial offsets) follow the
  // font size automatically.
  const boostStyle = (st, f) => {
    st = JSON.parse(JSON.stringify(st));
    for (const l of st.layers) {
      if (l.type === 'symbol') {
        if (l.layout && l.layout['text-size']) l.layout['text-size'] = scaleOut(l.layout['text-size'], f);
        if (l.layout && l.layout['icon-size']) l.layout['icon-size'] = scaleOut(l.layout['icon-size'], f);
        if (l.paint && l.paint['text-halo-width']) l.paint['text-halo-width'] = scaleOut(l.paint['text-halo-width'], f);
      }
      if (/^route-/.test(l.id) && l.paint && l.paint['line-width']) {
        l.paint['line-width'] = scaleOut(l.paint['line-width'], f);
      }
    }
    // Poster passes only (boostStyle never runs on the WYSIWYG current-view
    // export): arterial street names move ABOVE the transit numbers. On the
    // whole-map sheet (~z13.9) the wall-to-wall number labels otherwise win
    // every collision and the poster ships without a single street name. Stop
    // names, terminus names and the badge grids still outrank them — only the
    // endlessly repeating numbers yield.
    for (const id of ['highway-name-major', 'transit-street-names']) {
      const mi = st.layers.findIndex((l) => l.id === id);
      if (mi < 0) continue;
      const [lyr] = st.layers.splice(mi, 1);
      let last = -1;
      st.layers.forEach((l, i) => { if (/^street-numbers/.test(l.id)) last = i; });
      st.layers.splice(last >= 0 ? last + 1 : st.layers.length, 0, lyr);
    }
    // Poster coexistence (user rule: the numbers AND the stop names must BOTH
    // be on the sheet): trunk rows place first, so the names need room to
    // dodge the rows' rotated envelopes — same 8 anchors, wider radius — and
    // the rows themselves float farther off the axis, freeing the poles.
    for (const l of st.layers) {
      if (l.id === 'stops-names') l.layout = { ...l.layout, 'text-radial-offset': 2.0 };
      if (/^big-number-rows/.test(l.id)) l.layout = { ...l.layout, 'text-radial-offset': 1.2 };
    }
    return st;
  };
  async function exportBBox(bbox, btn, doneLabel, opts) {
    if (!(opts && opts.noBusy)) exportBusy(true);
    const setLbl = (t) => { btn.textContent = t; };
    const PAD = 200;          // CSS px of tile overlap
    const MAX_OUT = window.__exportMaxOut || 16384; // px of the long edge (2D canvas limit)
    // web-mercator fractions of the world covered by the bbox
    const mx = (lng) => (lng + 180) / 360;
    const my = (lat) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    const fx = mx(bbox[2]) - mx(bbox[0]);
    const fy = my(bbox[1]) - my(bbox[3]); // mercator y grows southward
    // the zoom at which the long edge lands exactly on MAX_OUT css px
    const zFit = Math.log2(MAX_OUT / (512 * Math.max(fx, fy)));
    let Z;
    if (opts && opts.forceZ) {
      // atlas sheets: every sheet must share ONE zoom/density pair, or the
      // sheets would not line up when joined — the caller computes it once
      Z = opts.forceZ;
    } else if (opts && opts.wysiwyg) {
      // WYSIWYG mode (current view): render at the SCREEN's own zoom — the
      // sheet shows exactly what the user sees, same framing, same
      // stroke-to-label proportions — and the whole budget goes into pixel
      // density (up to 4×), so opened at 100% everything is BIGGER than on
      // screen, never smaller. (The earlier detail-first boost made routes
      // and labels come out tiny relative to the sheet — user report.)
      Z = Math.min(map.getZoom(), 17.3);
    } else {
      // poster mode (whole map, selected area): the bbox fills MAX_OUT at
      // whatever zoom that lands on (~z13.9 for the full network), capped at
      // z15.3 — past that the geometry inflates faster than the text; the
      // leftover budget becomes pixel density
      Z = Math.min(zFit, Math.max(15.3, Math.min(map.getZoom(), 17.3)));
    }
    const RATIO = (opts && opts.forceRatio) || Math.min(4, Math.max(1, 2 ** (zFit - Z)));
    // big tile = fewer passes, but the tile canvas (contCSS × RATIO device px)
    // must fit the GPU limit — 4096 is the universal floor (this machine's
    // too: measured), so size the tile to keep the request inside it and the
    // ratio real. Actual density is still measured after creation.
    const contCSS = Math.max(1024, Math.floor(4096 / RATIO));
    const tileCSS = contCSS - 2 * PAD;
    // mercator in world pixels at zoom Z (base style tile = 512 px)
    const world = 512 * 2 ** Z;
    const W = Math.round(fx * world), H = Math.round(fy * world); // CSS px of the whole
    const cols = Math.ceil(W / tileCSS), rows = Math.ceil(H / tileCSS);
    const tlx = mx(bbox[0]) * world, tly = my(bbox[3]) * world;
    const px2ll = (x, y) => {
      const n = Math.PI - (2 * Math.PI * y) / world;
      return [(x / world) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
    };
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;left:-100000px;top:0;width:${contCSS}px;height:${contCSS}px;`;
    document.body.appendChild(div);
    let m2 = null;
    try {
      m2 = new maplibregl.Map({
        container: div,
        style: opts && opts.boost ? boostStyle(map.getStyle(), opts.boost) : map.getStyle(),
        center: px2ll(tlx + W / 2, tly + H / 2), zoom: Z,
        pixelRatio: RATIO, preserveDrawingBuffer: true, antialias: true,
        attributionControl: false, interactive: false, fadeDuration: 0,
      });
      // canvas-drawn stop icons are not part of the style — re-register them
      addStopIcons(m2);
      const idle = () => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('tile render timeout')), 45000);
        m2.once('idle', () => { clearTimeout(t); res(); });
      });
      await idle(); // full style load
      // ACTUAL tile pixel density: the GPU can silently clamp the canvas below
      // contCSS×RATIO — stitching geometry uses the MEASURED value, otherwise the
      // crops land in wrong places (reported as "cut-off squares" with blank space).
      const SR = m2.getCanvas().width / contCSS;
      const out = document.createElement('canvas');
      out.width = Math.round(W * SR);
      out.height = Math.round(H * SR);
      const ctx = out.getContext('2d');
      let k = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          setLbl(`${opts && opts.tag ? opts.tag + ' ' : ''}Rendering ${++k}/${rows * cols}…`);
          const x0 = i * tileCSS, y0 = j * tileCSS;
          const w = Math.min(tileCSS, W - x0), h = Math.min(tileCSS, H - y0);
          m2.jumpTo({ center: px2ll(tlx + x0 + w / 2, tly + y0 + h / 2), zoom: Z });
          m2.triggerRepaint(); // a jumpTo to the same spot would not emit idle
          await idle();
          ctx.drawImage(m2.getCanvas(),
            ((contCSS - w) / 2) * SR, ((contCSS - h) / 2) * SR, w * SR, h * SR,
            x0 * SR, y0 * SR, w * SR, h * SR);
        }
      }
      setLbl('Saving…');
      // attribution baked into the image (the DOM bar is not part of the canvas);
      // atlas sheets skip it except the last one, or a join would repeat it 16×
      if (!(opts && opts.attrib === false)) {
        const fs = Math.max(16, Math.round(out.width / 130));
        ctx.font = `${fs}px sans-serif`;
        ctx.textBaseline = 'bottom';
        const txt = '© OpenStreetMap contributors · OpenFreeMap · GTFS: ZTP Kraków · MLD (Koleje Małopolskie) · WST Wieliczka';
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.fillRect(out.width - tw - fs, out.height - fs * 1.7, tw + fs, fs * 1.7);
        ctx.fillStyle = '#333333';
        ctx.fillText(txt, out.width - tw - fs / 2, out.height - fs * 0.4);
      }
      const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('toBlob returned null (out of memory?)');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.download = (opts && opts.filename)
        || `krakow-transit_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${out.width}x${out.height}.png`;
      a.href = URL.createObjectURL(blob);
      if (!window.__exportNoSave) a.click(); // test hook: render without downloading
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      // QA trace: thumbnail of the whole + 1:1 center crop (tile stitching check)
      const mk = (w2, h2, draw) => {
        const c = document.createElement('canvas');
        c.width = w2; c.height = h2;
        draw(c.getContext('2d'));
        return c.toDataURL('image/png');
      };
      const th = Math.round(400 * out.height / out.width);
      window.__lastExport = {
        width: out.width, height: out.height, tiles: rows * cols, sr: Math.round(SR * 100) / 100, bytes: blob.size,
        z: Math.round(Z * 100) / 100, ratio: Math.round(RATIO * 100) / 100,
        thumb: mk(400, th, (c2) => c2.drawImage(out, 0, 0, 400, th)),
        crop: mk(400, 400, (c2) => c2.drawImage(out, (out.width - 400) / 2, (out.height - 400) / 2, 400, 400, 0, 0, 400, 400)),
      };
    } catch (e) {
      console.error('Export failed', e);
      setLbl('Export failed — see console');
      await new Promise((res) => setTimeout(res, 2500));
    }
    if (m2) try { m2.remove(); } catch (e) { /* the canvas may be gone already */ }
    div.remove();
    if (!(opts && opts.noBusy)) exportBusy(false);
    setLbl(doneLabel);
  }

  // Rectangle selection for "select area": crosshair + rubber band; the map
  // holds still while dragging. Esc — or a sub-8 px drag — cancels.
  function selectArea() {
    return new Promise((resolve) => {
      const cont = map.getContainer();
      const box = document.getElementById('area-box');
      const hint = document.getElementById('area-hint');
      hint.style.display = 'block';
      cont.style.cursor = 'crosshair';
      map.dragPan.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable();
      let p0 = null;
      const pt = (e) => {
        const r = cont.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      const move = (e) => {
        if (!p0) return;
        const p = pt(e);
        Object.assign(box.style, {
          display: 'block',
          left: Math.min(p0[0], p[0]) + 'px', top: Math.min(p0[1], p[1]) + 'px',
          width: Math.abs(p[0] - p0[0]) + 'px', height: Math.abs(p[1] - p0[1]) + 'px',
        });
      };
      const finish = (result) => {
        cont.removeEventListener('mousedown', down);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        window.removeEventListener('keydown', key);
        box.style.display = 'none';
        hint.style.display = 'none';
        cont.style.cursor = '';
        map.dragPan.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable();
        resolve(result);
      };
      const down = (e) => { p0 = pt(e); e.preventDefault(); };
      const up = (e) => {
        if (!p0) return;
        const p = pt(e);
        if (Math.abs(p[0] - p0[0]) < 8 || Math.abs(p[1] - p0[1]) < 8) return finish(null);
        const a = map.unproject(p0), b = map.unproject(p);
        finish([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]);
      };
      const key = (e) => { if (e.key === 'Escape') finish(null); };
      cont.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      window.addEventListener('keydown', key);
    });
  }

  btnView.addEventListener('click', () => {
    if (btnView.disabled) return;
    const b = map.getBounds();
    exportBBox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], btnView,
      'Export PNG — current view', { wysiwyg: true });
  });
  btnArea.addEventListener('click', async () => {
    if (btnArea.disabled) return;
    const bbox = await selectArea();
    if (bbox) exportBBox(bbox, btnArea, 'Export PNG — select area', { boost: 1.4 });
  });
  // GIANT export: the whole network at ~65 000 px on the long edge in ONE
  // PNG, assembled IN the browser before the download (user rule: no
  // stitching on the computer). No canvas can hold 65k×48k (area caps out
  // around 16k×16k), so the tiles are streamed straight into a PNG encoder:
  // pixel rows are assembled band by band from the rendered tiles and
  // deflated on the fly — CompressionStream('deflate') emits exactly the
  // zlib stream IDAT wants. Raw pixels never exist in one piece; only the
  // compressed file does.
  btnAtlas.addEventListener('click', async () => {
    if (btnAtlas.disabled) return;
    const IDLE_LABEL = btnAtlas.textContent;
    const setLbl = (t) => { btnAtlas.textContent = t; };
    if (typeof CompressionStream === 'undefined') {
      setLbl('No CompressionStream in this browser');
      setTimeout(() => setLbl(IDLE_LABEL), 3000);
      return;
    }
    const TOTAL = window.__atlasTotal || 65000;
    const [w0, s0, e0, n0] = meta.bbox;
    const ddx = (e0 - w0) * 0.015, ddy = (n0 - s0) * 0.015;
    const bbox = [w0 - ddx, s0 - ddy, e0 + ddx, n0 + ddy];
    const mxf = (lng) => (lng + 180) / 360;
    const myf = (lat) => {
      const si = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + si) / (1 - si)) / (4 * Math.PI);
    };
    const fx = mxf(bbox[2]) - mxf(bbox[0]), fy = myf(bbox[1]) - myf(bbox[3]);
    // the zoom that lands the FULL long edge on TOTAL px (~z15.8 vs the
    // single sheet's ~z13.9) — that head-room is exactly where the extra
    // line numbers and stop names come from
    const zFitT = Math.log2(TOTAL / (512 * Math.max(fx, fy)));
    const Z = Math.min(zFitT, 16);
    const RATIO = Math.min(4, Math.max(1, 2 ** (zFitT - Z)));
    const PAD = 200;
    const contCSS = Math.max(1024, Math.floor(4096 / RATIO));
    const tileCSS = contCSS - 2 * PAD;
    const world = 512 * 2 ** Z;
    const W = Math.round(fx * world), H = Math.round(fy * world);
    const cols = Math.ceil(W / tileCSS), rows = Math.ceil(H / tileCSS);
    const tlx = mxf(bbox[0]) * world, tly = myf(bbox[3]) * world;
    const px2ll = (x, y) => {
      const p = Math.PI - (2 * Math.PI * y) / world;
      return [(x / world) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(p) - Math.exp(-p)))];
    };
    // -- minimal PNG plumbing (RGBA8, filter 0 per row) --
    const CRC_T = new Uint32Array(256);
    for (let n2 = 0; n2 < 256; n2++) {
      let c = n2;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n2] = c >>> 0;
    }
    const crcUpd = (c, buf) => {
      for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
      return c >>> 0;
    };
    const be32 = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
    const pushChunk = (type, data) => {
      const t = Uint8Array.from(type, (ch) => ch.charCodeAt(0));
      const crc = (crcUpd(crcUpd(0xffffffff, t), data) ^ 0xffffffff) >>> 0;
      parts.push(be32(data.length), t, data, be32(crc));
    };
    exportBusy(true);
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;left:-100000px;top:0;width:${contCSS}px;height:${contCSS}px;`;
    document.body.appendChild(div);
    let m2 = null;
    try {
      m2 = new maplibregl.Map({
        container: div,
        // 1.4 (not the old sheet's 1.25): at this zoom there is room to spare,
        // and the user wanted the base type a notch bigger on the print
        style: boostStyle(map.getStyle(), 1.4),
        center: px2ll(tlx + W / 2, tly + H / 2), zoom: Z,
        pixelRatio: RATIO, preserveDrawingBuffer: true, antialias: true,
        attributionControl: false, interactive: false, fadeDuration: 0,
      });
      addStopIcons(m2);
      const idle = () => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('tile render timeout')), 45000);
        m2.once('idle', () => { clearTimeout(t); res(); });
      });
      await idle();
      const SR = m2.getCanvas().width / contCSS;
      const px = (cssV) => Math.round(cssV * SR);
      const Wf = px(W), Hf = px(H);
      const ihdr = new Uint8Array(13);
      ihdr.set(be32(Wf), 0);
      ihdr.set(be32(Hf), 4);
      ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, filter 0, no interlace
      pushChunk('IHDR', ihdr);
      let idatBuf = [], idatLen = 0;
      const flushIdat = () => {
        if (!idatLen) return;
        const all = new Uint8Array(idatLen);
        let o = 0;
        for (const b of idatBuf) { all.set(b, o); o += b.length; }
        pushChunk('IDAT', all);
        idatBuf = []; idatLen = 0;
      };
      const idatPush = (u8) => {
        idatBuf.push(u8); idatLen += u8.length;
        if (idatLen >= 1 << 23) flushIdat(); // 8 MB per IDAT chunk
      };
      const cs = new CompressionStream('deflate');
      const wtr = cs.writable.getWriter();
      const pump = (async () => {
        const rdr = cs.readable.getReader();
        for (;;) {
          const { done, value } = await rdr.read();
          if (done) break;
          idatPush(value);
        }
      })();
      // double-buffered row so a buffer is never mutated while the
      // compressor might still hold it
      const rowBufs = [new Uint8Array(1 + Wf * 4), new Uint8Array(1 + Wf * 4)];
      let done = 0;
      for (let j = 0; j < rows; j++) {
        const y0 = j * tileCSS, hcss = Math.min(tileCSS, H - y0);
        const hpx = px(y0 + hcss) - px(y0);
        const band = [];
        for (let i = 0; i < cols; i++) {
          setLbl(`Rendering ${++done}/${rows * cols}…`);
          const x0 = i * tileCSS, wcss = Math.min(tileCSS, W - x0);
          m2.jumpTo({ center: px2ll(tlx + x0 + wcss / 2, tly + y0 + hcss / 2), zoom: Z });
          m2.triggerRepaint();
          await idle();
          const xpx0 = px(x0), wpx = px(x0 + wcss) - xpx0;
          const cc = document.createElement('canvas');
          cc.width = wpx; cc.height = hpx;
          const cx = cc.getContext('2d', { willReadFrequently: true });
          cx.drawImage(m2.getCanvas(),
            ((contCSS - wcss) / 2) * SR, ((contCSS - hcss) / 2) * SR, wcss * SR, hcss * SR,
            0, 0, wpx, hpx);
          if (j === rows - 1 && i === cols - 1) {
            // attribution in the bottom-right corner of the final image
            const fs = Math.max(16, Math.round(Wf / 500));
            cx.font = `${fs}px sans-serif`;
            cx.textBaseline = 'bottom';
            const txt = '© OpenStreetMap contributors · OpenFreeMap · GTFS: ZTP Kraków · MLD (Koleje Małopolskie) · WST Wieliczka';
            const tw = Math.min(cx.measureText(txt).width, wpx - fs);
            cx.fillStyle = 'rgba(255,255,255,0.82)';
            cx.fillRect(wpx - tw - fs, hpx - fs * 1.7, tw + fs, fs * 1.7);
            cx.fillStyle = '#333333';
            cx.fillText(txt, wpx - tw - fs / 2, hpx - fs * 0.4);
          }
          band.push({ data: cx.getImageData(0, 0, wpx, hpx).data, off: 1 + xpx0 * 4, wb: wpx * 4 });
        }
        setLbl(`Encoding band ${j + 1}/${rows}…`);
        for (let y = 0; y < hpx; y++) {
          const row = rowBufs[y & 1];
          row[0] = 0; // filter: None
          for (const t of band) row.set(t.data.subarray(y * t.wb, (y + 1) * t.wb), t.off);
          await wtr.write(row);
        }
      }
      await wtr.close();
      await pump;
      flushIdat();
      pushChunk('IEND', new Uint8Array(0));
      setLbl('Saving…');
      const blob = new Blob(parts, { type: 'image/png' });
      const d = new Date();
      const p2 = (v) => String(v).padStart(2, '0');
      const a = document.createElement('a');
      a.download = `krakow-transit-giant_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${Wf}x${Hf}.png`;
      a.href = URL.createObjectURL(blob);
      if (window.__exportNoSave) {
        window.__lastGiantURL = a.href; // test hook: decode-check without downloading
      } else {
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      }
      window.__lastExport = {
        width: Wf, height: Hf, tiles: rows * cols, sr: Math.round(SR * 100) / 100,
        bytes: blob.size, z: Math.round(Z * 100) / 100, ratio: Math.round(RATIO * 100) / 100, giant: 1,
      };
    } catch (err) {
      console.error('Giant export failed', err);
      setLbl('Export failed — see console');
      await new Promise((res) => setTimeout(res, 2500));
    }
    if (m2) try { m2.remove(); } catch (err2) { /* canvas may be gone */ }
    div.remove();
    exportBusy(false);
    setLbl(IDLE_LABEL);
  });

  // Raw GTFS trace — for matching QA; lazy-loaded on first toggle
  // (a large file with all lines included).
  document.getElementById('toggle-shape').addEventListener('change', (e) => {
    if (e.target.checked && !map.getSource('gtfs-shape')) {
      map.addSource('gtfs-shape', { type: 'geojson', data: 'data/gtfs-shape.geojson' });
      map.addLayer({
        id: 'gtfs-shape-line', type: 'line', source: 'gtfs-shape',
        paint: { 'line-color': '#e6003c', 'line-width': 1.8, 'line-dasharray': [2, 2] },
      });
    } else if (map.getLayer('gtfs-shape-line')) {
      map.setLayoutProperty('gtfs-shape-line', 'visibility', e.target.checked ? 'visible' : 'none');
    }
  });

  map.on('click', 'stops-dots', (e) => {
    const f = e.features[0];
    const p = f.properties;
    const label = p.lines.includes(',') ? 'lines' : 'line';
    new maplibregl.Popup({ closeButton: false, offset: 10 })
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<strong>${esc(p.name)}</strong>${p.terminus ? ' · terminus' : ''}<br>${label}: ${esc(p.lines)}`)
      .addTo(map);
  });
  map.on('mouseenter', 'stops-dots', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'stops-dots', () => (map.getCanvas().style.cursor = ''));

  // ---- Journey planner (beta prototype) ----
  // Topological search on the line network — NO timetables: direct rides and
  // one-transfer routes, ranked by ridden kilometres. The ordered stop
  // sequence of every line is derived here in the browser by PROJECTING the
  // stops the line serves onto its per-direction polyline (route.geojson),
  // so no extra pipeline export is needed. Picking a result shows only the
  // involved lines (existing selection machinery) plus a bold overlay of the
  // exact ridden segments and the boarding/transfer/alighting stops.
  wireJourneyPlanner();
  function wireJourneyPlanner() {
    const fromEl = document.getElementById('j-from'), toEl = document.getElementById('j-to');
    const msgEl = document.getElementById('j-msg'), resEl = document.getElementById('j-results');
    if (!fromEl) return;
    const msg = (t) => { msgEl.textContent = t; };
    let gpsPos = null; // [lon,lat] when the start is the GPS fix
    let net = null, netBuilding = null;

    // equirectangular metres around Kraków — good to ~0.1% at city scale
    const R = 6371000, rad = Math.PI / 180, cosLat = Math.cos(((meta.bbox[1] + meta.bbox[3]) / 2) * rad);
    const mx = (ll) => [ll[0] * rad * R * cosLat, ll[1] * rad * R];

    // nearest point of a polyline (metre space): distance, arc position, segment
    const project = (pm, cum, q) => {
      let best = { dist: Infinity, at: 0, seg: 0, t: 0 };
      for (let i = 1; i < pm.length; i++) {
        const ax = pm[i - 1][0], ay = pm[i - 1][1];
        const dx = pm[i][0] - ax, dy = pm[i][1] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((q[0] - ax) * dx + (q[1] - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx - q[0], py = ay + t * dy - q[1];
        const dist = Math.sqrt(px * px + py * py);
        if (dist < best.dist) best = { dist, at: cum[i - 1] + t * Math.sqrt(len2), seg: i - 1, t };
      }
      return best;
    };

    const buildNet = async () => {
      const [routes, stops] = await Promise.all([
        fetch('data/route.geojson').then((r) => r.json()),
        fetch('data/stops.geojson').then((r) => r.json()),
      ]);
      // stop poles grouped by NAME — a group is one logical stop
      const groups = new Map();
      for (const f of stops.features) {
        const p = f.properties;
        let g = groups.get(p.name);
        if (!g) groups.set(p.name, g = { name: p.name, pts: [], lines: new Set() });
        g.pts.push(f.geometry.coordinates);
        for (const l of p.arr) g.lines.add(l);
      }
      for (const g of groups.values()) {
        g.c = g.pts.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]).map((v) => v / g.pts.length);
        g.cm = mx(g.c);
      }
      // per line×direction: polyline + the served groups ordered along it;
      // groups >65 m off the polyline ride a VARIANT of the line, not this
      // dominant path — excluded, which is exactly right for routing
      const byLine = new Map(), nameSet = new Map();
      for (const f of routes.features) {
        const p = f.properties;
        const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat();
        const pm = coords.map(mx), cum = [0];
        for (let i = 1; i < pm.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(pm[i][0] - pm[i - 1][0], pm[i][1] - pm[i - 1][1]));
        }
        const rec = { line: p.line, mode: p.mode, color: p.color, headsign: p.headsign, coords, pos: new Map() };
        for (const g of groups.values()) {
          if (!g.lines.has(p.line)) continue;
          const pr = project(pm, cum, g.cm);
          if (pr.dist <= 65) rec.pos.set(g.name, pr);
        }
        if (!byLine.has(p.line)) { byLine.set(p.line, []); nameSet.set(p.line, new Set()); }
        byLine.get(p.line).push(rec);
        for (const n of rec.pos.keys()) nameSet.get(p.line).add(n);
      }
      // transfer matrix: line -> line -> shared stop names (for 2-transfer search)
      const adj = new Map();
      for (const [line, names] of nameSet) adj.set(line, new Map());
      for (const g of groups.values()) {
        const ls = [...g.lines].filter((l) => nameSet.has(l) && nameSet.get(l).has(g.name));
        for (const a of ls) for (const b of ls) {
          if (a === b) continue;
          const m = adj.get(a);
          let arr = m.get(b);
          if (!arr) m.set(b, arr = []);
          arr.push(g.name);
        }
      }
      return { groups, byLine, nameSet, adj };
    };
    const ensureNet = async () => {
      if (net) return net;
      if (!netBuilding) netBuilding = buildNet().then((n) => (net = n));
      return netBuilding;
    };

    // floating widget top-centre of the map: a pill that expands into the card
    // (on phones the planner buried in the legend was unusable — user report);
    // the network model and the autocomplete load on first open
    const jpCard = document.getElementById('jp-card'), jpToggle = document.getElementById('jp-toggle');
    const jpOpen = async (open) => {
      jpCard.hidden = !open;
      jpToggle.hidden = open;
      if (open) await ensureNet();
    };
    jpToggle.addEventListener('click', () => jpOpen(true));
    document.getElementById('jp-close').addEventListener('click', () => jpOpen(false));

    const norm = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const resolveName = (q) => {
      const nq = norm(q);
      if (!nq) return null;
      let pref = null, sub = null;
      for (const name of net.groups.keys()) {
        const nn = norm(name);
        if (nn === nq) return name;
        if (nn.startsWith(nq) && (!pref || name.length < pref.length)) pref = name;
        if (nn.includes(nq) && (!sub || name.length < sub.length)) sub = name;
      }
      return pref || sub;
    };
    const nearestGroups = (lonlat, maxM, n) => {
      const q = mx(lonlat);
      return [...net.groups.values()]
        .map((g) => ({ g, d: Math.hypot(g.cm[0] - q[0], g.cm[1] - q[1]) }))
        .filter((x) => x.d <= maxM)
        .sort((a, b) => a.d - b.d)
        .slice(0, n);
    };

    // own autocomplete dropdown — iOS Safari never renders <datalist> options
    // (that's why the datalist approach showed nothing on phones)
    const wireSuggest = (input, sug, onPick) => {
      const hide = () => { sug.hidden = true; };
      const show = () => {
        if (!net) return;
        const q = norm(input.value);
        if (q.length < 2) return hide();
        const pref = [], sub = [];
        for (const name of net.groups.keys()) {
          const nn = norm(name);
          if (nn.startsWith(q)) { if (pref.length < 8) pref.push(name); }
          else if (nn.includes(q) && sub.length < 8) sub.push(name);
        }
        const list = [...pref, ...sub].slice(0, 8);
        if (!list.length) return hide();
        sug.innerHTML = '';
        for (const name of list) {
          const d = document.createElement('div');
          d.textContent = name;
          // pointerdown fires BEFORE the input's blur, so the tap always lands
          d.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            input.value = name;
            hide();
            if (onPick) onPick();
          });
          sug.appendChild(d);
        }
        sug.hidden = false;
      };
      input.addEventListener('input', show);
      input.addEventListener('focus', show);
      input.addEventListener('blur', () => setTimeout(hide, 150));
    };
    wireSuggest(fromEl, document.getElementById('j-from-sug'), () => { gpsPos = null; });
    wireSuggest(toEl, document.getElementById('j-to-sug'));

    // best ride on one line between two named groups: the direction where the
    // destination lies AHEAD of the boarding stop
    const findLeg = (line, fromName, toName) => {
      let best = null;
      for (const rec of net.byLine.get(line) || []) {
        const a = rec.pos.get(fromName), b = rec.pos.get(toName);
        if (!a || !b || b.at - a.at < 30) continue;
        if (!best || b.at - a.at < best.m) best = { line, mode: rec.mode, color: rec.color, rec, a, b, m: b.at - a.at, from: fromName, to: toName };
      }
      return best;
    };

    const searchJourneys = (fromNames, toNames, walkM) => {
      const opts = [], seen = new Set();
      const fromLines = new Set(), toLines = new Set();
      for (const n of fromNames) for (const l of net.groups.get(n).lines) fromLines.add(l);
      for (const n of toNames) for (const l of net.groups.get(n).lines) toLines.add(l);
      for (const l of fromLines) {
        if (!toLines.has(l)) continue;
        for (const fn of fromNames) for (const tn of toNames) {
          const leg = findLeg(l, fn, tn);
          if (!leg) continue;
          const key = l + '|' + fn + '|' + tn;
          if (seen.has(key)) continue;
          seen.add(key);
          opts.push({ legs: [leg], m: leg.m + (walkM.get(fn) || 0) });
        }
      }
      // one-transfer candidates, then options that differ only by the FIRST
      // line (same boarding stop, same transfer stop, same second ride)
      // merge into one entry: "5 / 17 / 50 → Politechnika → 904"
      const merged = new Map();
      for (const l1 of fromLines) for (const l2 of toLines) {
        if (l1 === l2) continue;
        const shared = [...net.nameSet.get(l1)].filter((n) => net.nameSet.get(l2).has(n));
        for (const fn of fromNames) for (const tn of toNames) {
          if (fn === tn) continue;
          let best = null;
          for (const T of shared) {
            if (T === fn || T === tn) continue;
            const leg1 = findLeg(l1, fn, T), leg2 = findLeg(l2, T, tn);
            if (!leg1 || !leg2) continue;
            const m = leg1.m + leg2.m;
            if (!best || m < best.m) best = { legs: [leg1, leg2], m };
          }
          if (!best) continue;
          // 900 m penalty keeps a transfer from outranking a similar direct ride
          best.m += 900 + (walkM.get(fn) || 0);
          const key = fn + '>' + best.legs[0].to + '>' + best.legs[1].line;
          const prev = merged.get(key);
          if (!prev) merged.set(key, best);
          else if (best.m < prev.m) { best.alt1 = [...(prev.alt1 || []), prev.legs[0].line]; merged.set(key, best); }
          else (prev.alt1 = prev.alt1 || []).push(best.legs[0].line);
        }
      }
      opts.push(...merged.values());
      // TWO transfers, only when simpler options are scarce: middle line L2
      // links a stop of a start line with a stop of a destination line via
      // the transfer matrix; both interchange stops chosen to minimise the
      // total ridden metres. Middle lines already usable directly or with
      // one transfer are skipped — those rides are covered above.
      if (opts.length < 3) {
        const endLines = new Set([...fromLines, ...toLines]);
        const merged2 = new Map();
        for (const l1 of fromLines) for (const [l2, shared1] of net.adj.get(l1) || []) {
          if (endLines.has(l2)) continue;
          for (const l3 of toLines) {
            if (l3 === l1 || l3 === l2) continue;
            const shared2 = net.adj.get(l2).get(l3);
            if (!shared2) continue;
            for (const fn of fromNames) for (const tn of toNames) {
              if (fn === tn) continue;
              let best = null;
              for (const T1 of shared1) {
                if (T1 === fn || T1 === tn) continue;
                const leg1 = findLeg(l1, fn, T1);
                if (!leg1) continue;
                for (const T2 of shared2) {
                  if (T2 === fn || T2 === tn || T2 === T1) continue;
                  const leg2 = findLeg(l2, T1, T2), leg3 = findLeg(l3, T2, tn);
                  if (!leg2 || !leg3) continue;
                  const m = leg1.m + leg2.m + leg3.m;
                  if (!best || m < best.m) best = { legs: [leg1, leg2, leg3], m };
                }
              }
              if (!best) continue;
              best.m += 1800 + (walkM.get(fn) || 0);
              const key = fn + '>' + best.legs[0].to + '>' + l2 + '>' + best.legs[1].to + '>' + l3;
              const prev = merged2.get(key);
              if (!prev) merged2.set(key, best);
              else if (best.m < prev.m) { best.alt1 = [...(prev.alt1 || []), prev.legs[0].line]; merged2.set(key, best); }
              else (prev.alt1 = prev.alt1 || []).push(best.legs[0].line);
            }
          }
        }
        opts.push(...merged2.values());
      }
      opts.sort((a, b) => a.legs.length - b.legs.length || a.m - b.m);
      // one option per distinct line sequence, best first
      const out = [], used = new Set();
      for (const o of opts) {
        const sig = o.legs.map((l) => l.line).join('>');
        if (used.has(sig)) continue;
        used.add(sig);
        out.push(o);
        if (out.length >= 6) break;
      }
      return out;
    };

    // overlay: the exact ridden segments + boarding/transfer/alighting stops
    map.addSource('journey', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'journey-walk', type: 'line', source: 'journey',
      filter: ['==', ['get', 'kind'], 'walk'],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#556', 'line-width': 3, 'line-dasharray': [0.2, 2] },
    });
    map.addLayer({
      id: 'journey-casing', type: 'line', source: 'journey',
      filter: ['==', ['get', 'kind'], 'leg'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 11 },
    });
    map.addLayer({
      id: 'journey-line', type: 'line', source: 'journey',
      filter: ['==', ['get', 'kind'], 'leg'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 6.5 },
    });
    map.addLayer({
      id: 'journey-line-numbers', type: 'symbol', source: 'journey',
      filter: ['==', ['get', 'kind'], 'leg'],
      layout: {
        'symbol-placement': 'line', 'text-field': ['get', 'line'], 'text-font': [NARROW_BOLD],
        'text-size': 12.5, 'symbol-spacing': 260, 'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 2.4 },
    });
    map.addLayer({
      id: 'journey-via', type: 'circle', source: 'journey',
      filter: ['==', ['get', 'kind'], 'via'],
      paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-width': 2.2, 'circle-stroke-color': ['get', 'color'] },
    });
    map.addLayer({
      id: 'journey-via-names', type: 'symbol', source: 'journey',
      filter: ['==', ['get', 'kind'], 'via'],
      minzoom: 12.5,
      layout: {
        'text-field': ['get', 'name'], 'text-font': [NARROW], 'text-size': 11,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.7,
      },
      paint: { 'text-color': '#223344', 'text-halo-color': '#ffffff', 'text-halo-width': 2.2 },
    });
    map.addLayer({
      id: 'journey-pts', type: 'circle', source: 'journey',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-width': 3.5, 'circle-stroke-color': KMK_DARK },
    });
    map.addLayer({
      id: 'journey-pts-names', type: 'symbol', source: 'journey',
      filter: ['==', ['get', 'kind'], 'stop'],
      layout: {
        'text-field': ['get', 'name'], 'text-font': [NARROW_BOLD], 'text-size': 13.5,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.9,
      },
      paint: { 'text-color': KMK_DARK, 'text-halo-color': '#ffffff', 'text-halo-width': 2.6 },
    });

    const sliceLeg = (leg) => {
      const { coords } = leg.rec;
      const ip = (S) => {
        const a = coords[S.seg], b = coords[S.seg + 1] || a;
        return [a[0] + (b[0] - a[0]) * S.t, a[1] + (b[1] - a[1]) * S.t];
      };
      const out = [ip(leg.a)];
      for (let i = leg.a.seg + 1; i <= leg.b.seg; i++) out.push(coords[i]);
      out.push(ip(leg.b));
      return out;
    };

    const applyJourney = (opt) => {
      const feats = [];
      let west = 180, south = 90, east = -180, north = -90;
      for (const leg of opt.legs) {
        const line = sliceLeg(leg);
        for (const c of line) {
          west = Math.min(west, c[0]); east = Math.max(east, c[0]);
          south = Math.min(south, c[1]); north = Math.max(north, c[1]);
        }
        feats.push({ type: 'Feature', properties: { kind: 'leg', color: leg.color, line: leg.line }, geometry: { type: 'LineString', coordinates: line } });
        // intermediate stops of the ride (strictly between boarding and alighting)
        for (const [name, pr] of leg.rec.pos) {
          if (pr.at > leg.a.at + 1 && pr.at < leg.b.at - 1) {
            feats.push({ type: 'Feature', properties: { kind: 'via', name, color: leg.color }, geometry: { type: 'Point', coordinates: net.groups.get(name).c } });
          }
        }
      }
      const stopsSeq = [opt.legs[0].from, ...opt.legs.map((l) => l.to)];
      for (const name of stopsSeq) {
        feats.push({ type: 'Feature', properties: { kind: 'stop', name }, geometry: { type: 'Point', coordinates: net.groups.get(name).c } });
      }
      if (gpsPos) {
        feats.push({ type: 'Feature', properties: { kind: 'walk' }, geometry: { type: 'LineString', coordinates: [gpsPos, net.groups.get(opt.legs[0].from).c] } });
      }
      map.getSource('journey').setData({ type: 'FeatureCollection', features: feats });
      state.journey = { lines: [...new Set([...opt.legs.map((l) => l.line), ...(opt.alt1 || [])])] };
      applyFilters();
      const phone = window.matchMedia('(max-width: 560px)').matches;
      const panelOpen = !document.getElementById('panel').classList.contains('collapsed');
      map.fitBounds([[west, south], [east, north]], {
        padding: phone ? { top: 66, bottom: 30, left: 24, right: 24 }
          : { top: 90, bottom: 40, left: panelOpen ? 340 : 60, right: 60 },
        maxZoom: 14.5,
      });
      jpOpen(false); // the expanded card covers the shown route — hide it on pick
    };

    const clearJourney = () => {
      state.journey = null;
      map.getSource('journey').setData({ type: 'FeatureCollection', features: [] });
      resEl.innerHTML = '';
      msg('');
      applyFilters();
    };

    const esc2 = esc;
    const renderResults = (opts) => {
      resEl.innerHTML = '';
      opts.forEach((o, i) => {
        const li = document.createElement('li');
        const parts = o.legs.map((l, li) => {
          const all = li === 0 && o.alt1 ? [l.line, ...o.alt1] : [l.line];
          const label = all.slice(0, 5).join(' / ') + (all.length > 5 ? ' …' : '');
          const tip = all.length > 5 ? ` title="${esc2(all.join(' / '))}"` : '';
          return `<span class="jl" style="background:${esc2(l.color)}"${tip}>${esc2(label)}</span> ${esc2(l.from)} &rarr; ${esc2(l.to)}`;
        });
        const km = o.legs.reduce((s, l) => s + l.m, 0) / 1000;
        const tr = o.legs.length - 1;
        li.innerHTML = `${parts.join('<br>')} <span class="jkm">&middot; ${km.toFixed(1)} km${tr ? ` &middot; ${tr} transfer${tr > 1 ? 's' : ''}` : ''}</span>`;
        li.addEventListener('click', () => {
          resEl.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
          li.classList.add('active');
          applyJourney(opts[i]);
        });
        resEl.appendChild(li);
      });
    };

    document.getElementById('j-gps').addEventListener('click', () => {
      msg('Locating…');
      if (!navigator.geolocation) { msg('Geolocation is not available in this browser.'); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        gpsPos = [pos.coords.longitude, pos.coords.latitude];
        fromEl.value = 'My location (GPS)';
        msg('');
      }, (e) => msg('GPS unavailable: ' + e.message), { enableHighAccuracy: true, timeout: 8000 });
    });
    fromEl.addEventListener('input', () => { gpsPos = null; });

    document.getElementById('j-go').addEventListener('click', async () => {
      msg('Searching…');
      resEl.innerHTML = '';
      await ensureNet();
      const walkM = new Map();
      let fromNames;
      if (gpsPos) {
        const near = nearestGroups(gpsPos, 900, 3);
        if (!near.length) { msg('No stop within 900 m of the GPS position.'); return; }
        for (const x of near) walkM.set(x.g.name, x.d);
        fromNames = near.map((x) => x.g.name);
      } else {
        const n = resolveName(fromEl.value);
        if (!n) { msg('Start stop not found: ' + fromEl.value); return; }
        fromEl.value = n;
        fromNames = [n];
      }
      const tn = resolveName(toEl.value);
      if (!tn) { msg('Destination stop not found: ' + toEl.value); return; }
      toEl.value = tn;
      if (fromNames.length === 1 && fromNames[0] === tn) { msg('Start and destination are the same stop.'); return; }
      const opts = searchJourneys(fromNames, [tn], walkM);
      if (!opts.length) { msg('No route found with at most two transfers.'); return; }
      msg('');
      renderResults(opts);
      resEl.firstChild.classList.add('active');
      applyJourney(opts[0]);
    });
    document.getElementById('j-clear').addEventListener('click', clearJourney);
  }

  // NOT fitBounds(meta.bbox): the MPK network reaches Wieliczka, Krzeszowice and Niepolomice, so fitting the data
  // bbox would open on countryside with the city as a blob. Open on the city — the
  // whole network is one zoom out.
  map.jumpTo({ center: [19.9375, 50.0615], zoom: 11.6 });
}

init().catch((err) => {
  console.error(err);
  document.getElementById('footer').textContent = 'Data loading error: ' + err.message;
});

// Collapsible panel: on phones the panel covers half the map, so it starts
// collapsed there and folds to a small button; independent of map init.
{
  const panelEl = document.getElementById('panel');
  const panelBtn = document.getElementById('panel-toggle');
  const syncPanelBtn = () => {
    const closed = panelEl.classList.contains('collapsed');
    panelBtn.textContent = closed ? '☰' : '×';
    const t = closed ? 'Show the panel' : 'Hide the panel';
    panelBtn.title = t;
    panelBtn.setAttribute('aria-label', t);
    panelBtn.setAttribute('aria-expanded', String(!closed));
  };
  panelBtn.addEventListener('click', () => {
    panelEl.classList.toggle('collapsed');
    syncPanelBtn();
  });
  if (window.matchMedia('(max-width: 560px)').matches) panelEl.classList.add('collapsed');
  syncPanelBtn();
}
