import {geometryKey,missingReferenceSamples} from "./osm.js";

let database=null,extra={nodes:{},ways:[],matches:{}};
async function db(){
  if(database)return database;
  database=await new Promise((resolve,reject)=>{const r=indexedDB.open('gpx-randomizer-osm',1);r.onupgradeneeded=()=>r.result.createObjectStore('reference');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return database;
}
async function cache(action,key,value){
  try{const database=await db();return await new Promise((resolve,reject)=>{const tx=database.transaction('reference',action==='get'?'readonly':'readwrite'),store=tx.objectStore('reference');const request=action==='get'?store.get(key):store.put(value,key);let result;request.onsuccess=()=>result=request.result;request.onerror=()=>reject(request.error);tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);});}catch{return null;}
}
export async function loadReference(base){
  extra=await cache('get',base.preparedAt)||{nodes:{},ways:[],matches:{}};
  const ids=new Set(base.ways.map(w=>w.id));
  return {...base,nodes:{...base.nodes,...extra.nodes},ways:[...base.ways,...extra.ways.filter(w=>!ids.has(w.id))],matches:{...base.matches,...extra.matches}};
}
export async function saveMatches(reference,matches){
  if(!matches||!Object.keys(matches).length)return;
  Object.assign(reference.matches,matches);Object.assign(extra.matches,matches);await cache('put',reference.preparedAt,extra);
}
export function queriesForTracks(routes){
  const queries=[];
  for(const route of routes)for(const part of route.segments){
    const sampled=[];let walked=0;
    for(let i=0;i<part.length;i++){
      if(i){const a=part[i-1],b=part[i];walked+=Math.hypot((b[0]-a[0])*Math.cos(b[1]*Math.PI/180)*111195,(b[1]-a[1])*111195);}
      if(!sampled.length||walked>=35||i===part.length-1){sampled.push(part[i]);walked=0;}
    }
    for(let i=0;i<sampled.length;i+=249){const batch=sampled.slice(i,i+250);if(!batch.length)continue;
      const coords=batch.map(p=>`${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(',');
      queries.push(`[out:json][timeout:25];way(around:60,${coords})["highway"];out body geom;`);
    }
  }return queries;
}
export async function ensureReference(routes,reference,progress=()=>{}){
  const unknown=routes.filter(r=>!reference.matches[geometryKey(r)]);
  if(!unknown.length||!missingReferenceSamples(unknown,reference,40).length)return reference;
  const queries=queriesForTracks(unknown),known=new Set(reference.ways.map(w=>w.id)),added=[];
  for(let i=0;i<queries.length;i++){
    progress(`OSM-Kartendaten für neue Tracks laden · ${i+1} / ${queries.length}`);
    let data=null,lastError;
    for(let attempt=0;attempt<2;attempt++){
      try{
        if(attempt)await new Promise(resolve=>setTimeout(resolve,1800));
        const response=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:new URLSearchParams({data:queries[i]}),signal:AbortSignal.timeout(32000)});
        if(!response.ok)throw new Error(`OSM-Dienst antwortet mit HTTP ${response.status}`);
        data=await response.json();if(data.remark)throw new Error(data.remark);break;
      }catch(error){lastError=error;}
    }
    if(!data)throw new Error(`OSM-Daten konnten nicht geladen werden. Bitte später erneut versuchen oder „GPX-Näherung“ wählen. ${lastError?.name==='TimeoutError'?'Der OSM-Dienst ist ausgelastet.':lastError?.message||''}`);
    for(const way of data.elements||[]){
      if(way.type!=='way'||known.has(way.id)||!way.nodes||way.nodes.length!==way.geometry?.length)continue;
      known.add(way.id);const compact={id:way.id,nodes:way.nodes,tags:way.tags||{},version:way.version};added.push(compact);
      way.nodes.forEach((id,j)=>{if(!reference.nodes[id]){const point=[way.geometry[j].lon,way.geometry[j].lat];reference.nodes[id]=point;extra.nodes[id]=point;}});
    }
    if(i<queries.length-1)await new Promise(resolve=>setTimeout(resolve,1100));
  }
  reference.ways.push(...added);extra.ways.push(...added);await cache('put',reference.preparedAt,extra);return reference;
}
