// Schematic (transit diagram) renderer. Deliberately separate from app.js:
// no basemap — a blank paper style with the diagram geojson from
// ../data/schematic/. Glyphs come from the same VersaTiles endpoint the
// geographic map uses, so both pages share one typographic system.
'use strict';

const KMK = '#0059a9';
// One operator, two modes: bus corridors in the family navy, tram corridors in
// the family red — exactly the printed KMK sheet.
const BADGE_IMAGES = []; // [name, ImageData, opts] — replayed onto the export map
const OP_COLOR = KMK;
const TRAM = '#d6212b';
const INK = '#1d2b36';
const NARROW = 'roboto_condensed_regular';
const NARROW_BOLD = 'roboto_condensed_bold';
const DATA = '../data/schematic/';

let map;

// Pages serves everything with max-age=600 and the data URLs carried no
// version, so a rebuilt diagram kept showing its previous self for ten minutes
// (the river the user had just asked to remove). meta.json is fetched fresh
// and its build stamp versions every other data URL.
const DATA_V = { v: '' };
const dataUrl = (name) => DATA + name + (DATA_V.v ? '?v=' + encodeURIComponent(DATA_V.v) : '');

async function init() {
  const meta = await (await fetch(DATA + 'meta.json?cb=' + Date.now())).json();
  DATA_V.v = meta.generatedAt || '';

  document.getElementById('stamp').textContent = new Date(meta.generatedAt).toLocaleDateString();
  const c = meta.counts;
  document.getElementById('counts').textContent =
    `${c.busLines} bus + ${c.tramLines} tram lines · ${c.stations} stations · ` +
    `${c.corridors} corridors · ${c.layoutNodes} layout nodes`;
  if (meta.stage === 'layout') {
    document.getElementById('stage-note').textContent =
      'Automatic diagram: stop order and shared segments come from GTFS, positions ' +
      'from an octilinear layout.';
  }

  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: 'https://tiles.versatiles.org/assets/glyphs/{fontstack}/{range}.pbf',
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#fbfaf5' } }],
    },
    center: [19.94, 50.06],
    zoom: 11.0,
    minZoom: 8.5,
    maxZoom: 16.5,
    attributionControl: false,
  });
  window.__map = map; // debug/test hook
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({
    compact: true, customAttribution: 'Diagram: GTFS ZTP Kraków (MPK) · MLD (Koleje Małopolskie) · WST Wieliczka',
  }));

  map.on('load', () => {
    // the map can be constructed before the stylesheet lays out #map — the
    // canvas then sticks at the 400×300 fallback (this maplibre build only
    // watches window.resize). Re-measure and fit the network for real.
    map.resize();
    map.fitBounds(meta.bbox, { padding: 48, animate: false });

    for (const name of ['network', 'tram', 'stops', 'numbers', 'terminals', 'river', 'bridges', 'debug']) {
      map.addSource(name, { type: 'geojson', data: dataUrl(name + '.geojson') });
    }

    const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
    // corridor stroke grows with the number of lines it carries (ln-scaled)
    const busWidth = (base, perLn) => ['+', base, ['*', perLn, ['ln', ['get', 'n']]]];

    // ---------- Wisła: a wide orientation band under everything ----------
    map.addLayer({
      id: 'river', type: 'line', source: 'river',
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': '#cfe6f7', 'line-width': z(9, 6, 12, 16, 15, 40) },
    });
    map.addLayer({
      id: 'river-name', type: 'symbol', source: 'river',
      minzoom: 10.5,
      layout: {
        'symbol-placement': 'line',
        'text-field': 'Wisła',
        'text-font': [NARROW_BOLD],
        'text-size': z(10.5, 11, 15, 22),
        'text-letter-spacing': 0.18,
        'symbol-spacing': 420,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#a9cfec', 'text-halo-width': 0.8 },
    });
    // Bridges are the anchors that hold the river to the network, so they are
    // worth showing: they tell the reader where a line actually gets across.
    const BRIDGE = ['match', ['get', 'rail'], 1, '#8a8172', '#6f97b5'];
    map.addLayer({
      id: 'bridges', type: 'circle', source: 'bridges',
      paint: {
        'circle-radius': z(9.5, 1.8, 11, 2.4, 14, 4.0),
        'circle-color': '#ffffff',
        'circle-stroke-color': BRIDGE,
        'circle-stroke-width': z(9.5, 1.0, 11, 1.3, 14, 2.0),
      },
    });

    // ---------- bus corridors ----------
    map.addLayer({
      id: 'net-casing', type: 'line', source: 'network',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': z(9, busWidth(1.5, 0.35), 12, busWidth(2.4, 0.7), 14.5, busWidth(3.8, 1.2)),
      },
    });
    map.addLayer({
      id: 'net', type: 'line', source: 'network',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': OP_COLOR,
        'line-width': z(9, busWidth(0.5, 0.3), 12, busWidth(1.1, 0.6), 14.5, busWidth(2.0, 1.1)),
      },
    });

    // ---------- tram corridors: ONE family-red stroke, like the printed KMK
    // map. Where a corridor also carries buses, the red stroke steps aside so
    // red runs beside navy instead of covering it. ----------
    const tramOffset = z(9, ['*', ['get', 'bus'], 2.0], 12, ['*', ['get', 'bus'], 3.4], 14.5, ['*', ['get', 'bus'], 5.4]);
    map.addLayer({
      id: 'tram-casing', type: 'line', source: 'tram',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': z(9, busWidth(1.5, 0.35), 12, busWidth(2.4, 0.7), 14.5, busWidth(3.8, 1.2)),
        'line-offset': tramOffset,
      },
    });
    map.addLayer({
      id: 'tram', type: 'line', source: 'tram',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': TRAM,
        'line-width': z(9, busWidth(0.5, 0.3), 12, busWidth(1.1, 0.6), 14.5, busWidth(2.0, 1.1)),
        'line-offset': tramOffset,
      },
    });

    // ---------- stops ----------
    // beads (plain stops) appear only when zoomed in — at network scale the
    // diagram reads through its corridors and interchanges, like the KMK poster.
    // zoom interpolation must sit at the top level, so the data-driven size
    // multiplier (bigger discs for majors) lives in the outputs.
    map.addLayer({
      id: 'stops', type: 'circle', source: 'stops',
      filter: ['==', ['get', 'node'], 0],
      minzoom: 12,
      paint: {
        'circle-radius': z(12, 1.7, 15, 3.6),
        'circle-color': '#ffffff',
        'circle-stroke-color': INK,
        'circle-stroke-width': z(12, 1.0, 15, 1.5),
      },
    });
    const nodeScale = ['+', 1, ['*', 0.55, ['get', 'major']]];
    map.addLayer({
      id: 'stops-nodes', type: 'circle', source: 'stops',
      filter: ['==', ['get', 'node'], 1],
      paint: {
        'circle-radius': z(9, ['*', 1.6, nodeScale], 13, ['*', 3.0, nodeScale], 15, ['*', 4.6, nodeScale]),
        'circle-color': '#ffffff',
        'circle-stroke-color': INK,
        'circle-stroke-width': z(9, 0.9, 13, 1.3, 15, 1.7),
      },
    });
    // termini are FILLED discs in the line's own colour, as on the printed map
    map.addLayer({
      id: 'stops-term', type: 'circle', source: 'stops',
      filter: ['all', ['==', ['get', 'term'], 1], ['<=', ['get', 'deg'], 1]],
      paint: {
        'circle-radius': z(9, 2.2, 13, 4.0, 15, 6.0),
        'circle-color': ['case', ['==', ['get', 'tram'], 1], TRAM, KMK],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': z(9, 0.8, 13, 1.2, 15, 1.6),
      },
    });

    // ---------- line numbers along the corridors ----------
    // PITFALL (learned on the geographic map): with text-rotate +
    // rotation-alignment 'map', text-pitch-alignment MUST be stated explicitly —
    // 'auto' inherits 'map' and then NOTHING renders, with no console error.
    const numbersDef = {
      id: 'numbers', type: 'symbol', source: 'numbers',
      minzoom: 11,
      layout: {
        'text-field': ['get', 'text'],
        'text-font': [NARROW_BOLD],
        'text-size': z(11, 7.5, 13, 9, 15.5, 11.5),
        'text-rotate': ['get', 'angle'],
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
        'text-anchor': 'bottom',
        'text-offset': [0, -0.55],
        'text-max-width': 6,
        'text-line-height': 1.05,
        'text-padding': 1,
      },
      paint: {
        'text-color': ['case', ['==', ['get', 'mode'], 'tram'], TRAM, KMK],
        'text-halo-color': '#ffffff',
        'text-halo-width': 2.0,
      },
    };

    // ---------- station names: majors early, nodes mid, the rest late ----------
    // Added LAST, below. MapLibre resolves symbol collisions from the top layer
    // downwards, so the last symbol layer added wins the spot. Priority we want:
    // stop names > terminus plates > corridor numbers — hence that layer order.
    const nameDef = (id, filter, minzoom, size, font) => ({
      id, type: 'symbol', source: 'stops', filter, minzoom,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [font],
        'text-size': size,
        'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
        'text-radial-offset': 0.7,
        'text-max-width': 8,
        'text-line-height': 1.1,
        'text-padding': 1,
      },
      paint: {
        'text-color': INK,
        'text-halo-color': '#ffffff',
        'text-halo-width': 2.2,
      },
    });
    map.addLayer(numbersDef);

    // ---------- terminus badges: the number plates of the printed map ----------
    // One stretchable rounded-rect icon per mode; `icon-text-fit: both` grows
    // the middle to whatever the label needs while the corners stay crisp.
    const BADGE = 24, R = 6, PR = 2; // logical px, corner radius, pixel ratio
    const badgeImage = (fill, rim) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = BADGE * PR;
      const g = cv.getContext('2d');
      g.scale(PR, PR);
      g.fillStyle = fill;
      g.beginPath();
      // inset by a pixel so the rim is not clipped at the image edge
      if (g.roundRect) g.roundRect(1, 1, BADGE - 2, BADGE - 2, R);
      else { // Safari < 16.4
        g.moveTo(R, 1); g.arcTo(BADGE - 1, 1, BADGE - 1, BADGE - 1, R); g.arcTo(BADGE - 1, BADGE - 1, 1, BADGE - 1, R);
        g.arcTo(1, BADGE - 1, 1, 1, R); g.arcTo(1, 1, BADGE - 1, 1, R); g.closePath();
      }
      g.fill();
      if (rim) { g.lineWidth = 1.6; g.strokeStyle = rim; g.stroke(); }
      return {
        image: g.getImageData(0, 0, cv.width, cv.height),
        // stretch/content are given in the image's own pixel space
        opts: {
          pixelRatio: PR,
          content: [R * PR, R * PR, (BADGE - R) * PR, (BADGE - R) * PR],
          stretchX: [[R * PR, (BADGE - R) * PR]],
          stretchY: [[R * PR, (BADGE - R) * PR]],
        },
      };
    };
    // Semi-transparent plates: at full opacity they blanked the corridors they
    // sit on, and moving them above the names (below) means they now win every
    // collision — so they must let the drawing show through.
    // White plates with a coloured rim and the numbers in the mode's colour —
    // the filled blocks were the loudest thing on the sheet (user verdict on
    // the Warsaw diagram, 22.08.2026); the printed map's badges are white.
    for (const [name, fill, rim] of [['badge-bus', 'rgba(255,255,255,0.92)', '#0059a9'], ['badge-tram', 'rgba(255,255,255,0.92)', '#d6212b']]) {
      const b = badgeImage(fill, rim);
      map.addImage(name, b.image, b.opts);
      // getStyle() does NOT carry images added with addImage, so the hidden map
      // the PNG export renders on had no plate icon and dropped the terminus
      // layer without a word — no loop on the whole sheet carried its line
      // numbers (user report). The export re-adds them from here.
      BADGE_IMAGES.push([name, b.image, b.opts]);
    }
    // 173 plates at once bury the network at overview zoom, so they arrive in two
    // waves: the busiest termini early, the rest once the diagram is zoomed in.
    const terminalDef = (id, extra) => ({
      id, type: 'symbol', source: 'terminals',
      layout: {
        'icon-image': ['concat', 'badge-', ['get', 'mode']],
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [1, 3.5, 1, 3.5],
        'text-field': ['get', 'text'],
        'text-font': [NARROW_BOLD],
        'text-size': z(10.5, 7.5, 13, 9, 15.5, 11),
        'text-max-width': 4,
        'text-line-height': 1.05,
        // the plate sits BESIDE the terminus disc, on whichever side is free
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 1.0,
        'symbol-sort-key': ['-', 0, ['get', 'n']], // busiest termini win collisions
        // A loop's line numbers are the one label the sheet cannot lose: on the
        // export they were dropped wholesale by the collision solver, so they
        // are exempted from it entirely.
        'icon-allow-overlap': true,
        'text-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'text-color': ['match', ['get', 'mode'], 'tram', TRAM, KMK] },
      ...extra,
    });
    // plates arrive later and the early wave is rarer: at overview zoom the
    // network should read through its corridors, not its loops
    map.addLayer(terminalDef('terminals-major', {
      minzoom: 12.5, maxzoom: 13.5, filter: ['>=', ['get', 'n'], 8],
    }));
    map.addLayer(terminalDef('terminals', { minzoom: 13.5 }));

    // station names go on top so they win every collision (see note above)
    map.addLayer(nameDef('stop-names-major', ['==', ['get', 'major'], 1], 9.5,
      z(9.5, 10, 14, 13), NARROW_BOLD));
    map.addLayer(nameDef('stop-names-node',
      ['all', ['==', ['get', 'node'], 1], ['==', ['get', 'major'], 0]], 11.5,
      z(11.5, 9, 14, 11.5), NARROW));
    map.addLayer(nameDef('stop-names',
      ['all', ['==', ['get', 'node'], 0], ['==', ['get', 'major'], 0]], 13,
      z(13, 8.5, 15, 10.5), NARROW));
    // only the properly named crossings — OSM labels the rest with the street
    map.addLayer({
      id: 'bridge-names', type: 'symbol', source: 'bridges',
      minzoom: 12.5,
      filter: ['in', 'ost', ['get', 'name']], // "Most …" / "Kładka …" carry "ost"/"adka"
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [NARROW],
        'text-size': z(12.5, 8.5, 15, 10.5),
        'text-max-width': 7,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.8,
      },
      paint: {
        'text-color': '#3d6b8c',
        'text-halo-color': '#ffffff',
        'text-halo-width': 2.0,
      },
    });

    // Terminus plates go back ON TOP of the station names. MapLibre resolves
    // collisions from the topmost symbol layer down, and with the names above
    // them the plates lost every contest in the dense parts and were missing
    // from the export entirely (user report). A loop without its line numbers
    // is the one label a network diagram cannot do without.
    map.moveLayer('terminals-major');
    map.moveLayer('terminals');

    // ---------- debug overlay: GPS ↔ diagram displacement (rule 17) ----------
    map.addLayer({
      id: 'debug-vec', type: 'line', source: 'debug',
      filter: ['==', ['get', 't'], 'vec'],
      layout: { visibility: 'none' },
      paint: { 'line-color': '#d40000', 'line-width': 1, 'line-dasharray': [2, 1.5] },
    });
    map.addLayer({
      id: 'debug-gps', type: 'circle', source: 'debug',
      filter: ['==', ['get', 't'], 'gps'],
      layout: { visibility: 'none' },
      paint: { 'circle-radius': 2.2, 'circle-color': '#d40000' },
    });
    map.addLayer({
      id: 'debug-id', type: 'symbol', source: 'debug',
      filter: ['==', ['get', 't'], 'sch'],
      minzoom: 12.5,
      layout: {
        visibility: 'none',
        'text-field': ['concat', ['get', 'sid'], ' · ', ['to-string', ['get', 'd']], ' m'],
        'text-font': [NARROW],
        'text-size': 8.5,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.7],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#a00000', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
    });

    // ---------- panel wiring ----------
    const vis = (ids, on) => ids.forEach((id) =>
      map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    const busBox = document.getElementById('toggle-bus');
    const tramBox = document.getElementById('toggle-tram') || { checked: false, addEventListener() {} };
    const LAYER_BASE = {
      'stops': ['==', ['get', 'node'], 0],
      'stops-nodes': ['==', ['get', 'node'], 1],
      'stops-term': ['all', ['==', ['get', 'term'], 1], ['<=', ['get', 'deg'], 1]],
      'stop-names-major': ['==', ['get', 'major'], 1],
      'stop-names-node': ['all', ['==', ['get', 'node'], 1], ['==', ['get', 'major'], 0]],
      'stop-names': ['all', ['==', ['get', 'node'], 0], ['==', ['get', 'major'], 0]],
    };
    const applyFilters = () => {
      vis(['net-casing', 'net'], busBox.checked);
      vis(['tram-casing', 'tram'], tramBox.checked);
      // stops carry bus/tram flags …
      const parts = [];
      if (busBox.checked) parts.push(['==', ['get', 'bus'], 1]);
      if (tramBox.checked) parts.push(['==', ['get', 'tram'], 1]);
      const f = parts.length ? ['any', ...parts] : ['==', ['get', 'bus'], 2]; // matches nothing
      for (const id of Object.keys(LAYER_BASE)) map.setFilter(id, ['all', LAYER_BASE[id], f]);
      // … numbers and terminus plates carry a single mode
      const modes = [];
      if (busBox.checked) modes.push('bus');
      if (tramBox.checked) modes.push('tram');
      const mf = modes.length
        ? ['in', ['get', 'mode'], ['literal', modes]]
        : ['==', ['get', 'mode'], ' '];
      map.setFilter('numbers', mf);
      map.setFilter('terminals', mf);
      map.setFilter('terminals-major', ['all', ['>=', ['get', 'n'], 8], mf]);
    };
    busBox.addEventListener('change', applyFilters);
    tramBox.addEventListener('change', applyFilters);
    document.getElementById('toggle-debug').addEventListener('change', (e) =>
      vis(['debug-vec', 'debug-gps', 'debug-id'], e.target.checked));

    // station popup: name + line count (quick QA of the merge)
    for (const layerId of ['stops', 'stops-nodes']) {
      map.on('click', layerId, (e) => {
        const p = e.features[0].properties;
        new maplibregl.Popup({ closeButton: false, offset: 10 })
          .setLngLat(e.features[0].geometry.coordinates)
          .setHTML(`<strong>${p.name}</strong><br>${p.n} line${p.n === 1 ? '' : 's'} · ` +
            `${['bus', 'tram'].filter((m) => p[m]).join(' + ')}${p.node ? ' · layout node' : ''}`)
          .addTo(map);
      });
      map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    }
  });
}


// ---------- PNG export: the whole sheet, at printing detail ----------
// The diagram only does its job on paper, and on paper EVERY stop carries its
// name and every corridor its line numbers. Those are zoom-gated on screen, so
// the export renders at a zoom where they are all on — which makes the image
// far wider than any single GPU texture. Hence tiles: a hidden map walks the
// bbox, each frame is drawn into one big canvas, and the legend is painted on
// top at the end.
// Doubling the layout's length targets does NOT widen the sheet: the layout
// fits its own scale to the data, so longer targets simply halve the metres per
// grid unit and the drawing comes out the same size. The lever that actually
// buys room between labels is the zoom the export renders at — labels are drawn
// at a fixed pixel size, so a zoom step apart doubles the space around each one.
const EXPORT_ZOOM = 15.2;   // every label layer is live, and 2x the room of 14.2
const LABEL_BOOST = 1.45; // export type scale — see the note at the call site
const TILE = 1400;          // px per rendered frame, safely inside texture limits
const MAX_PX = 220e6;       // ~220 MP ceiling, so the canvas cannot blow up memory

const OPS = [
  ['Autobus', 'Bus line', '#0059a9'],
  ['Tramwaj', 'Tram line', '#d6212b'],
];

// Legend in the shape of the printed KMK sheet: a white card with a navy
// header, drawn straight onto the export canvas so it travels with the image.
const LEGEND_W = 560, LEGEND_H = 420; // logical px, before the export scale

// Drawn into a band added BELOW the diagram rather than over a corner of it:
// the network is a ragged ring and every corner of its bbox has strokes in it,
// so a floating card covered the map (user report). A band cannot overlap.
function drawLegend(ctx, x, y, meta, scale) {
  const s = scale;
  const pad = 18 * s;
  const bw = LEGEND_W * s, bh = LEGEND_H * s;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#c9d3e0';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.rect(x, y, bw, bh);
  ctx.fill();
  ctx.stroke();
  // header bar
  ctx.fillStyle = '#12365e';
  ctx.fillRect(x, y, bw, 46 * s);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${22 * s}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('Legenda / Legend', x + pad, y + 23 * s);

  let ly = y + 46 * s + 26 * s;
  const line = (color, pl, en, dashed) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 6 * s;
    ctx.setLineDash(dashed ? [10 * s, 7 * s] : []);
    ctx.beginPath();
    ctx.moveTo(x + pad, ly);
    ctx.lineTo(x + pad + 62 * s, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#10151c';
    ctx.font = `600 ${15 * s}px system-ui, sans-serif`;
    ctx.fillText(pl, x + pad + 78 * s, ly - 7 * s);
    ctx.fillStyle = '#67707c';
    ctx.font = `${13 * s}px system-ui, sans-serif`;
    ctx.fillText(en, x + pad + 78 * s, ly + 10 * s);
    ly += 40 * s;
  };
  const disc = (fill, stroke, r, pl, en) => {
    ctx.beginPath();
    ctx.arc(x + pad + 31 * s, ly, r * s, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 2.6 * s;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.fillStyle = '#10151c';
    ctx.font = `600 ${15 * s}px system-ui, sans-serif`;
    ctx.fillText(pl, x + pad + 78 * s, ly - 7 * s);
    ctx.fillStyle = '#67707c';
    ctx.font = `${13 * s}px system-ui, sans-serif`;
    ctx.fillText(en, x + pad + 78 * s, ly + 10 * s);
    ly += 40 * s;
  };

  for (const [pl, en, color] of OPS) line(color, 'Linia — ' + pl, en);
  disc('#ffffff', '#1d2b36', 5, 'Przystanek', 'Stop');
  disc('#ffffff', '#1d2b36', 8, 'Węzeł przesiadkowy', 'Interchange');
  disc('#0059a9', '#ffffff', 8, 'Przystanek końcowy', 'Terminus');

  ctx.fillStyle = '#67707c';
  ctx.font = `${12 * s}px system-ui, sans-serif`;
  const when = new Date(meta.generatedAt).toLocaleDateString('pl-PL');
  ctx.fillText(`GTFS: ZTP Kraków (MPK) · ${when}`,
    x + pad, y + bh - 16 * s);
  ctx.restore();
}

async function exportPng() {
  const btn = document.getElementById('export-png');
  const note = document.getElementById('export-note');
  btn.disabled = true;
  const meta = await (await fetch(DATA + 'meta.json?cb=' + Date.now())).json();
  const [W_, S_, E_, N_] = meta.bbox;

  // world pixel span of the bbox at EXPORT_ZOOM (Web Mercator)
  const worldPx = 512 * Math.pow(2, EXPORT_ZOOM);
  const mx = (lon) => (lon + 180) / 360 * worldPx;
  const my = (lat) => {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
  };
  const PADPX = 90;
  let x0 = mx(W_) - PADPX, x1 = mx(E_) + PADPX;
  let y0 = my(N_) - PADPX, y1 = my(S_) + PADPX;
  let outW = Math.ceil(x1 - x0), outH = Math.ceil(y1 - y0);
  let shrink = 1;
  if (outW * outH > MAX_PX) {
    shrink = Math.sqrt(MAX_PX / (outW * outH));
    outW = Math.round(outW * shrink);
    outH = Math.round(outH * shrink);
  }

  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-99999px;top:0;width:${TILE}px;height:${TILE}px`;
  document.body.appendChild(host);
  const style = map.getStyle();
  const hidden = new maplibregl.Map({
    container: host, style, center: map.getCenter(), zoom: EXPORT_ZOOM,
    attributionControl: false, interactive: false, preserveDrawingBuffer: true, fadeDuration: 0,
  });
  await new Promise((res) => hidden.on('load', res));
  for (const [name, img, opts] of BADGE_IMAGES) {
    if (!hidden.hasImage(name)) hidden.addImage(name, img, opts);
  }
  // Type is sized for a screen at arm's length; a poster is read from further
  // away and printed smaller than it is rendered, so every label grows on the
  // export. The size is an expression, so it is wrapped rather than replaced.
  for (const l of hidden.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    const size = hidden.getLayoutProperty(l.id, 'text-size');
    if (size === undefined) continue;
    hidden.setLayoutProperty(l.id, 'text-size', ['*', size, LABEL_BOOST]);
  }

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fbfaf5';
  ctx.fillRect(0, 0, outW, outH);

  const cols = Math.ceil((x1 - x0) / TILE), rows = Math.ceil((y1 - y0) / TILE);
  const lonOf = (px) => px / worldPx * 360 - 180;
  const latOf = (py) => {
    const n = Math.PI - 2 * Math.PI * py / worldPx;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cxPx = x0 + c * TILE + TILE / 2;
      const cyPx = y0 + r * TILE + TILE / 2;
      hidden.jumpTo({ center: [lonOf(cxPx), latOf(cyPx)], zoom: EXPORT_ZOOM });
      await new Promise((res) => hidden.once('idle', res));
      ctx.drawImage(hidden.getCanvas(),
        Math.round(c * TILE * shrink), Math.round(r * TILE * shrink),
        Math.round(TILE * shrink), Math.round(TILE * shrink));
      note.textContent = `rendering ${r * cols + c + 1}/${rows * cols}…`;
    }
  }
  hidden.remove();
  host.remove();

  // final sheet = diagram + a white band holding the legend
  const lscale = Math.max(1, outW / 3000);
  const bandH = Math.round(LEGEND_H * lscale + 80 * lscale);
  const sheet = document.createElement('canvas');
  sheet.width = outW;
  sheet.height = outH + bandH;
  const sctx = sheet.getContext('2d');
  sctx.fillStyle = '#fbfaf5';
  sctx.fillRect(0, 0, sheet.width, sheet.height);
  sctx.drawImage(out, 0, 0);
  drawLegend(sctx, outW - LEGEND_W * lscale - 40 * lscale, outH + 40 * lscale, meta, lscale);

  const blob = await new Promise((res) => sheet.toBlob(res, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  a.download = `krakow-diagram_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${sheet.width}x${sheet.height}.png`;
  if (!window.__exportNoSave) a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  window.__lastExport = { w: sheet.width, h: sheet.height, tiles: rows * cols };
  window.__exportThumb = sheet.toDataURL('image/png');
  note.textContent = `${sheet.width} × ${sheet.height} px`;
  btn.disabled = false;
}

document.getElementById('export-png').addEventListener('click', () => {
  exportPng().catch((err) => {
    console.error(err);
    document.getElementById('export-note').textContent = 'export failed: ' + err.message;
    document.getElementById('export-png').disabled = false;
  });
});

init();
