// Station importance (rule 9): how many lines pass through, how connected the
// node is, whether lines terminate here, whether both modes meet. The score
// steers three things downstream: the displacement penalty w8 (major nodes
// barely move), the improvement order of the local search (hubs move last),
// and label priority in the renderer.
export function scoreStations(stations, graph, contracted, cfg) {
  const { adj, edges, stTerm } = graph;
  const { layoutNodes } = contracted;

  let maxImp = 0;
  for (const st of stations) {
    const inc = adj.get(st.idx) || [];
    const lines = new Set(), modes = new Set();
    for (const key of inc) for (const id of edges.get(key).lines) {
      lines.add(id);
      modes.add(id.slice(0, id.indexOf(':')));
    }
    const term = stTerm.get(st.idx);
    st.nLines = lines.size;
    st.lineIds = lines;
    st.modes = [...modes].sort();
    st.degree = inc.length;
    st.termLines = term ? [...term] : [];
    st.isNode = layoutNodes.has(st.idx);
    st.imp = lines.size
      + 1.2 * inc.length
      + 1.5 * (term ? term.size : 0)
      + (modes.size > 1 ? 2 : 0);
    if (st.imp > maxImp) maxImp = st.imp;
  }
  const used = stations.filter((s) => s.degree > 0);
  for (const st of stations) st.impN = maxImp ? +(st.imp / maxImp).toFixed(3) : 0;

  // the top slice by importance is "major" — w8 freezes them hardest
  const sorted = [...used].sort((a, b) => b.imp - a.imp);
  const nMajor = Math.max(1, Math.round(used.length * cfg.majorShare));
  sorted.forEach((s, i) => { s.major = i < nMajor ? 1 : 0; });
  return { nMajor, top: sorted.slice(0, 12).map((s) => `${s.name} (${s.imp.toFixed(1)})`) };
}
