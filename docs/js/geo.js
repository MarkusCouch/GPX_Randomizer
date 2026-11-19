/* Shared meter geometry; no network or browser dependencies. */
export const R = 6371008.8, RAD = Math.PI / 180;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const finiteZ = z => Number.isFinite(z);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
  finiteZ(a[2]) && finiteZ(b[2]) ? a[2] + (b[2] - a[2]) * t : null];

export function projection(routes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of routes) for (const part of r.segments) for (const p of part) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!Number.isFinite(minX)) throw new Error('Keine gültigen GPX-Punkte gefunden.');
  return {lon: (minX + maxX) / 2, lat: (minY + maxY) / 2};
}
export function project(p, origin) {
  return [(p[0] - origin.lon) * RAD * R * Math.cos(origin.lat * RAD), (p[1] - origin.lat) * RAD * R, p[2] ?? null];
}
export function unproject(p, origin) {
  return [p[0] / (RAD * R * Math.cos(origin.lat * RAD)) + origin.lon, p[1] / (RAD * R) + origin.lat, p[2] ?? null];
}
export function foot(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  const q = lerp(a, b, t);
  return {t, p: q, d: dist(p, q)};
}
export function lineLength(points) {let l = 0; for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]); return l;}
export function angleDiff(a, b) {let d = (a - b + Math.PI * 3) % (Math.PI * 2) - Math.PI; return Math.abs(d);}
export function ascent(points) {
  // Sample every 50 m and smooth over 150 m, instead of discarding every
  // shallow rise with a vertical threshold. Missing height breaks a run.
  let total=0,run=[];
  const sum=()=>{if(run.length<2){run=[];return;}const sm=run.map((z,i)=>{const q=run.slice(Math.max(0,i-1),Math.min(run.length,i+2));return q.reduce((a,b)=>a+b,0)/q.length;});
    if(dist(points[0],points.at(-1))<.5)sm[sm.length-1]=sm[0];
    for(let i=1;i<sm.length;i++)total+=Math.max(0,sm[i]-sm[i-1]);run=[];};
  let carry=0;
  for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];
    if(!finiteZ(a[2])||!finiteZ(b[2])){sum();carry=0;continue;}
    if(!run.length)run.push(a[2]);const length=dist(a,b);
    for(let d=50-carry;d<=length;d+=50)run.push(a[2]+(b[2]-a[2])*d/(length||1));carry=(carry+length)%50;
    if(i===points.length-1)run.push(b[2]);
  }sum();return total;
}

export function countTurns(points) {
  let prev = null, anchor = points[0], turns = 0;
  for (let i = 1; i < points.length; i++) {
    if (dist(anchor, points[i]) < 25) continue;
    const bearing = Math.atan2(points[i][1] - anchor[1], points[i][0] - anchor[0]);
    if (prev !== null && angleDiff(prev, bearing) > 35 * RAD) turns++;
    prev = bearing; anchor = points[i];
  }
  return turns;
}

