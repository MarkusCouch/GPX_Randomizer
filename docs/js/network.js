/* GPX Randomizer — meter-based noding, section graph and seeded route search.
 * No external dependencies. Shared by the browser worker and Node tests. */
import {R, RAD, clamp, finiteZ, dist, lerp, projection, project, unproject, foot, lineLength, angleDiff, ascent, countTurns} from "./geo.js";
export {projection, project, unproject} from "./geo.js";
import {buildOSMNetwork} from "./osm.js";

function intersection(a, b) {
  const ax = a.b[0] - a.a[0], ay = a.b[1] - a.a[1], bx = b.b[0] - b.a[0], by = b.b[1] - b.a[1];
  const den = ax * by - ay * bx;
  if (Math.abs(den) < 1e-8) return null;
  const dx = b.a[0] - a.a[0], dy = b.a[1] - a.a[1];
  const t = (dx * by - dy * bx) / den, u = (dx * ay - dy * ax) / den;
  if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
  return {t: clamp(t, 0, 1), u: clamp(u, 0, 1)};
}
export function buildNetwork(routes, options = {}, progress = () => {}) {
  if(options.osmReference)return buildOSMNetwork(routes,options.osmReference,options,progress);
  // Stable order makes geometry and seeded suggestions independent of the
  // file-picker selection order. Source indexes refer to network.routes.
  routes = [...routes].sort((a,b) => {const ak=a.fileName||a.name||a.id,bk=b.fileName||b.name||b.id;return ak<bk?-1:ak>bk?1:0;});
  const tolerance = clamp(Number(options.tolerance ?? 15), 0.5, 40);
  const heightCheck = options.heightCheck ?? true;
  const heightThreshold = clamp(Number(options.heightThreshold) || 8, 2, 40);
  const compatible = (a, b) => !heightCheck || !finiteZ(a[2]) || !finiteZ(b[2]) || Math.abs(a[2] - b[2]) <= heightThreshold;
  const origin = projection(routes), segments = [], routeInfo = [], seenGeometry = new Map(), sourceGroups = new Map();
  for (const r of routes) for (const part of r.segments) for (const p of part) {
    const projected = project(p, origin);
    if (Math.abs(projected[0]) > 250000 || Math.abs(projected[1]) > 250000) throw new Error('Der Datensatz ist für die lokale Meterprojektion zu groß. Bitte einen Bereich von höchstens 500 km Ausdehnung verwenden.');
  }
  let inputPoints = 0, inputLength = 0;
  progress({stage: 'GPX-Punkte vorbereiten', percent: 4});
  for (let ri = 0; ri < routes.length; ri++) {
    const signature = routes[ri].segments.map(part => {const a=JSON.stringify(part),b=JSON.stringify([...part].reverse());return a<b?a:b;}).sort().join('|');
    const duplicateOf = seenGeometry.get(signature);
    if(duplicateOf===undefined){seenGeometry.set(signature,ri);sourceGroups.set(ri,[ri]);}
    else sourceGroups.get(duplicateOf).push(ri);
    let length = 0, count = 0;
    for (let pi = 0; pi < routes[ri].segments.length; pi++) {
      const part = routes[ri].segments[pi].map(p => project(p, origin));
      count += part.length;
      for (let i = 1; i < part.length; i++) {
        const a = part[i - 1], b = part[i], l = dist(a, b);
        if (l < 0.02) continue;
        length += l;
        if(duplicateOf!==undefined)continue;
        segments.push({id: segments.length, a, b, length: l, terminalA: i===1, terminalB: i===part.length-1, route: ri, part: pi, index: i,
          minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]),
          cuts: [{t: 0, p: a, kind: 'vertex'}, {t: 1, p: b, kind: 'vertex'}]});
      }
    }
    inputPoints += count; inputLength += length;
    routeInfo.push({id: routes[ri].id, name: routes[ri].name, fileName: routes[ri].fileName, color: routes[ri].color, length, points: count});
  }
  if (inputPoints > 100000) throw new Error('Dieser MVP unterstützt bis zu 100.000 GPX-Punkte pro Datensatz. Bitte weniger Dateien gleichzeitig laden.');
  if (segments.length === 0) throw new Error('Die Auswahl enthält keine befahrbaren Liniensegmente.');
  const grid = new Map(), cellSize = Math.max(60, tolerance * 4);
  const cells = s => {
    const out = [];
    if ((s.maxX - s.minX + 2 * tolerance) * (s.maxY - s.minY + 2 * tolerance) / cellSize ** 2 > 10000) throw new Error('Ein GPX-Segment überspringt einen zu großen Bereich. Bitte die Datei auf fehlende Streckenpunkte prüfen.');
    for (let x = Math.floor((s.minX - tolerance) / cellSize); x <= Math.floor((s.maxX + tolerance) / cellSize); x++)
      for (let y = Math.floor((s.minY - tolerance) / cellSize); y <= Math.floor((s.maxY + tolerance) / cellSize); y++) out.push(`${x},${y}`);
    return out;
  };
  let checkedPairs = 0, crossEvents = 0, snapEvents = 0, blockedEvents = 0, corridorMatches = 0, uncertainPairs = 0;
  const blocked = [], blockedSeen = new Set();
  const add = (s, t, p, kind, mode = null) => s.cuts.push({t, p, kind, mode});
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si], keys = cells(s), candidates = new Set();
    for (const key of keys) for (const id of grid.get(key) || []) candidates.add(id);
    for (const oi of candidates) {
      const o = segments[oi];
      if (s.route === o.route && s.part === o.part && Math.abs(s.index - o.index) <= 1) continue;
      if (s.maxX + tolerance < o.minX || o.maxX + tolerance < s.minX || s.maxY + tolerance < o.minY || o.maxY + tolerance < s.minY) continue;
      checkedPairs++;
      const hit = intersection(s, o);
      if (hit) {
        const p = lerp(s.a, s.b, hit.t), q = lerp(o.a, o.b, hit.u);
        if (compatible(p, q)) {
          add(s, hit.t, p, 'crossing'); add(o, hit.u, q, 'crossing'); crossEvents++;
        } else {
          blockedEvents++;
          const key = `${Math.round(p[0] / 10)},${Math.round(p[1] / 10)}`;
          if (!blockedSeen.has(key)) {blockedSeen.add(key); blocked.push({coord: unproject(p, origin), difference: Math.abs(p[2] - q[2]), routes: [s.route, o.route]});}
        }
      }
      // Nearby parallel lines need direction AND longitudinal support. Keep
      // larger offsets separate: GPX geometry cannot prove that two parallel
      // roads are the same road. Exact intersections are handled above.
      const sx=(s.b[0]-s.a[0])/s.length, sy=(s.b[1]-s.a[1])/s.length;
      const ox=(o.b[0]-o.a[0])/o.length, oy=(o.b[1]-o.a[1])/o.length;
      const cosine=Math.abs(sx*ox+sy*oy), parallel=cosine>Math.cos(20*RAD);
      const ta=(s.a[0]-o.a[0])*ox+(s.a[1]-o.a[1])*oy;
      const tb=(s.b[0]-o.a[0])*ox+(s.b[1]-o.a[1])*oy;
      const overlap=Math.max(0,Math.min(o.length,Math.max(ta,tb))-Math.max(0,Math.min(ta,tb)));
      const supported=overlap>=Math.min(30,Math.min(s.length,o.length)*.5);
      let ambiguous=false, matched=false;
      for (const [point, owner, endpoint, other] of [[s.a, s, 0, o], [s.b, s, 1, o], [o.a, o, 0, s], [o.b, o, 1, s]]) {
        const f = foot(point, other.a, other.b);
        if (f.d > tolerance || !compatible(point, f.p)) continue;
        const terminal=endpoint===0?owner.terminalA:owner.terminalB;
        const mode=f.d<=.75?'exact':parallel&&supported&&f.d<=tolerance*.5+1e-4?'corridor':!parallel&&cosine<.87&&terminal?'junction':null;
        if (mode) {
          add(other, f.t, f.p, f.d > 0.1 ? 'snap' : 'overlap', mode);
          add(owner, endpoint, point, f.d > 0.1 ? 'snap' : 'overlap', mode);
          if (f.d > 0.1) snapEvents++;
          if(mode==='corridor')matched=true;
        } else if(parallel&&supported&&f.d>.75) ambiguous=true;
      }
      if(matched)corridorMatches++;
      if(ambiguous&&!matched)uncertainPairs++;
    }
    for (const key of keys) {if (!grid.has(key)) grid.set(key, []); grid.get(key).push(si);}
    if (si % 400 === 0) progress({stage: 'Schnittpunkte und nahe Wege verbinden', percent: 10 + Math.round(si / segments.length * 57)});
  }
  progress({stage: 'Gemeinsame Wege zusammenfassen', percent: 70});
  const nodes = [], nodeGrid = new Map(), rawEdges = [], edgeMap = new Map(), sourceVertexNodes = new Map();
  const nodeFor = cut => {
    const p = cut.p, x = Math.floor(p[0] / tolerance), y = Math.floor(p[1] / tolerance);
    // A source vertex belongs to both adjacent GPX segments. A different
    // snapping decision must never tear a continuous source track apart.
    if(cut.vertexKey&&sourceVertexNodes.has(cut.vertexKey)){
      const n=nodes[sourceVertexNodes.get(cut.vertexKey)];n.kinds.add(cut.kind);n.modes.add(cut.mode);n.directions.push(cut.direction);return n.id;
    }
    let best = null, d = tolerance + 1e-8;
    // Fixed representatives avoid unbounded transitive GPS-cluster chains.
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of nodeGrid.get(`${x + dx},${y + dy}`) || []) {
      const n = nodes[id], nd = dist(n.p, p);
      const sameDirection=n.directions.some(v=>Math.abs(v[0]*cut.direction[0]+v[1]*cut.direction[1])>Math.cos(20*RAD));
      const supportedSnap=cut.mode==='corridor'&&n.modes.has('corridor')&&sameDirection&&nd<=tolerance*.5+1e-4;
      const junctionSnap=cut.mode==='junction'&&n.modes.has('junction');
      if (nd < d && compatible(n.p, p) && (nd<=.75||supportedSnap||junctionSnap)) {best = n; d = nd;}
    }
    if (best) {best.kinds.add(cut.kind);best.modes.add(cut.mode);best.directions.push(cut.direction);if(cut.vertexKey)sourceVertexNodes.set(cut.vertexKey,best.id); return best.id;}
    const n = {id: nodes.length, p: p.slice(), kinds: new Set([cut.kind]), modes:new Set([cut.mode]), directions:[cut.direction], edges: []};
    nodes.push(n);
    if(cut.vertexKey)sourceVertexNodes.set(cut.vertexKey,n.id);
    const key = `${x},${y}`; if (!nodeGrid.has(key)) nodeGrid.set(key, []); nodeGrid.get(key).push(n.id);
    return n.id;
  };
  for (const s of segments) {
    s.cuts.sort((a, b) => a.t - b.t);
    const cuts = [];
    for (const c of s.cuts) {
      const prev = cuts.at(-1);
      if (prev && Math.abs(prev.t - c.t) < 1e-7) {if (c.kind === 'crossing' || c.kind === 'snap') prev.kind = c.kind;if(c.mode&&c.mode!=='exact')prev.mode=c.mode;}
      else cuts.push(c);
    }
    const direction=[(s.b[0]-s.a[0])/s.length,(s.b[1]-s.a[1])/s.length];
    const ids = cuts.map(c=>nodeFor({...c,direction,vertexKey:c.t<1e-7||c.t>1-1e-7?`${s.route}:${s.part}:${c.p[0].toFixed(4)}:${c.p[1].toFixed(4)}:${finiteZ(c.p[2])?c.p[2].toFixed(2):'?'}`:null}));
    for (let i = 1; i < ids.length; i++) {
      const u = ids[i - 1], v = ids[i]; if (u === v) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (edgeMap.has(key)) {for(const ri of sourceGroups.get(s.route))rawEdges[edgeMap.get(key)].sources.add(ri); continue;}
      const e = {id: rawEdges.length, u, v, sources: new Set(sourceGroups.get(s.route))};
      rawEdges.push(e); edgeMap.set(key, e.id); nodes[u].edges.push(e.id); nodes[v].edges.push(e.id);
    }
  }
  // Contract degree-two shape points into sections, retaining full geometry.
  // A closed isolated ring receives an anchor and becomes a traversable loop.
  const anchors = new Set(nodes.filter(n => n.edges.length && n.edges.length !== 2).map(n => n.id));
  const seenComponents = new Set(), componentRaw = [];
  for (const n of nodes) {
    if (!n.edges.length || seenComponents.has(n.id)) continue;
    const stack = [n.id], comp = []; seenComponents.add(n.id);
    while (stack.length) {
      const id = stack.pop(); comp.push(id);
      for (const ei of nodes[id].edges) {const e = rawEdges[ei], v = e.u === id ? e.v : e.u; if (!seenComponents.has(v)) {seenComponents.add(v); stack.push(v);}}
    }
    if (!comp.some(id => anchors.has(id))) anchors.add(Math.min(...comp));
    componentRaw.push(comp);
  }
  const visitedEdges = new Set(), sections = [], activeNodes = [];
  for (const id of anchors) {
    for (const first of nodes[id].edges) {
      if (visitedEdges.has(first)) continue;
      let current = id, ei = first; const geometry = [nodes[id].p], sources = new Set();
      for (let guard = 0; guard <= rawEdges.length; guard++) {
        const e = rawEdges[ei]; visitedEdges.add(ei); for (const r of e.sources) sources.add(r);
        current = e.u === current ? e.v : e.u; geometry.push(nodes[current].p);
        if (anchors.has(current)) break;
        ei = nodes[current].edges.find(x => !visitedEdges.has(x));
        if (ei === undefined) break;
      }
      const length = lineLength(geometry);
      if (length > 0.05) sections.push({id: sections.length, u: id, v: current, length, sources: [...sources],
        geometry: geometry.map(p => unproject(p, origin)), ascent: ascent(geometry), descent: ascent([...geometry].reverse()), turns: countTurns(geometry)});
    }
  }
  const nodeComponents = new Map(); componentRaw.forEach((c, i) => c.forEach(id => nodeComponents.set(id, i)));
  const sectionDegree = new Map();
  for (const e of sections) {sectionDegree.set(e.u, (sectionDegree.get(e.u) || 0) + 1); sectionDegree.set(e.v, (sectionDegree.get(e.v) || 0) + 1);}
  for (const id of anchors) {
    const n = nodes[id];
    activeNodes.push({id, coord: unproject(n.p, origin), degree: sectionDegree.get(id) || 0,
      kind: n.kinds.has('snap') ? 'snap' : n.kinds.has('crossing') ? 'crossing' : 'endpoint', component: nodeComponents.get(id)});
  }
  const components = componentRaw.map((c, id) => ({id, nodes: activeNodes.filter(n => n.component === id).length,
    sections: sections.filter(e => nodeComponents.get(e.u) === id).length,
    length: sections.filter(e => nodeComponents.get(e.u) === id).reduce((a, e) => a + e.length, 0)})).sort((a, b) => b.length - a.length);
  progress({stage: 'Wegenetz bereit', percent: 100});
  return {origin, options: {tolerance, heightCheck, heightThreshold}, nodes: activeNodes, edges: sections, blocked,
    routes: routeInfo, stats: {inputPoints, inputLength, corridorMatches, uncertainPairs, duplicateTracks:routes.length-seenGeometry.size,inputSegments: segments.length, checkedPairs, crossEvents, snapEvents, blockedEvents,
      rawNodes: nodes.filter(n => n.edges.length).length, shapePoints: nodes.filter(n => n.edges.length === 2).length,
      nodes: activeNodes.length, junctions: activeNodes.filter(n => n.degree >= 3).length,
      sections: sections.length, length: sections.reduce((a, e) => a + e.length, 0), components}};
}

export function nearestPoint(network, coord) {
  const p=project(coord,network.origin);
  const scan=(edges,point)=>{
    let best=null;
    for(const e of edges)for(let i=1;i<e.geometry.length;i++){
      const a=project(e.geometry[i-1],network.origin),b=project(e.geometry[i],network.origin),f=foot(point,a,b);
      if(!best||f.d<best.distance)best={edgeId:e.id,segment:i-1,t:f.t,coord:unproject(f.p,network.origin),distance:f.d,edge:e};
    }
    return best;
  };
  let best=scan(network.edges,p);
  if(best?.edge.unclear&&network.confirmedConnections?.length){
    const confirmed=scan(network.confirmedConnections.map((c,i)=>({id:i,geometry:c.geometry})),p);
    if(confirmed?.distance<=15){
      const exact=scan(network.edges.filter(e=>!e.unclear),project(confirmed.coord,network.origin));
      if(exact?.distance<.01)best={...exact,distance:dist(p,project(exact.coord,network.origin)),confirmedSnap:true};
    }
  }
  if(best)delete best.edge;
  return best;
}

// GPX collection starts often lie on short station forecourts or access spurs.
// Choose the initial marker on a substantial cycle block, while keeping an
// explicitly user-picked start unchanged. Bridges must not become fake loops.
export function recommendedStart(network, preferred) {
  const adj = new Map(network.nodes.map(n => [n.id, []]));
  for (const edge of network.edges) {adj.get(edge.u).push({edge, to: edge.v}); adj.get(edge.v).push({edge, to: edge.u});}
  const entered = new Map(), low = new Map(), stack=[], blocks=[], selfLoops=new Set(); let clock = 0;
  const visit = (id, parentEdge = -1) => {
    entered.set(id, ++clock); low.set(id, clock);
    for (const {edge, to} of adj.get(id)) {
      if(to===id){if(!selfLoops.has(edge.id)){selfLoops.add(edge.id);blocks.push({edges:[edge],length:edge.length});}continue;}
      if (edge.id === parentEdge) continue;
      if (!entered.has(to)) {
        stack.push(edge);visit(to, edge.id);low.set(id, Math.min(low.get(id), low.get(to)));
        if(low.get(to)>=entered.get(id)){const edges=[];let e;do{e=stack.pop();edges.push(e);}while(e.id!==edge.id);if(edges.length>1)blocks.push({edges,length:edges.reduce((sum,e)=>sum+e.length,0)});}
      }else if(entered.get(to)<entered.get(id)){stack.push(edge);low.set(id, Math.min(low.get(id), entered.get(to)));}
    }
  };
  for (const node of network.nodes) if (!entered.has(node.id)) visit(node.id);
  const maxLength = Math.max(0, ...blocks.map(b => b.length));
  const edges = blocks.filter(b => b.length >= Math.min(10000, maxLength * .3)).flatMap(b => b.edges);
  // Prefer a real junction with three distinct approach directions over a
  // tiny parallel-lane cycle around a meeting point or station forecourt.
  const cycleIds=new Set(edges.map(e=>e.id)), preferredPoint=project(preferred,network.origin);
  let junction=null;
  for(const node of network.nodes){
    const steps=adj.get(node.id),cycleSteps=steps.filter(s=>cycleIds.has(s.edge.id));
    if(steps.length<3||cycleSteps.length<2)continue;
    const originPoint=project(node.coord,network.origin),distance=dist(originPoint,preferredPoint);
    if(distance>1000||(junction&&distance>=junction.distance))continue;
    const headings=[];
    for(const {edge} of steps){
      const geometry=edge.u===node.id?edge.geometry:[...edge.geometry].reverse();
      const next=geometry.map(p=>project(p,network.origin)).find(p=>dist(p,originPoint)>=25);
      if(!next)continue;
      const angle=Math.atan2(next[1]-originPoint[1],next[0]-originPoint[0]);
      if(headings.every(a=>angleDiff(a,angle)>35*RAD))headings.push(angle);
    }
    if(headings.length>=3)junction={coord:node.coord,distance,edgeId:cycleSteps[0].edge.id,reason:'cycle-junction'};
  }
  if(junction)return junction;
  return nearestPoint({...network, edges: edges.length ? edges : network.edges}, preferred);
}

function makeRoutingGraph(network, start, end = null, waypoints = []) {
  const nodes = new Map(network.nodes.map(n => [n.id, {...n}])), edges = network.edges.map(e => ({...e,networkEdgeId:e.id}));
  let nextNode = Math.max(...nodes.keys(), 0) + 1, nextEdge = edges.length;
  const insert = coord => {
    const nearest = nearestPoint({...network, edges: edges.filter(e => !e.removed)}, coord);
    if (!nearest) throw new Error('Das Wegenetz ist leer.');
    const edge = edges.find(e => e.id === nearest.edgeId), p = project(nearest.coord, network.origin);
    if (dist(p, project(nodes.get(edge.u).coord, network.origin)) < 0.5) return edge.u;
    if (dist(p, project(nodes.get(edge.v).coord, network.origin)) < 0.5) return edge.v;
    const id = nextNode++; nodes.set(id, {id, coord: nearest.coord}); edge.removed = true;
    const left = [...edge.geometry.slice(0, nearest.segment + 1), nearest.coord];
    const right = [nearest.coord, ...edge.geometry.slice(nearest.segment + 1)];
    for (const [u, v, geometry] of [[edge.u, id, left], [id, edge.v, right]]) {
      const projected = geometry.map(x => project(x, network.origin));
      edges.push({...edge, id: nextEdge++, u, v, geometry, removed: false, length: lineLength(projected), ascent: ascent(projected), descent: ascent([...projected].reverse()), turns: countTurns(projected)});
    }
    return id;
  };
  const startId = insert(start), endId = end ? insert(end) : startId;
  const waypointIds = waypoints.map(insert);
  const active = edges.filter(e => !e.removed), adj = new Map([...nodes.keys()].map(id => [id, []])),undirected=new Map([...nodes.keys()].map(id=>[id,[]])),reverseAdj=new Map([...nodes.keys()].map(id=>[id,[]]));
  for (const e of active) {
    const a={edge:e,to:e.v,reverse:false},b={edge:e,to:e.u,reverse:true};
    undirected.get(e.u).push(a);undirected.get(e.v).push(b);
    if(e.forward!==false){adj.get(e.u).push(a);reverseAdj.get(e.v).push(b);}if(e.backward!==false){adj.get(e.v).push(b);reverseAdj.get(e.u).push(a);}
  }
  return {nodes, edges: active, adj, undirected, reverseAdj, startId, endId, waypointIds};
}
class Heap {
  constructor() {this.a = [];}
  push(item) {const a = this.a; let i = a.length; a.push(item); while (i) {const p = (i - 1) >> 1; if (a[p][0] <= item[0]) break; a[i] = a[p]; i = p;} a[i] = item;}
  pop() {const a = this.a, first = a[0], last = a.pop(); if (a.length) {let i = 0; while (i * 2 + 1 < a.length) {let j = i * 2 + 1; if (j + 1 < a.length && a[j + 1][0] < a[j][0]) j++; if (a[j][0] >= last[0]) break; a[i] = a[j]; i = j;} a[i] = last;} return first;}
}
function dijkstra(graph, from, target = null, cost = step => step.edge.length) {
  const distances = new Map([[from, 0]]), previous = new Map(), heap = new Heap(); heap.push([0, from]);
  while (heap.a.length) {
    const [d, id] = heap.pop(); if (d > distances.get(id)) continue;
    if (id === target) break;
    for (const step of graph.adj.get(id) || []) {
      const nd = d + Math.max(0.001, cost(step));
      if (nd < (distances.get(step.to) ?? Infinity)) {distances.set(step.to, nd); previous.set(step.to, {from: id, ...step}); heap.push([nd, step.to]);}
    }
  }
  if (target === null) return {distances, previous};
  if (!distances.has(target)) return null;
  const path = []; let current = target;
  while (current !== from) {const s = previous.get(current); if (!s) return null; path.push(s); current = s.from;}
  return {path: path.reverse(), distance: distances.get(target)};
}
export function seededRandom(seed) {
  let h = 2166136261; for (const c of String(seed)) {h ^= c.charCodeAt(0); h = Math.imul(h, 16777619);}
  return () => {h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296;};
}

// A section ID alone cannot identify a repeated physical corridor. Inspect
// the complete geometry, including excursions hidden inside one long section.
export function inspectRouteGeometry(geometry, origin, tolerance = 15, constraints = {}) {
  const spacing = 12, corridor = clamp(tolerance * 1.7, 18, 30);
  const points = geometry.map(p => project(p, origin)), samples = [];
  let length = 0, next = 0;const distances=[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], l = dist(a, b);
    if (l < .001){distances.push(length);continue;}
    while (next <= length + l) {
      const p = lerp(a, b, (next - length) / l);
      samples.push({p, at: next}); next += spacing;
    }
    length += l;distances.push(length);
  }
  const protectedAt=[];for(const coord of constraints.protectedCoords||[]){const p=project(coord,origin);points.forEach((q,i)=>{if(dist(p,q)<.5)protectedAt.push(distances[i]);});}
  const requiredReturn=(a,b)=>protectedAt.some(at=>at>a+spacing&&at<b-spacing);
  const verified=at=>(constraints.verifiedRanges||[]).some(([a,b])=>at>=a&&at<=b);
  const grid = new Map(), overlapping = new Set();
  let shortReturns = 0, reversals = 0,protectedReturns=0;
  const maxExcursion = Math.min(3500, length * .2);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], x = Math.floor(s.p[0] / corridor), y = Math.floor(s.p[1] / corridor);
    const prev = samples[Math.max(0, i - 2)].p, after = samples[Math.min(samples.length - 1, i + 2)].p;
    const heading = [after[0] - prev[0], after[1] - prev[1]];
    const hl = Math.hypot(...heading);
    if (i >= 2 && i + 2 < samples.length) {
      const ax = s.p[0] - prev[0], ay = s.p[1] - prev[1], bx = after[0] - s.p[0], by = after[1] - s.p[1];
      const norm = Math.hypot(ax, ay) * Math.hypot(bx, by);
      if (norm > 16 && (ax * bx + ay * by) / norm < Math.cos(160 * RAD)) reversals++;
    }
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${x + dx},${y + dy}`) || []) {
        const old = samples[j], separation = s.at - old.at;
        if (separation < 84 || dist(s.p, old.p) > corridor) continue;
        // Do not classify the intentional closure of the whole round trip.
        const required=requiredReturn(old.at,s.at),known=required&&verified(old.at)&&verified(s.at);
        if (separation >= 150 && separation <= maxExcursion){if(known)protectedReturns++;else shortReturns++;}
        const a = samples[Math.max(0, j - 2)].p, b = samples[Math.min(samples.length - 1, j + 2)].p;
        const hx = b[0] - a[0], hy = b[1] - a[1], denom = hl * Math.hypot(hx, hy);
        if (!known&&denom > 1 && (heading[0] * hx + heading[1] * hy) / denom < -.8) {overlapping.add(i); overlapping.add(j);}
      }
    }
    const key = `${x},${y}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i);
  }
  const nearRetraced = overlapping.size * spacing / 2;
  // A block-sized or waterfront excursion can return 50–250 m away from its
  // entrance without retracing exactly the same corridor. Detect these narrow
  // local balloons at a coarser scale as well. The full tour remains exempt.
  const wideGrid = new Map(), wideCell = 250, wideLimit = Math.min(5000, length * .2);
  for (let i = 0; i < samples.length; i += 4) {
    const s = samples[i], x = Math.floor(s.p[0] / wideCell), y = Math.floor(s.p[1] / wideCell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of wideGrid.get(`${x + dx},${y + dy}`) || []) {
        const separation = s.at - samples[j].at;
        if (separation >= 400 && separation <= wideLimit && dist(s.p, samples[j].p) < Math.min(250, separation / 12)){if(requiredReturn(samples[j].at,s.at)&&verified(samples[j].at)&&verified(s.at))protectedReturns++;else shortReturns++;}
      }
    }
    const key = `${x},${y}`; if (!wideGrid.has(key)) wideGrid.set(key, []); wideGrid.get(key).push(i);
  }
  return {nearRetraced, shortReturns, reversals,protectedReturns,
    acceptable: nearRetraced < 60 && shortReturns === 0 && reversals === 0};
}

function unpackShortest(tree, from, to) {
  if (!tree.distances.has(to)) return null;
  const path = []; let current = to;
  while (current !== from) {const s = tree.previous.get(current); if (!s) return null; path.push(s); current = s.from;}
  return path.reverse();
}

// Replace short, inefficient excursions only with existing network sections.
// Protect the global round trip; do not turn a planned tour into its shortest
// start-to-finish connection or draw a straight line across missing paths.
export function removeLocalDetours(path, graph, shortestTrees = new Map(), protectedNodes = new Set()) {
  let result = [...path], removed = 0;
  const originalLength = path.reduce((a, s) => a + s.edge.length, 0);
  const limit = Math.min(5000, originalLength * .2);
  for (let iteration = 0; iteration < 8; iteration++) {
    let best = null;
    for (let i = 0; i < result.length; i++) {
      const from = result[i].from; let walked = 0;
      for (let j = i; j < result.length; j++) {
        walked += result[j].edge.length;
        if (walked > limit) break;
        if (walked < 140 || (i === 0 && j === result.length - 1)) continue;
        const to = result[j].to;
        if (from === to) continue;
        // A user-selected stop inside this interval must survive a shortcut.
        if (result.slice(i, j).some(s => protectedNodes.has(s.to))) continue;
        if (!shortestTrees.has(from)) shortestTrees.set(from, dijkstra(graph, from));
        const tree = shortestTrees.get(from), shorter = tree.distances.get(to);
        if (shorter === undefined || shorter > walked * .6 || walked - shorter < 80) continue;
        const alternative = unpackShortest(tree, from, to);
        const outsideNodes = new Set([...result.slice(0, i).map(s => s.from), ...result.slice(j + 1).map(s => s.to)]);
        if (!alternative || alternative.slice(0, -1).some(s => outsideNodes.has(s.to))) continue;
        const saving = walked - shorter;
        if (!best || saving > best.saving) best = {i, j, alternative, saving};
      }
    }
    if (!best) break;
    result.splice(best.i, best.j - best.i + 1, ...best.alternative); removed += best.saving;
  }
  return {path: result, removed};
}

function summarizePath(path, graph, origin, target, options) {
  if (!path.length) return null;
  // Erase excursions returning to an already visited node. Keep only the
  // final closure of a round trip, never an attached extra loop or spur.
  const clean=[], positions=new Map([[path[0].from,0]]);
  for(let i=0;i<path.length;i++){
    const step=path[i],at=positions.get(step.to);
    const containsStop=at!==undefined&&clean.slice(at).some(s=>options.protectedNodes?.has(s.to));
    if(at!==undefined && !containsStop && !(i===path.length-1 && at===0 && options.mode!=='ab')){
      clean.splice(at);positions.clear();positions.set(path[0].from,0);
      clean.forEach((s,j)=>positions.set(s.to,j+1));
    }else{clean.push(step);positions.set(step.to,clean.length);}
  }
  path=clean;
  if(!path.length || new Set(path.map(s=>s.edge.id)).size!==path.length)return null;

  const geometry = [], counts = new Map(), used = new Set(); let length = 0, repeated = 0, junctionVisits = 0,pushingLength=0,restrictedLength=0,uncertainLength=0,connectionLength=0;
  for (const s of path) {
    const points = s.reverse ? [...s.edge.geometry].reverse() : s.edge.geometry;
    geometry.push(...(geometry.length ? points.slice(1) : points)); length += s.edge.length;
    if(s.edge.connectionIds?.length)connectionLength+=s.edge.length;
    if(s.edge.pushing)pushingLength+=s.edge.length;if(s.edge.restricted)restrictedLength+=s.edge.length;if(s.edge.unclear)uncertainLength+=s.edge.length;
    if (counts.has(s.edge.id)) repeated += s.edge.length;
    counts.set(s.edge.id, (counts.get(s.edge.id) || 0) + 1); used.add(s.edge.id);
    if ((graph.adj.get(s.to)?.length || 0) >= 3) junctionVisits++;
  }
  const projected = geometry.map(p => project(p, origin)), up = ascent(projected), down = ascent([...projected].reverse());
  const elevationCoverage = geometry.filter(p => finiteZ(p[2])).length / geometry.length;
  const turns = countTurns(projected), error = Math.abs(length - target) / target, repeatedRatio = repeated / length;
  const score = error * (error > options.lengthTolerance ? 160 : 45) + repeatedRatio * 25 + (pushingLength+restrictedLength+uncertainLength)/length*8
    - (options.hills || 0) * up / Math.max(1, length / 1000) * 0.16
    - (options.turns || 0) * Math.min(50, turns / Math.max(1, length / 10000)) * 0.025;
  return {_path: path, geometry, length, ascent: elevationCoverage > 0.8 ? up : null, descent: elevationCoverage > 0.8 ? down : null, elevationCoverage,
    repeated, repeatedRatio, turns, junctionVisits, error, score,pushingLength,restrictedLength,uncertainLength,connectionLength,uncertainGeometry:path.filter(s=>s.edge.unclear).map(s=>s.edge.geometry), edgeIds: [...used], traversals: path.map(s => ({edgeId: s.edge.id, networkEdgeId:s.edge.networkEdgeId??s.edge.id, connectionIds:s.edge.connectionIds||[], from: s.from, to: s.to, reverse: s.reverse, length: s.edge.length,pushing:!!s.edge.pushing,restricted:!!s.edge.restricted,unclear:!!s.edge.unclear}))};
}

export function routeOverlap(a, b) {
  const lengths=new Map(a.traversals.map(s=>[s.edgeId,s.length]));
  let shared=0;
  for(const s of b.traversals)if(lengths.has(s.edgeId))shared+=Math.min(lengths.get(s.edgeId),s.length);
  return shared/Math.max(1,Math.min(a.length,b.length));
}

function findGraphBridges(adj) {
  const entered=new Map(),low=new Map(),bridges=new Set();let clock=0;
  const visit=(id,parent=-1)=>{
    entered.set(id,++clock);low.set(id,clock);
    for(const s of adj.get(id)||[]){
      if(s.edge.id===parent)continue;
      if(!entered.has(s.to)){visit(s.to,s.edge.id);low.set(id,Math.min(low.get(id),low.get(s.to)));if(low.get(s.to)>entered.get(id))bridges.add(s.edge.id);}
      else low.set(id,Math.min(low.get(id),entered.get(s.to)));
    }
  };
  for(const id of adj.keys())if(!entered.has(id))visit(id);
  return bridges;
}

function requiredConnectionIssue(graph,bridges,fixed){
  const sections=new Map(),blockedPoints=[];
  const tree=dijkstra({...graph,adj:graph.undirected},graph.startId);
  for(const [i,id]of fixed.entries()){
    const path=unpackShortest(tree,graph.startId,id);
    const required=(path||[]).filter(s=>bridges.has(s.edge.id));
    if(!required.length)continue;blockedPoints.push(i);
    for(const s of required)if(!sections.has(s.edge.id))sections.set(s.edge.id,{id:s.edge.id,length:s.edge.length,geometry:s.edge.geometry});
  }
  if(!sections.size)return null;
  const length=[...sections.values()].reduce((sum,e)=>sum+e.length,0),point=blockedPoints[0]+1,label=blockedPoints.length===1?`Zwischenpunkt ${point} liegt`:`Zwischenpunkte ${blockedPoints.map(i=>i+1).join(', ')} liegen`;
  return {code:'REQUIRED_RETURN',waypointIndex:point-1,blockedPoints,length,sections:[...sections.values()],
    message:`${label} im selben Teilnetz wie der Start, ${blockedPoints.length===1?'ist':'sind'} aber nur über ${sections.size===1?'ein Verbindungsstück':'Verbindungsstücke'} von insgesamt ${Math.round(length).toLocaleString('de-DE')} m angebunden. Im vorhandenen Datensatz muss diese Strecke hin und zurück befahren werden. Für eine Runde ohne doppelte Wege fehlt eine zweite unabhängige Anbindung. Die Kurzlücken-Prüfung ergänzt nur bestätigte Anschlüsse innerhalb ihrer eingestellten Grenze.`};
}

function inspectStartConnection(network,start,graph,bridges){
  if((graph.adj.get(graph.startId)||[]).some(s=>!bridges.has(s.edge.id)))return null;
  const issue={code:'START_NO_CYCLE',point:'start',message:'Am Start fehlt im importierten GPX-Netz ein Rundkursanschluss. Bitte den Start prüfen; die Zwischenpunkte sind dafür nicht die Ursache.',suggestion:null};
  const candidate=recommendedStart(network,start),nearest=nearestPoint(network,start);
  const startEdge=network.edges.find(e=>e.id===nearest.edgeId),candidateEdge=network.edges.find(e=>e.id===candidate?.edgeId);
  const components=new Map(network.nodes.map(n=>[n.id,n.component]));
  // Offer a separate, explicit change within the same imported component.
  // A tiny GPS loop around a meeting point is not a useful round-trip start.
  if(candidate&&candidate.distance>.5&&candidate.distance<=1000&&startEdge&&candidateEdge&&components.get(startEdge.u)===components.get(candidateEdge.u)){
    const trial=makeRoutingGraph(network,candidate.coord),trialBridges=findGraphBridges(trial.undirected);
    if((trial.adj.get(trial.startId)||[]).some(s=>!trialBridges.has(s.edge.id)))issue.suggestion={coord:candidate.coord,distance:candidate.distance};
  }
  return issue;
}

export function inspectRoundTripStart(network,start){
  if(!network||!start)return null;
  const graph=makeRoutingGraph(network,start);
  return inspectStartConnection(network,start,graph,findGraphBridges(graph.undirected));
}

export function generateRoutes(network, parameters = {}, progress = () => {}) {
  const target=clamp(Number(parameters.distanceKm||40),1,300)*1000;
  const options={...parameters,lengthTolerance:Number(parameters.lengthTolerance??.1)};
  const seed=String(parameters.seed??'randomizer'),random=seededRandom(seed),loop=parameters.mode!=='ab';
  const start=parameters.start||network.nodes[0]?.coord;
  if(!start)throw new Error('Bitte zuerst ein Wegenetz aufbauen.');
  if(!loop&&!parameters.end)throw new Error('Bitte einen Zielpunkt auf dem Wegenetz wählen.');
  const requestedWaypoints=parameters.waypoints??[];
  if(!Array.isArray(requestedWaypoints)||requestedWaypoints.length>8||requestedWaypoints.some(p=>!Array.isArray(p)||!Number.isFinite(p[0])||!Number.isFinite(p[1])))throw new Error('Bitte höchstens 8 gültige Zwischenpunkte setzen.');
  const graph=makeRoutingGraph(network,start,loop?null:parameters.end,requestedWaypoints);
  if(!loop&&graph.startId===graph.endId)throw new Error('Start und Ziel liegen am gleichen Netzpunkt.');
  const fixed=graph.waypointIds,protectedNodes=new Set(fixed),hasFixed=fixed.length>0;
  options.protectedNodes=protectedNodes;
  const distinct=new Set([graph.startId,graph.endId]);
  for(const [i,id]of fixed.entries()){
    if(distinct.has(id))throw new Error(`Zwischenpunkt ${i+1} liegt am Start, Ziel oder an einem bereits gesetzten Punkt. Bitte versetzen oder entfernen.`);
    distinct.add(id);
  }
  // Round trips cannot use graph bridges without an out-and-back excursion.
  // Keep the original network and its geometry intact for A→B and inspection.
  let excludedBridges=0;
  if(loop){const bridges=findGraphBridges(graph.undirected);excludedBridges=bridges.size;
    const issue=inspectStartConnection(network,start,graph,bridges);
    if(issue)throw Object.assign(new Error(issue.message),{code:issue.code});
    const connected=dijkstra({...graph,adj:graph.undirected},graph.startId).distances;
    for(const [i,id]of fixed.entries())if(!connected.has(id))throw new Error(`Zwischenpunkt ${i+1} liegt in einem anderen GPX-Teilnetz als der Start. Zwischen den Teilnetzen ist keine Verbindung importiert.`);
    const connectionIssue=requiredConnectionIssue(graph,bridges,fixed);
    if(connectionIssue)throw Object.assign(new Error(connectionIssue.message),{code:connectionIssue.code,details:{connectionIssue}});
    for(const adjacency of [graph.adj,graph.reverseAdj])for(const [id,steps]of adjacency)adjacency.set(id,steps.filter(s=>!bridges.has(s.edge.id)));
  }
  const toEnd=dijkstra({...graph,adj:graph.reverseAdj},graph.endId).distances;
  if(!toEnd.has(graph.startId)){
    if(dijkstra({...graph,adj:graph.undirected},graph.startId,graph.endId))throw new Error('Start und Ziel sind in der erlaubten Fahrtrichtung nicht verbunden. Bitte die Einbahnrichtungen prüfen.');
    throw new Error('Start und Ziel liegen in getrennten Teilnetzen. Bitte beide Punkte im gleichen Teilnetz wählen.');
  }
  const fromStart=dijkstra(graph,graph.startId).distances;
  for(const [i,id]of fixed.entries())if(!fromStart.has(id)||(loop&&!toEnd.has(id)))throw new Error(loop?`Zwischen Start und Zwischenpunkt ${i+1} fehlt ein Rundkursanschluss in den vorhandenen Wegen und Fahrtrichtungen. Bitte Verknüpfungen und Punkte prüfen.`:`Zwischenpunkt ${i+1} ist vom Start in der erlaubten Fahrtrichtung nicht erreichbar oder liegt in einem anderen Teilnetz.`);
  let shortest=loop?0:toEnd.get(graph.startId);
  if(hasFixed){shortest=0;let current=graph.startId;for(const id of [...fixed,graph.endId]){shortest+=dijkstra(graph,current,id).distance;current=id;}}
  const positions=new Map([...graph.nodes].map(([id,n])=>[id,project(n.coord,network.origin)]));
  const center=positions.get(graph.startId),candidates=[],seenPaths=new Set();
  const reachable=[...fromStart.keys()].filter(id=>id!==graph.startId&&id!==graph.endId&&(!loop||toEnd.has(id)));
  const pool=reachable.filter(id=>(graph.undirected.get(id)?.length||0)>=2&&(fromStart.get(id)||0)>Math.min(150,target*.04));
  const visitsFixed=path=>{
    let next=0;
    for(const step of path)if(step.to===fixed[next])next++;
    return next===fixed.length;
  };
  const add=(path,anchors=[])=>{
    if(!path||!visitsFixed(path))return;
    const signature=path.map(s=>`${s.edge.id}:${s.reverse?1:0}`).join(',');
    if(seenPaths.has(signature))return;seenPaths.add(signature);
    const result=summarizePath(path,graph,network.origin,target,options);
    if(result&&result.length>50&&visitsFixed(result._path))candidates.push({...result,waypoints:anchors.filter(id=>!protectedNodes.has(id)).map(id=>graph.nodes.get(id).coord)});
  };
  if(!loop&&!hasFixed)add(dijkstra(graph,graph.startId,graph.endId).path);
  if(!hasFixed)for(const step of graph.adj.get(graph.startId)||[])if(step.to===graph.startId)add([{...step,from:graph.startId}]);
  if(loop&&!hasFixed&&(graph.adj.get(graph.startId)?.length||0)===1){
    const step=graph.adj.get(graph.startId)[0];
    if(step.to!==graph.startId){const back=dijkstra(graph,step.to,graph.startId,s=>s.edge.id===step.edge.id?Infinity:s.edge.length);if(back)add([{...step,from:graph.startId},...back.path]);}
  }
  if(loop&&!reachable.length&&!candidates.length)throw new Error('Der Start liegt in einer Sackgasse oder auf einer reinen Zufahrt. Bitte einen Start auf einem Rundkurs wählen.');
  const edgeProfile=new Map(graph.edges.map(e=>[e.id,{
    forward:clamp(1-(options.hills||0)*e.ascent/Math.max(e.length,1)*14,.45,2.5),
    backward:clamp(1-(options.hills||0)*e.descent/Math.max(e.length,1)*14,.45,2.5),
    turns:clamp(1-(options.turns||0)*e.turns*9/Math.max(40,e.length),.6,1.7)
  }]));
  // The first leg has the same exclusions for every design. Its weighted
  // shortest-path tree is reusable across all waypoint proposals in a search.
  const noise=new Map(graph.edges.map(e=>[e.id,.85+random()*.3]));
  const baseCost=step=>{const p=edgeProfile.get(step.edge.id);return step.edge.length*noise.get(step.edge.id)*(step.reverse?p.backward:p.forward)*p.turns;};
  const outboundTree=hasFixed?null:dijkstra(graph,graph.startId,null,baseCost);
  const attempts=loop?(network.options.kind==='osm'&&target>=50000&&network.edges.length>1000?1280:640):240;
  let planned=0;
  const pickAnchor=(angle,radius,excluded)=>{
    const choices=[];
    for(const id of pool){
      if(excluded.has(id))continue;
      const distance=fromStart.get(id);if(distance>target*.65)continue;
      const p=positions.get(id),bearing=Math.atan2(p[1]-center[1],p[0]-center[0]);
      const score=Math.abs(distance-radius)/Math.max(100,radius)+angleDiff(bearing,angle)*1.3+random()*.16;
      choices.push({id,score});
    }
    choices.sort((a,b)=>a.score-b.score);
    return choices[Math.min(choices.length-1,Math.floor(random()*Math.min(5,choices.length)))]?.id;
  };
  for(let attempt=0;attempt<attempts;attempt++){
    if(!pool.length&&!hasFixed)break;
    const backwards=hasFixed&&loop&&attempt%2===1;
    const planningGraph=backwards?{...graph,adj:graph.reverseAdj}:graph;
    let anchors;
    if(hasFixed){
      anchors=backwards?[...fixed].reverse():[...fixed];
      // Direct designs and optional extra anchors search for the requested
      // length while preserving every user-selected stop and its order.
      if(attempt%3!==0&&pool.length){
        const choices=pool.filter(id=>!protectedNodes.has(id));
        const count=attempt%5===0?2:1;
        for(let k=0;k<count&&choices.length;k++){
          const index=Math.floor(random()*choices.length),id=choices.splice(index,1)[0];
          if(fromStart.get(id)>Math.max(target,shortest)*.65)continue;
          anchors.splice(Math.floor(random()*(anchors.length+1)),0,id);
        }
      }
    }else{
    const count=loop?(attempt%8===0?1:attempt%4===0?3:2):(attempt%3===0?2:1);
    const sampled=positions.get(pool[Math.floor(random()*pool.length)]);
    const initialAngle=Math.atan2(sampled[1]-center[1],sampled[0]-center[0]);
    const orientation=random()<.5?-1:1;
    const radius=target/(count===1?2.6:count===2?3.9:5)*[.7,.85,1,1.15,1.3][attempt%5];
    anchors=[];const chosen=new Set();
    for(let k=0;k<count;k++){
      const angle=initialAngle+orientation*k*(count===2?Math.PI*2/3:Math.PI/2)+(random()-.5)*.4;
      const id=pickAnchor(angle,radius,chosen);if(id===undefined)break;anchors.push(id);chosen.add(id);
    }
    if(anchors.length!==count)continue;
    }
    // Several fixed-stop designs use different edge weights so a greedy
    // first leg does not always consume the only usable onward connection.
    const manualNoise=hasFixed?new Map(graph.edges.map(e=>[e.id,attempt===0?1:.65+random()*.8])):null;
    const usedEdges=new Set(),usedNodes=new Set([graph.startId]),path=[];
    let current=graph.startId,failed=false,length=0;
    const destinations=[...anchors,graph.endId];
    for(const [legIndex,destination]of destinations.entries()){
      if(usedNodes.has(destination)&&destination!==graph.endId){failed=true;break;}
      const futureStops=hasFixed?new Set(destinations.slice(legIndex+1)):null;
      const cost=step=>{
        if(usedEdges.has(step.edge.id)||(!hasFixed&&usedNodes.has(step.to)&&step.to!==destination)||(futureStops?.has(step.to)&&step.to!==destination&&!(loop&&step.to===graph.startId)))return Infinity;
        return baseCost(backwards?{...step,reverse:!step.reverse}:step)*(manualNoise?.get(step.edge.id)??1);
      };
      const cachedFirst=outboundTree&&current===graph.startId&&!path.length?unpackShortest(outboundTree,current,destination):null;
      const leg=cachedFirst?{path:cachedFirst}:dijkstra(planningGraph,current,destination,cost);
      if(!leg){failed=true;break;}
      for(const step of leg.path){path.push(step);usedEdges.add(step.edge.id);usedNodes.add(step.to);length+=step.edge.length;}
      current=destination;
      if(length>Math.max(target*1.8,shortest*1.3)){failed=true;break;}
    }
    if(!failed&&current===graph.endId){planned++;add(backwards?[...path].reverse().map(s=>({...s,from:s.to,to:s.from,reverse:!s.reverse})):path,backwards?[...anchors].reverse():anchors);}
    if(attempt%25===0)progress({stage:hasFixed?'Deine Zwischenpunkte in Reihenfolge verbinden':'Zwischenziele nach Richtung und Netzentfernung verbinden',percent:Math.round(attempt/attempts*85)});
  }
  candidates.sort((a,b)=>a.score-b.score);
  progress({stage:'Streckenführung und gemeinsame Kilometer prüfen',percent:90});
  const refined=[],shortestTrees=new Map(),qualityFailures=[];
  for(const candidate of candidates){
    const polished=removeLocalDetours(candidate._path,graph,shortestTrees,protectedNodes);
    const c=summarizePath(polished.path,graph,network.origin,target,options);if(!c)continue;
    if(!visitsFixed(c._path))continue;
    let walked=0;const verifiedRanges=[];for(const step of c._path){const begin=walked;walked+=step.edge.length;if(network.options.kind==='osm'&&!step.edge.unclear)verifiedRanges.push([begin,walked]);}
    const quality=inspectRouteGeometry(c.geometry,network.origin,network.options.tolerance,{protectedCoords:hasFixed?fixed.map(id=>graph.nodes.get(id).coord):[],verifiedRanges});
    if(!quality.acceptable){qualityFailures.push(quality);continue;}
    // Recovered path can omit an anchor after a legitimate local shortening.
    const visited=new Set(c.traversals.map(t=>t.from));
    const waypoints=candidate.waypoints.filter(p=>[...visited].some(id=>dist(positions.get(id),project(p,network.origin))<1));
    delete c._path;
    refined.push({...c,quality,waypoints,manualWaypoints:fixed.map(id=>graph.nodes.get(id).coord),strategy:hasFixed?'fixed-waypoints':'sector-waypoints',removedDetourMeters:polished.removed});
  }
  refined.sort((a,b)=>Number(b.error<=options.lengthTolerance)-Number(a.error<=options.lengthTolerance)||a.score-b.score);
  const selected=[];
  for(const c of refined){
    if(selected.some(p=>routeOverlap(p,c)>.85))continue;
    selected.push({...c,seed,withinTolerance:c.error<=options.lengthTolerance,id:selected.length,...(network.attribution?{attribution:network.attribution}:{})});
    if(selected.length===3)break;
  }
  if(!selected.length)throw Object.assign(new Error(hasFixed?'Keine geeignete Route über alle gesetzten Punkte in dieser Reihenfolge gefunden. Bitte Reihenfolge, Punkte oder Wunschlänge ändern; Sackgassen und problematische Rückwege bleiben ausgeschlossen.':'Keine geeignete Runde aus verteilten Zwischenzielen gefunden. Bitte Ziellänge oder Startpunkt ändern; ein Start in einer Sackgasse ist für Rundtouren ungeeignet.'),{details:{planned,candidates:candidates.length,qualityFailures:qualityFailures.slice(0,10)}});
  if(loop&&selected[0].length<target*.3)throw new Error('Am gewählten Start wurde nur eine sehr kurze Runde gefunden. Bitte einen Start auf einem größeren Rundkurs wählen oder die Wunschlänge verkürzen.');
  progress({stage:'Routenvorschläge bereit',percent:100});
  return {routes:selected,seed,target,shortest,mode:loop?'loop':'ab',start:graph.nodes.get(graph.startId).coord,end:graph.nodes.get(graph.endId).coord,
    attempts,candidates:candidates.length,lengthTolerance:options.lengthTolerance,search:{strategy:hasFixed?'fixed-waypoints':'sector-waypoints',planned,refined:refined.length,excludedBridges}};
}

export function toGPX(route, name = 'GPX Randomizer') {
  const escape = s => String(s).replace(/[<>&'\"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'}[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GPX Randomizer MVP" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${escape(name)}</name><desc>Seed: ${escape(route.seed)}; Länge: ${(route.length / 1000).toFixed(2)} km${route.pushingLength?'; mögliche Schiebepassagen: '+Math.round(route.pushingLength)+' m':''}${route.uncertainLength?'; ungeprüfte Original-GPX-Wege: '+Math.round(route.uncertainLength)+' m':''}${route.restrictedLength?'; OSM-Zugang eingeschränkt: '+Math.round(route.restrictedLength)+' m, vor Fahrt prüfen':''}${route.connectionLength?'; gezielte OSM-Ergänzung: '+Math.round(route.connectionLength)+' m':''}${route.attribution?'; Wegenetz: © OpenStreetMap-Mitwirkende, ODbL 1.0, https://www.openstreetmap.org/copyright':''}</desc></metadata><trk><name>${escape(name)}</name><trkseg>\n`
    + route.geometry.map(p => `<trkpt lat="${p[1].toFixed(7)}" lon="${p[0].toFixed(7)}">${finiteZ(p[2]) ? `<ele>${p[2].toFixed(2)}</ele>` : ''}</trkpt>`).join('\n')
    + '\n</trkseg></trk></gpx>';
}

export function networkGeoJSON(network) {
  return {type: 'FeatureCollection',...(network.attribution?{attribution:network.attribution}:{}),features: [
    ...network.edges.map(e => ({type: 'Feature', properties: {type: 'section', id: e.id, connection_ids:e.connectionIds||[], from: e.u, to: e.v, length_m: Math.round(e.length), sources: e.sources.map(i => network.routes[i]?.name),...(e.osmWayIds?{osm_way_ids:e.osmWayIds,forward:e.forward,backward:e.backward,pushing:!!e.pushing,restricted:!!e.restricted,unclear:!!e.unclear}:{} )}, geometry: {type: 'LineString', coordinates: e.geometry.map(p => p.slice(0, 2))}})),
    ...network.nodes.map(n => ({type: 'Feature', properties: {type: 'node', id: n.id, degree: n.degree, kind: n.kind, component: n.component}, geometry: {type: 'Point', coordinates: n.coord.slice(0, 2)}}))]};
}
