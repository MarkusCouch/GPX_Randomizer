import {RAD,clamp,finiteZ,dist,lerp,projection,project,unproject,foot,lineLength,ascent,countTurns} from "./geo.js";

export function geometryKey(route){
  const text=JSON.stringify(route.segments);let a=2166136261,b=3335557771;
  for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),2246822519);}
  return `${(a>>>0).toString(16)}-${(b>>>0).toString(16)}-${text.length}`;
}
export function decodePolyline(text,precision=6){
  const out=[];let index=0,lat=0,lon=0;
  const read=()=>{let value=0,shift=0,byte;do{byte=text.charCodeAt(index++)-63;value+=(byte&31)*2**shift;shift+=5;}while(byte>=32&&index<text.length);return value%2?-(value+1)/2:value/2;};
  while(index<text.length){lat+=read();lon+=read();out.push([lon/10**precision,lat/10**precision]);}return out;
}

export function wayAccess(tags={}){
  const bike=tags.bicycle,allowed=['yes','designated','official','permissive','destination','dismount'];
  if(['no','private','use_sidepath'].includes(bike))return null;
  if(['no','private'].includes(tags.access)&&!allowed.includes(bike))return null;
  if(['motorway','motorway_link','construction','proposed','platform','raceway'].includes(tags.highway))return null;
  if(!tags.highway)return null;
  const pushing=bike==='dismount'||tags.highway==='steps'||(['footway','pedestrian'].includes(tags.highway)&&!allowed.includes(bike));
  if(pushing&&['no','private'].includes(tags.foot))return null;
  const override=tags['oneway:bicycle'];
  const contrary=override==='no'||tags['bicycle:backward']==='yes'||Object.entries(tags).some(([k,v])=>k.startsWith('cycleway')&&String(v).startsWith('opposite'));
  const one=pushing?(tags['oneway:foot']??'no'):contrary?'no':override??tags.oneway??(tags.junction==='roundabout'?'yes':'no');
  const result={forward:one!=='-1'&&!['no','private','use_sidepath'].includes(tags['bicycle:forward']),backward:!['yes','1','true'].includes(one)&&!['no','private','use_sidepath'].includes(tags['bicycle:backward'])};
  if(!result.forward&&!result.backward)return null;
  return pushing?{...result,pushing:true}:result;
}

export function createReferenceIndex(reference,origin,options={}){
  const segments=new Map(),grid=new Map(),adj=new Map(),cellSize=80;
  const node=id=>reference.nodes[String(id)];
  for(const way of reference.ways){
    const legalAccess=wayAccess(way.tags);let access=legalAccess;
    if(!access&&options.respectAccess!==true){
      access=wayAccess({...way.tags,bicycle:'yes',access:'yes',foot:'yes','bicycle:forward':undefined,'bicycle:backward':undefined});
      if(access){access={...access,restricted:true};if(['footway','pedestrian','steps'].includes(way.tags.highway))access.pushing=true;}
    }
    if(!access||access.pushing&&options.allowPushing===false)continue;
    for(let i=0;i<way.nodes.length-1;i++){
      const pa=node(way.nodes[i]),pb=node(way.nodes[i+1]);if(!pa||!pb)continue;
      const a=project(pa,origin),b=project(pb,origin),length=Math.max(.001,dist(a,b));if(length>10000)continue;
      const s={key:`${way.id}/${i}`,wayId:way.id,index:i,u:`n/${way.nodes[i]}`,v:`n/${way.nodes[i+1]}`,a,b,length,...access,tags:way.tags};segments.set(s.key,s);
      for(const id of [s.u,s.v])if(!adj.has(id))adj.set(id,[]);
      if(s.forward)adj.get(s.u).push({to:s.v,s,reverse:false});if(s.backward)adj.get(s.v).push({to:s.u,s,reverse:true});
      for(let x=Math.floor(Math.min(a[0],b[0])/cellSize);x<=Math.floor(Math.max(a[0],b[0])/cellSize);x++)for(let y=Math.floor(Math.min(a[1],b[1])/cellSize);y<=Math.floor(Math.max(a[1],b[1])/cellSize);y++){
        const key=`${x},${y}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(s);
      }
    }
  }
  return {reference,origin,segments,grid,adj,cellSize,allowPushing:options.allowPushing!==false,respectAccess:options.respectAccess===true};
}

function candidatesAt(index,p,radius,heading=null){
  const found=[],seen=new Set(),cs=index.cellSize;
  for(let x=Math.floor((p[0]-radius)/cs);x<=Math.floor((p[0]+radius)/cs);x++)for(let y=Math.floor((p[1]-radius)/cs);y<=Math.floor((p[1]+radius)/cs);y++)for(const s of index.grid.get(`${x},${y}`)||[]){
    if(seen.has(s.key))continue;seen.add(s.key);const f=foot(p,s.a,s.b);if(f.d>radius)continue;
    for(const direction of [1,-1]){
      if(direction===1&&!s.forward||direction===-1&&!s.backward)continue;
      const angle=Math.atan2((s.b[1]-s.a[1])*direction,(s.b[0]-s.a[0])*direction);
      found.push({s,t:f.t,p:f.p,d:f.d,direction,emission:(f.d/Math.max(4,radius/3))**2+(heading===null?0:(1-Math.cos(angle-heading))*.8)});
    }
  }
  return found.sort((a,b)=>a.emission-b.emission).slice(0,6);
}
export function missingReferenceSamples(routes,reference,radius=40){
  const origin=projection(routes),index=createReferenceIndex(reference,origin),samples=[];
  for(const route of routes){if(reference.matches?.[geometryKey(route)])continue;
    for(const part of route.segments)for(let i=0;i<part.length;i+=4)if(!candidatesAt(index,project(part[i],origin),radius).length)samples.push(part[i]);
  }return samples;
}

class Heap{
  constructor(){this.a=[];}push(x){let i=this.a.length;this.a.push(x);while(i){const p=(i-1)>>1;if(this.a[p][0]<=x[0])break;this.a[i]=this.a[p];i=p;}this.a[i]=x;}
  pop(){const first=this.a[0],last=this.a.pop();if(this.a.length){let i=0;while(i*2+1<this.a.length){let j=i*2+1;if(j+1<this.a.length&&this.a[j+1][0]<this.a[j][0])j++;if(this.a[j][0]>=last[0])break;this.a[i]=this.a[j];i=j;}this.a[i]=last;}return first;}
}
function localTree(index,from,budget){
  const distances=new Map([[from,0]]),previous=new Map(),heap=new Heap();heap.push([0,from]);let visited=0;
  while(heap.a.length&&visited++<6000){const [d,id]=heap.pop();if(d>distances.get(id)||d>budget)continue;
    for(const step of index.adj.get(id)||[]){const next=d+step.s.length;if(next<=budget&&next<(distances.get(step.to)??Infinity)){distances.set(step.to,next);previous.set(step.to,{...step,from:id});heap.push([next,step.to]);}}
  }return {distances,previous};
}
function transition(index,a,b,budget,trees){
  if(a.s.key===b.s.key&&a.direction===b.direction&&(b.t-a.t)*a.direction>=-1e-8)return {length:Math.abs(b.t-a.t)*a.s.length,ranges:[[a.s.key,Math.min(a.t,b.t),Math.max(a.t,b.t),a.direction===1]]};
  const from=a.direction===1?a.s.v:a.s.u,to=b.direction===1?b.s.u:b.s.v;
  const end=a.direction===1?1:0,begin=b.direction===1?0:1;
  const first=Math.abs(end-a.t)*a.s.length,last=Math.abs(b.t-begin)*b.s.length;
  if(first+last>budget)return null;
  if(!trees.has(from))trees.set(from,localTree(index,from,budget));const tree=trees.get(from),middle=tree.distances.get(to);if(middle===undefined||first+middle+last>budget)return null;
  const path=[];let current=to;
  while(current!==from){const s=tree.previous.get(current);if(!s)return null;path.push(s);current=s.from;}
  path.reverse();
  // The connector must not consume an entire candidate edge in addition to
  // its partial use; that would manufacture a local return or a lap.
  if(path.some(s=>s.s.key===a.s.key||s.s.key===b.s.key))return null;
  return {length:first+middle+last,ranges:[[a.s.key,Math.min(a.t,end),Math.max(a.t,end),a.direction===1],...path.map(s=>[s.s.key,0,1,!s.reverse]),[b.s.key,Math.min(begin,b.t),Math.max(begin,b.t),b.direction===1]]};
}

export function matchRouteLocally(route,index,radius=30){
  const coverage=[],uncertain=[],offsets=[],fallbacks=[];let matched=0,total=0;
  for(const [partIndex,input]of route.segments.entries()){
    // Keep real turns and endpoints while avoiding redundant stationary fixes.
    const points=[];for(const [inputIndex,p]of input.entries()){const q=project(p,index.origin);if(!points.length||dist(points.at(-1).q,q)>=3||inputIndex===input.length-1)points.push({p,q,inputIndex});}
    const chains=[];
    let states=[],last=null;
    const flush=()=>{
      if(!states.length)return;let best=states.reduce((a,b)=>a.cost<b.cost?a:b);const chain=[];while(best){chain.push(best);best=best.prev;}chain.reverse();
      chains.push(chain);
      for(const state of chain){matched++;offsets.push(state.c.d);if(!state.link)continue;
        const z0=state.prev.point.p[2],z1=state.point.p[2];let walked=0;
        for(const [key,lo,hi,forward]of state.link.ranges){const s=index.segments.get(key),length=(hi-lo)*s.length;if(hi-lo<1e-9)continue;
          const a=walked/Math.max(.001,state.link.length),b=(walked+length)/Math.max(.001,state.link.length);
          const za=finiteZ(z0)&&finiteZ(z1)?z0+(z1-z0)*a:null,zb=finiteZ(z0)&&finiteZ(z1)?z0+(z1-z0)*b:null;
          coverage.push([key,lo,hi,forward?za:zb,forward?zb:za,partIndex]);walked+=length;
        }
      }states=[];
    };
    for(let i=0;i<points.length;i++){
      total++;const point=points[i],next=points[Math.min(i+1,points.length-1)],previous=points[Math.max(0,i-1)];
      const dx=next.q[0]-previous.q[0],dy=next.q[1]-previous.q[1],heading=Math.hypot(dx,dy)>5?Math.atan2(dy,dx):null;
      const choices=candidatesAt(index,point.q,radius,heading);
      if(!choices.length){
        if(i)uncertain.push([points[i-1].p,point.p]);
        // A noisy fix must not sever a valid OSM path. Keep the last states
        // for at most 250 m; any later connection still needs a legal OSM path.
        if(last&&dist(last.q,point.q)>250){flush();last=null;}continue;
      }
      if(!states.length){states=choices.map(c=>({c,cost:c.emission,prev:null,point,link:null}));last=point;continue;}
      const observed=dist(last.q,point.q),budget=Math.max(100,observed*2.5+radius*2),trees=new Map(),newStates=[];
      if(observed<2000)for(const c of choices){let best=null;
        for(const prev of states){const link=transition(index,prev.c,c,budget,trees);if(!link)continue;
          const cost=prev.cost+c.emission+Math.abs(link.length-observed)/Math.max(15,observed)*3;
          if(!best||cost<best.cost)best={c,cost,prev,point,link};
        }if(best)newStates.push(best);
      }
      if(!newStates.length){
        uncertain.push([last.p,point.p]);
        flush();states=choices.map(c=>({c,cost:c.emission,prev:null,point,link:null}));
      }
      else{const min=Math.min(...newStates.map(s=>s.cost));for(const s of newStates)s.cost-=min;states=newStates;}
      last=point;
    }flush();
    const anchor=state=>state?{key:state.c.s.key,t:state.c.t,z:state.point.p[2]}:null;
    const addFallback=(lo,hi,a,b)=>{
      if(hi<=lo)return;const geometry=input.slice(lo,hi+1).map(p=>[...p]);
      if(geometry.some((p,i)=>i&&dist(project(p,index.origin),project(geometry[i-1],index.origin))>500))return;
      if(a)geometry[0]=unproject([...a.c.p,a.point.p[2]],index.origin);if(b)geometry[geometry.length-1]=unproject([...b.c.p,b.point.p[2]],index.origin);
      fallbacks.push({geometry,from:anchor(a),to:anchor(b),part:partIndex});
    };
    if(!chains.length)addFallback(0,input.length-1,null,null);
    else{
      const first=chains[0][0];addFallback(0,first.point.inputIndex,null,first);
      for(let i=1;i<chains.length;i++){const a=chains[i-1].at(-1),b=chains[i][0];addFallback(a.point.inputIndex,b.point.inputIndex,a,b);}
      const last=chains.at(-1).at(-1);addFallback(last.point.inputIndex,input.length-1,last,null);
    }
  }
  const match={coverage,uncertain,fallbacks,matchedPoints:matched,totalPoints:total,unmatchedPoints:total-matched,meanOffset:offsets.reduce((a,b)=>a+b,0)/Math.max(1,offsets.length),method:'local-sequence',radius,allowPushing:index.allowPushing,respectAccess:index.respectAccess};
  completeOSMGaps(route,index,match,radius);
  const remaining=[];
  for(const span of fallbacks){
    const a=span.from&&index.segments.get(span.from.key),b=span.to&&index.segments.get(span.to.key);if(!a||!b){remaining.push(span);continue;}
    const source=span.geometry.map(p=>project(p,index.origin)),observed=lineLength(source),budget=Math.min(500,Math.max(80,observed*1.6+30));let best=null;
    for(const ad of [1,-1])for(const bd of [1,-1]){
      if(ad===1&&!a.forward||ad===-1&&!a.backward||bd===1&&!b.forward||bd===-1&&!b.backward)continue;
      const link=transition(index,{s:a,t:span.from.t,direction:ad},{s:b,t:span.to.t,direction:bd},budget,new Map());if(!link)continue;
      const near=link.ranges.every(([key,lo,hi])=>{const s=index.segments.get(key),count=Math.ceil((hi-lo)*s.length/15);for(let i=0;i<=count;i++){const p=lerp(s.a,s.b,lo+(hi-lo)*i/Math.max(1,count));if(!source.slice(1).some((q,j)=>foot(p,source[j],q).d<=radius))return false;}return true;});
      if(near&&(!best||link.length<best.length))best=link;
    }
    if(!best){remaining.push(span);continue;}
    let walked=0;const z0=span.from.z,z1=span.to.z;
    for(const [key,lo,hi,forward]of best.ranges){const s=index.segments.get(key),length=(hi-lo)*s.length;if(hi-lo<1e-9)continue;const za=finiteZ(z0)&&finiteZ(z1)?z0+(z1-z0)*walked/Math.max(.001,best.length):null;walked+=length;const zb=finiteZ(z0)&&finiteZ(z1)?z0+(z1-z0)*walked/Math.max(.001,best.length):null;coverage.push([key,lo,hi,forward?za:zb,forward?zb:za,span.part]);}
  }
  match.fallbacks=remaining;return match;
}

// Close only short, real OSM connections inside the same recorded GPX segment.
// This repairs missing turns/crossings, never a straight line between fixes.
export function completeOSMGaps(route,index,match,radius=30){
  const additions=[];let repaired=0;
  for(const [partIndex,input]of route.segments.entries()){
    const ranges=new Map(),seeds=new Set(),heights=new Map(),cells=new Map(),cs=80,parent=new Map(),neighbors=new Map();
    const root=id=>{if(!parent.has(id))parent.set(id,id);while(parent.get(id)!==id){parent.set(id,parent.get(parent.get(id)));id=parent.get(id);}return id;};
    for(const r of match.coverage){if((r[5]??0)!==partIndex)continue;const s=index.segments.get(r[0]);if(!s)continue;
      if(!ranges.has(s.key))ranges.set(s.key,[]);ranges.get(s.key).push(r);
      if(r[1]*s.length<.75){seeds.add(s.u);if(finiteZ(r[3]))heights.set(s.u,r[3]);}
      if((1-r[2])*s.length<.75){seeds.add(s.v);if(finiteZ(r[4]))heights.set(s.v,r[4]);}
      const a=r[1]*s.length<.75?s.u:`p/${s.key}/${r[1].toFixed(6)}`,b=(1-r[2])*s.length<.75?s.v:`p/${s.key}/${r[2].toFixed(6)}`;
      parent.set(root(a),root(b));for(const [u,v]of [[a,b],[b,a]]){if(!neighbors.has(u))neighbors.set(u,new Set());neighbors.get(u).add(v);}
    }
    const source=input.map(p=>project(p,index.origin));
    for(let i=1;i<source.length;i++){const a=source[i-1],b=source[i];
      for(let x=Math.floor((Math.min(a[0],b[0])-radius)/cs);x<=Math.floor((Math.max(a[0],b[0])+radius)/cs);x++)for(let y=Math.floor((Math.min(a[1],b[1])-radius)/cs);y<=Math.floor((Math.max(a[1],b[1])+radius)/cs);y++){
        const k=`${x},${y}`;if(!cells.has(k))cells.set(k,[]);cells.get(k).push({a,b});
      }
    }
    const nearCache=new Map(),near=s=>{
      if(nearCache.has(s.key))return nearCache.get(s.key);let okay=true;
      const count=Math.ceil(s.length/15);for(let i=0;i<=count&&okay;i++){
        const p=lerp(s.a,s.b,i/Math.max(1,count)),c=cells.get(`${Math.floor(p[0]/cs)},${Math.floor(p[1]/cs)}`)||[];
        okay=c.some(g=>foot(p,g.a,g.b).d<=radius);
      }nearCache.set(s.key,okay);return okay;
    };
    const full=s=>{const r=ranges.get(s.key);if(!r)return false;const sorted=[...r].sort((a,b)=>a[1]-b[1]);let hi=0;for(const v of sorted){if((v[1]-hi)*s.length>.75)return false;hi=Math.max(hi,v[2]);}return (1-hi)*s.length<.75;};
    for(const seed of seeds){
      const heap=new Heap(),best=new Map([[seed,0]]);heap.push([0,{id:seed,path:[]}]);let visited=0;
      while(heap.a.length&&visited++<500){
        const [distance,state]=heap.pop();if(distance>best.get(state.id))continue;
        for(const step of index.adj.get(state.id)||[]){const s=step.s,next=distance+s.length;
          if(next>100||full(s)||!near(s)||state.path.some(p=>p.s.key===s.key)||next>=(best.get(step.to)??Infinity))continue;
          const path=[...state.path,step];best.set(step.to,next);
          if(seeds.has(step.to)){
            if(step.to===seed)continue;
            if(root(seed)===root(step.to)&&(neighbors.get(seed)?.size||0)>1&&(neighbors.get(step.to)?.size||0)>1)continue;
            const z0=heights.get(seed),z1=heights.get(step.to);let walked=0;
            for(const piece of path){const za=finiteZ(z0)&&finiteZ(z1)?z0+(z1-z0)*walked/next:null;walked+=piece.s.length;const zb=finiteZ(z0)&&finiteZ(z1)?z0+(z1-z0)*walked/next:null;
              additions.push([piece.s.key,0,1,piece.reverse?zb:za,piece.reverse?za:zb,partIndex]);
            }repaired++;continue;
          }
          heap.push([next,{id:step.to,path}]);
        }
      }
    }
  }
  match.coverage.push(...additions);match.repairedConnections=repaired;
}

// One conservative pass over the original degree-one endpoints. Positions and
// identities stay unchanged: only an unoccupied, unique OSM path is inserted.
export function repairOSMDeadEnds(nodes,edges,index,requestedLimit=10){
  const limit=clamp(Number.isFinite(Number(requestedLimit))?Number(requestedLimit):10,0,30);
  const report={limit,candidates:0,connections:[],rejected:{}};
  const reject=reason=>report.rejected[reason]=(report.rejected[reason]||0)+1;
  if(!limit)return report;
  const occupied=new Map(),partialNodes=new Map();
  const occupy=r=>{if(!occupied.has(r.key))occupied.set(r.key,[]);occupied.get(r.key).push(r);};
  for(const e of edges)if(e.osmRange)occupy(e.osmRange);
  const anchor=n=>{
    if(n.key.startsWith('n/')&&index.adj.has(n.key))return {node:n.key};
    const parts=n.key.split('/');if(parts[0]!=='p')return null;
    const s=index.segments.get(`${parts[1]}/${parts[2]}`);if(!s)return null;
    const f=foot(n.p,s.a,s.b);if(f.d>.001)return null;return {s,t:f.t};
  };
  for(const n of nodes.values()){const a=anchor(n);if(a?.s){if(!partialNodes.has(a.s.key))partialNodes.set(a.s.key,[]);partialNodes.get(a.s.key).push({key:n.key,t:a.t});}}
  const ends=[...nodes.values()].filter(n=>n.edges.length===1&&!edges[n.edges[0]].unclear&&!edges[n.edges[0]].restricted).map(n=>({n,a:anchor(n),edge:edges[n.edges[0]]})).filter(e=>e.a);
  const pairParts=(a,b)=>[...(a.edge.parts||[])].some(x=>[...(b.edge.parts||[])].some(y=>x===y||x.split('/')[0]!==y.split('/')[0]));
  const proposals=[];
  for(let i=0;i<ends.length;i++)for(let j=i+1;j<ends.length;j++){
    const a=ends[i],b=ends[j],direct=dist(a.n.p,b.n.p);if(a.edge.id===b.edge.id||direct>limit+1e-7)continue;report.candidates++;
    if(!pairParts(a,b)){reject('separateGPXSegments');continue;}
    if(finiteZ(a.n.p[2])&&finiteZ(b.n.p[2])&&Math.abs(a.n.p[2]-b.n.p[2])>8){reject('height');continue;}
    const allowed=(r,excluded)=>{
      const {s,lo,hi}=r;if(hi-lo<1e-9)return true;
      if(s.key===excluded||s.restricted)return false;
      if((occupied.get(s.key)||[]).some(v=>(Math.min(v.hi,hi)-Math.max(v.lo,lo))*s.length>.001))return false;
      if((partialNodes.get(s.key)||[]).some(v=>v.key!==a.n.key&&v.key!==b.n.key&&v.t>lo+1e-8&&v.t<hi-1e-8))return false;
      for(const [t,key]of [[0,s.u],[1,s.v]])if(t>=lo-1e-8&&t<=hi+1e-8&&key!==a.n.key&&key!==b.n.key&&nodes.get(key)?.edges.length)return false;
      return true;
    };
    const find=(from,to,excluded=null)=>{
      const range=(s,lo,hi,forward)=>({s,lo:Math.min(lo,hi),hi:Math.max(lo,hi),forward});
      const ports=(end,depart)=>{
        if(end.a.node)return [{node:end.a.node,length:0,ranges:[]}];
        const {s,t}=end.a,out=[];
        if(depart?s.backward:s.forward)out.push({node:s.u,length:t*s.length,ranges:[range(s,0,t,!depart)]});
        if(depart?s.forward:s.backward)out.push({node:s.v,length:(1-t)*s.length,ranges:[range(s,t,1,depart)]});
        return out.filter(p=>p.length<=limit+1e-7&&p.ranges.every(r=>allowed(r,excluded)));
      };
      let answer=null;
      const consider=(ranges,length)=>{if(length>.000001&&length<=limit+1e-7&&ranges.every(r=>allowed(r,excluded))&&(!answer||length<answer.length))answer={ranges:ranges.filter(r=>r.hi-r.lo>1e-9),length};};
      if(from.a.s&&from.a.s===to.a.s){const s=from.a.s,forward=to.a.t>from.a.t;if(forward?s.forward:s.backward)consider([range(s,from.a.t,to.a.t,forward)],Math.abs(to.a.t-from.a.t)*s.length);}
      const targets=ports(to,false),heap=new Heap(),best=new Map();
      for(const p of ports(from,true)){if(p.length<(best.get(p.node)??Infinity)){best.set(p.node,p.length);heap.push([p.length,{id:p.node,ranges:p.ranges}]);}}
      let visits=0;
      while(heap.a.length&&visits++<2000){
        const [length,state]=heap.pop();if(length!==best.get(state.id)||length>limit)continue;
        for(const p of targets)if(p.node===state.id)consider([...state.ranges,...p.ranges],length+p.length);
        if(answer&&length>=answer.length)continue;
        for(const step of index.adj.get(state.id)||[]){const r=range(step.s,0,1,!step.reverse),next=length+step.s.length;
          if(next>limit+1e-7||next>=(best.get(step.to)??Infinity)||!allowed(r,excluded))continue;
          best.set(step.to,next);heap.push([next,{id:step.to,ranges:[...state.ranges,r]}]);
        }
      }
      return answer;
    };
    const forward=find(a,b),backward=find(b,a);let path=forward;
    if(!path&&backward)path={...backward,ranges:[...backward.ranges].reverse().map(r=>({...r,forward:!r.forward}))};
    if(!path){reject('noConfirmedOSMPath');continue;}
    const signature=p=>p.ranges.map(r=>`${r.s.key}:${r.lo.toFixed(6)}:${r.hi.toFixed(6)}`).sort().join('|');
    if(forward&&backward&&signature(forward)!==signature(backward)){reject('ambiguousOSMPath');continue;}
    const keys=[...new Set(path.ranges.map(r=>r.s.key))];
    if(keys.some(key=>find(forward?a:b,forward?b:a,key))){reject('ambiguousOSMPath');continue;}
    proposals.push({a,b,direct,path,allowed});
  }
  const uses=new Map();for(const p of proposals)for(const end of [p.a,p.b])uses.set(end.n.key,(uses.get(end.n.key)||0)+1);
  proposals.sort((a,b)=>a.path.length-b.path.length||a.a.n.key.localeCompare(b.a.n.key));
  for(const {a,b,direct,path,allowed}of proposals){
    if(uses.get(a.n.key)!==1||uses.get(b.n.key)!==1){reject('multipleEndpoints');continue;}
    if(a.n.edges.length!==1||b.n.edges.length!==1||!path.ranges.every(r=>allowed(r,null))){reject('occupiedConnection');continue;}
    const sources=new Set([...a.edge.sources,...b.edge.sources]),parts=new Set([...a.edge.parts,...b.edge.parts]),geometry=[a.n.p];let current=a.n.key,walked=0;
    for(const [i,r]of path.ranges.entries()){
      const {s,lo,hi,forward}=r,t=forward?hi:lo,length=(hi-lo)*s.length,last=i===path.ranges.length-1;
      walked+=length;const key=last?b.n.key:t===0?s.u:t===1?s.v:`p/${s.key}/${t.toFixed(6)}`;
      if(!nodes.has(key)){const p=lerp(s.a,s.b,t),z=finiteZ(a.n.p[2])&&finiteZ(b.n.p[2])?a.n.p[2]+(b.n.p[2]-a.n.p[2])*walked/path.length:null;p[2]=z;nodes.set(key,{key,p,heights:finiteZ(z)?[z]:[],edges:[]});}
      const e={id:edges.length,u:current,v:key,forward:forward?s.forward:s.backward,backward:forward?s.backward:s.forward,pushing:!!s.pushing,restricted:false,repaired:true,sources:new Set(sources),parts:new Set(parts),osmKeys:[s.key],wayIds:[s.wayId],osmRange:{key:s.key,lo,hi}};
      edges.push(e);nodes.get(current).edges.push(e.id);nodes.get(key).edges.push(e.id);occupy(e.osmRange);geometry.push(nodes.get(key).p);current=key;
    }
    report.connections.push({from:a.n.key,to:b.n.key,distance:direct,length:path.length,osmWayIds:[...new Set(path.ranges.map(r=>r.s.wayId))],geometry:geometry.map(p=>unproject(p,index.origin))});
  }
  return report;
}

const median=a=>{if(!a.length)return null;a.sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
// Explicit, reviewed OSM corridors. Both anchors must already be covered.
// Connections follow OSM identities and directions, never geometric crossings.
function addConfirmedConnections(ranges,cutPoints,index,connections=[],enabled=true){
  if(!enabled)return [];
  const original=new Map([...ranges].map(([key,items])=>[key,[...items]])),reports=[],anchorCache=new Map();
  const anchor=id=>{
    if(anchorCache.has(id))return anchorCache.get(id);
    const sources=new Set(),heights=[];
    for(const [key,items]of original){const s=index.segments.get(key);if(!s)continue;
      for(const r of items){const atStart=s.u===id&&r.lo===0,atEnd=s.v===id&&r.hi===1;
        if(atStart||atEnd){sources.add(r.source);const z=atStart?r.z0:r.z1;if(finiteZ(z))heights.push(z);}
      }
    }
    const result={sources,z:median(heights)};anchorCache.set(id,result);return result;
  };
  for(const connection of connections){
    const from=`n/${connection.fromNode}`,to=`n/${connection.toNode}`,a=anchor(from),b=anchor(to);
    if(from===to||!a.sources.size||!b.sources.size||!connection.segments?.length)continue;
    let current=from,length=0,valid=true;const path=[];
    for(const piece of connection.segments){const s=index.segments.get(piece.key),reverse=!!piece.reverse;
      if(!s||s.restricted||!(reverse?s.backward:s.forward)||(reverse?s.v:s.u)!==current){valid=false;break;}
      path.push({s,reverse,at:length});length+=s.length;current=reverse?s.u:s.v;
    }
    if(!valid||current!==to)continue;
    let addedLength=0;const sources=new Set([...a.sources,...b.sources]);
    for(const piece of path){const {s,reverse,at}=piece,old=original.get(s.key)||[],covered=[];
      for(const r of [...old].sort((x,y)=>x.lo-y.lo)){const last=covered.at(-1);if(last&&r.lo<=last.hi+1e-9)last.hi=Math.max(last.hi,r.hi);else covered.push({lo:r.lo,hi:r.hi});
        if(!cutPoints.has(s.key))cutPoints.set(s.key,new Set());for(const t of [r.lo,r.hi])if(t>0&&t<1)cutPoints.get(s.key).add(t);
      }
      const gaps=[];let end=0;for(const r of covered){if(r.lo>end+1e-9)gaps.push([end,r.lo]);end=Math.max(end,r.hi);}if(end<1-1e-9)gaps.push([end,1]);
      const height=t=>{
        if(t===0||t===1){const z=anchor(t===0?s.u:s.v).z;if(finiteZ(z))return z;}
        const zs=[];for(const r of old){if(Math.abs(t-r.lo)<1e-8&&finiteZ(r.z0))zs.push(r.z0);if(Math.abs(t-r.hi)<1e-8&&finiteZ(r.z1))zs.push(r.z1);}if(zs.length)return median(zs);
        return finiteZ(a.z)&&finiteZ(b.z)?a.z+(b.z-a.z)*(at+s.length*(reverse?1-t:t))/length:null;
      };
      if(!ranges.has(s.key))ranges.set(s.key,[]);
      for(const [lo,hi]of gaps){addedLength+=(hi-lo)*s.length;for(const source of sources)ranges.get(s.key).push({lo,hi,z0:height(lo),z1:height(hi),source,part:-1,connectionId:connection.id});}
    }
    const geometry=[unproject(path[0].reverse?path[0].s.b:path[0].s.a,index.origin),...path.map(p=>unproject(p.reverse?p.s.a:p.s.b,index.origin))];
    reports.push({id:connection.id,name:connection.name,length,addedLength,geometry,sourceUrl:connection.sourceUrl,checkedAt:connection.checkedAt});
  }
  return reports;
}

export function buildOSMNetwork(routes,reference,options={},progress=()=>{}){
  if(reference.version!==1||!reference.nodes||!Array.isArray(reference.ways))throw new Error('Ungültige OSM-Referenzdaten. Bitte den Datensatz neu laden.');
  routes=[...routes].sort((a,b)=>String(a.fileName||a.name||a.id).localeCompare(String(b.fileName||b.name||b.id),'en'));
  const origin=projection(routes),radius=clamp(Number(options.tolerance??30),5,60),index=createReferenceIndex(reference,origin,options),ranges=new Map(),routeInfo=[],uncertain=[];
  const matchingUpdates={},fallbackInputs=[],cutPoints=new Map();
  let inputPoints=0,inputLength=0,unmatchedPoints=0,observations=0,offsetTotal=0,offsetCount=0;
  for(const [ri,route]of routes.entries()){
    let length=0,points=0;for(const part of route.segments){points+=part.length;const p=part.map(p=>project(p,origin));if(p.some(p=>Math.abs(p[0])>250000||Math.abs(p[1])>250000))throw new Error('Bitte einen Bereich von höchstens 500 km Ausdehnung verwenden.');length+=lineLength(p);}
    inputPoints+=points;inputLength+=length;if(inputPoints>100000)throw new Error('Maximal 100.000 GPX-Punkte pro Datensatz.');
    progress({stage:`OSM-Wege zuordnen · ${ri+1} / ${routes.length}`,percent:8+Math.round(ri/routes.length*55)});
    const saved=reference.matches?.[geometryKey(route)],samePolicy=(saved?.allowPushing!==false)===(options.allowPushing!==false)&&(saved?.respectAccess===true)===(options.respectAccess===true),prepared=saved&&samePolicy&&(saved.method!=='local-sequence'||saved.radius===radius)?saved:null,match=prepared||matchRouteLocally(route,index,radius);
    if(!prepared)matchingUpdates[geometryKey(route)]=match;
    if(options.allowUnmatched&&options.respectAccess!==true)for(const span of match.fallbacks||[]){
      const copy={...span,source:ri};for(const side of ['from','to']){const a=span[side],s=a&&index.segments.get(a.key);if(!s)continue;const t=a.t*s.length<.75?0:(1-a.t)*s.length<.75?1:a.t;copy[side]={...a,t};if(!cutPoints.has(s.key))cutPoints.set(s.key,new Set());cutPoints.get(s.key).add(t);}
      fallbackInputs.push(copy);
    }
    observations+=match.totalPoints;unmatchedPoints+=match.unmatchedPoints;offsetTotal+=(match.meanOffset||0)*match.matchedPoints;offsetCount+=match.matchedPoints;
    uncertain.push(...(match.uncertain||[]).map(geometry=>({geometry,route:ri})));
    for(const [key,lo,hi,z0,z1,part=0]of match.coverage){
      const s=index.segments.get(key);if(!s||hi<=lo)continue;
      if(!ranges.has(key))ranges.set(key,[]);ranges.get(key).push({lo:lo*s.length<.75?0:lo,hi:(1-hi)*s.length<.75?1:hi,z0,z1,source:ri,part});
    }
    routeInfo.push({id:route.id,name:route.name,fileName:route.fileName,color:route.color,length,points,matching:{method:match.method,matchedPercent:Math.round((1-match.unmatchedPoints/Math.max(1,match.totalPoints))*100),unmatchedPoints:match.unmatchedPoints}});
  }
  const confirmedConnections=addConfirmedConnections(ranges,cutPoints,index,reference.connections,options.allowConnections!==false);
  progress({stage:'Gemeinsame OSM-Abschnitte einmalig zusammenführen',percent:67});
  const nodes=new Map(),rawEdges=[];
  const nodeAt=(s,t)=>{
    const key=t===0?s.u:t===1?s.v:`p/${s.key}/${t.toFixed(6)}`;
    if(!nodes.has(key))nodes.set(key,{key,p:lerp(s.a,s.b,t),heights:[],edges:[]});return nodes.get(key);
  };
  for(const key of [...ranges.keys()].sort()){
    const s=index.segments.get(key),all=ranges.get(key).sort((a,b)=>a.lo-b.lo),merged=[];
    for(const r of all){const last=merged.at(-1);if(last&&(r.lo-last.hi)*s.length<=.25){last.hi=Math.max(last.hi,r.hi);last.items.push(r);}else merged.push({lo:r.lo,hi:r.hi,items:[r]});}
    const divided=merged.flatMap(interval=>{const cuts=[interval.lo,...[...(cutPoints.get(key)||[])].filter(t=>t>interval.lo+1e-9&&t<interval.hi-1e-9).sort((a,b)=>a-b),interval.hi];return cuts.slice(1).map((hi,i)=>({...interval,lo:cuts[i],hi}));});
    for(const interval of divided){if(interval.hi-interval.lo<1e-9)continue;
      const u=nodeAt(s,interval.lo),v=nodeAt(s,interval.hi);
      for(const [n,t]of [[u,interval.lo],[v,interval.hi]])for(const r of interval.items)if(finiteZ(r.z0)&&finiteZ(r.z1)&&t>=r.lo-1e-6&&t<=r.hi+1e-6)n.heights.push(r.z0+(r.z1-r.z0)*clamp((t-r.lo)/(r.hi-r.lo||1),0,1));
      const e={id:rawEdges.length,connectionIds:[...new Set(interval.items.filter(r=>r.connectionId&&r.lo<interval.hi-1e-9&&r.hi>interval.lo+1e-9).map(r=>r.connectionId))],u:u.key,v:v.key,forward:s.forward,backward:s.backward,pushing:!!s.pushing,restricted:!!s.restricted,sources:new Set(interval.items.map(r=>r.source)),parts:new Set(interval.items.map(r=>`${r.source}/${r.part}`)),osmKeys:[key],wayIds:[s.wayId],osmRange:{key,lo:interval.lo,hi:interval.hi}};rawEdges.push(e);u.edges.push(e.id);v.edges.push(e.id);
    }
  }
  const rawGrid=new Map(),fallbackGroups=new Map(),rawCell=15;
  const fallbackNode=(anchor,coord)=>{
    if(anchor&&index.segments.has(anchor.key)){const n=nodeAt(index.segments.get(anchor.key),anchor.t);if(finiteZ(anchor.z))n.heights.push(anchor.z);return n;}
    const p=project(coord,origin),x=Math.floor(p[0]/rawCell),y=Math.floor(p[1]/rawCell);let best=null;
    for(let i=x-1;i<=x+1;i++)for(let j=y-1;j<=y+1;j++)for(const n of rawGrid.get(`${i},${j}`)||[])if(dist(p,n.p)<=10&&(!finiteZ(p[2])||!finiteZ(n.p[2])||Math.abs(p[2]-n.p[2])<=8)&&(!best||dist(p,n.p)<dist(p,best.p)))best=n;
    if(best)return best;const key=`g/${nodes.size}`,n={key,p,heights:finiteZ(p[2])?[p[2]]:[],edges:[]};nodes.set(key,n);if(!rawGrid.has(`${x},${y}`))rawGrid.set(`${x},${y}`,[]);rawGrid.get(`${x},${y}`).push(n);return n;
  };
  for(const span of fallbackInputs){
    const shape=span.geometry.map(p=>project(p,origin));if(shape.length<2)continue;
    const u=fallbackNode(span.from,span.geometry[0]),v=fallbackNode(span.to,span.geometry.at(-1));shape[0]=u.p;shape[shape.length-1]=v.p;
    const length=lineLength(shape);if(length<.1)continue;
    const signature=[u.key,v.key].sort().join('|'),other=fallbackGroups.get(signature)||[];
    const duplicate=other.find(e=>Math.abs(e.length-length)<Math.max(5,length*.1)&&shape.every(p=>e.shape.slice(1).some((b,i)=>foot(p,e.shape[i],b).d<15)));
    if(duplicate){duplicate.sources.add(span.source);continue;}
    const e={id:rawEdges.length,u:u.key,v:v.key,shape,length,forward:true,backward:true,pushing:false,restricted:false,unclear:true,sources:new Set([span.source]),parts:new Set([`${span.source}/${span.part??0}`]),osmKeys:[],wayIds:[]};rawEdges.push(e);u.edges.push(e.id);v.edges.push(e.id);other.push(e);fallbackGroups.set(signature,other);
  }
  if(!rawEdges.length)throw new Error('Keine sicher zugeordneten OSM-Wege gefunden. Bitte OSM-Daten für die importierten Tracks laden oder die ungeprüfte GPX-Ansicht wählen.');
  for(const n of nodes.values())n.p[2]=median(n.heights);
  progress({stage:'Nahe Sackgassen-Enden gegen OSM prüfen',percent:74});
  const gapRepair=repairOSMDeadEnds(nodes,rawEdges,index,options.endpointGap??10);
  const into=(e,id)=>e.v===id?e.forward:e.backward,outof=(e,id)=>e.u===id?e.forward:e.backward;
  const anchors=new Set([...nodes.values()].filter(n=>n.edges.length!==2||String(rawEdges[n.edges[0]].connectionIds||[])!==String(rawEdges[n.edges[1]].connectionIds||[])||!!rawEdges[n.edges[0]].unclear!==!!rawEdges[n.edges[1]].unclear||rawEdges[n.edges[0]].pushing!==rawEdges[n.edges[1]].pushing||rawEdges[n.edges[0]].restricted!==rawEdges[n.edges[1]].restricted||into(rawEdges[n.edges[0]],n.key)!==outof(rawEdges[n.edges[1]],n.key)||into(rawEdges[n.edges[1]],n.key)!==outof(rawEdges[n.edges[0]],n.key)).map(n=>n.key));
  const seen=new Set(),components=[];
  for(const n of nodes.values()){
    if(seen.has(n.key))continue;const stack=[n.key],keys=[];seen.add(n.key);
    while(stack.length){const id=stack.pop();keys.push(id);for(const ei of nodes.get(id).edges){const e=rawEdges[ei],to=e.u===id?e.v:e.u;if(!seen.has(to)){seen.add(to);stack.push(to);}}}
    if(!keys.some(k=>anchors.has(k)))anchors.add(keys.sort()[0]);
    const component=components.length;for(const k of keys)nodes.get(k).component=component;components.push({id:component});
  }
  const ids=new Map([...anchors].sort().map((key,id)=>[key,id])),visited=new Set(),sections=[];
  for(const firstNode of [...anchors].sort())for(const firstEdge of nodes.get(firstNode).edges){
    if(visited.has(firstEdge))continue;
    let current=firstNode,ei=firstEdge,forward=true,backward=true;const geometry=[nodes.get(current).p],sources=new Set(),osmKeys=[],wayIds=new Set(),connectionIds=new Set();
    for(let guard=0;guard<=rawEdges.length;guard++){
      const e=rawEdges[ei],reverse=e.v===current;visited.add(ei);forward&&=reverse?e.backward:e.forward;backward&&=reverse?e.forward:e.backward;
      for(const id of e.connectionIds||[])connectionIds.add(id);for(const id of e.sources)sources.add(id);osmKeys.push(...e.osmKeys);for(const id of e.wayIds)wayIds.add(id);
      current=reverse?e.u:e.v;if(e.shape){const shape=reverse?[...e.shape].reverse():e.shape;geometry.push(...shape.slice(1));geometry[geometry.length-1]=nodes.get(current).p;}else geometry.push(nodes.get(current).p);if(anchors.has(current))break;
      const next=nodes.get(current).edges.find(id=>id!==ei&&!visited.has(id));if(next===undefined)break;ei=next;
    }
    const length=Math.max(.001,lineLength(geometry));if(!ids.has(current))continue;
    sections.push({id:sections.length,connectionIds:[...connectionIds],u:ids.get(firstNode),v:ids.get(current),length,forward,backward,unclear:!!rawEdges[firstEdge].unclear,pushing:rawEdges[firstEdge].pushing,restricted:rawEdges[firstEdge].restricted,geometry:geometry.map(p=>unproject(p,origin)),sources:[...sources],osmKeys:[...new Set(osmKeys)],osmWayIds:[...wayIds],ascent:ascent(geometry),descent:ascent([...geometry].reverse()),turns:countTurns(geometry)});
  }
  const degrees=new Map();for(const e of sections){degrees.set(e.u,(degrees.get(e.u)||0)+1);degrees.set(e.v,(degrees.get(e.v)||0)+1);}
  const activeNodes=[...ids].map(([key,id])=>({id,osmId:key.startsWith('n/')?key.slice(2):null,coord:unproject(nodes.get(key).p,origin),degree:degrees.get(id)||0,kind:key.startsWith('g/')?'gpx':'osm',component:nodes.get(key).component}));
  for(const c of components){const ns=activeNodes.filter(n=>n.component===c.id),set=new Set(ns.map(n=>n.id)),es=sections.filter(e=>set.has(e.u));Object.assign(c,{nodes:ns.length,sections:es.length,length:es.reduce((a,e)=>a+e.length,0)});}
  progress({stage:'OSM-Wegenetz bereit',percent:100});
  return {origin,options:{kind:'osm',allowConnections:options.allowConnections!==false,tolerance:15,matchRadius:radius,endpointGap:gapRepair.limit,respectAccess:options.respectAccess===true,allowPushing:options.allowPushing!==false,allowUnmatched:!!options.allowUnmatched&&options.respectAccess!==true,heightCheck:false,heightThreshold:8},nodes:activeNodes,edges:sections,blocked:[],uncertain,gapRepair,confirmedConnections,routes:routeInfo,matchingUpdates,
    attribution:{text:'© OpenStreetMap-Mitwirkende',url:'https://www.openstreetmap.org/copyright',license:'ODbL 1.0',preparedAt:reference.preparedAt},
    stats:{inputPoints,inputLength,confirmedConnections:confirmedConnections.length,connectionLength:confirmedConnections.reduce((sum,c)=>sum+c.addedLength,0),repairedGaps:gapRepair.connections.length,repairedLength:gapRepair.connections.reduce((sum,c)=>sum+c.length,0),unverifiedLength:sections.filter(e=>e.unclear).reduce((sum,e)=>sum+e.length,0),nodes:activeNodes.length,junctions:activeNodes.filter(n=>n.degree>=3).length,sections:sections.length,length:sections.reduce((a,e)=>a+e.length,0),rawNodes:nodes.size,shapePoints:nodes.size-activeNodes.length,components:components.filter(c=>c.sections).sort((a,b)=>b.length-a.length),cycles:Math.max(0,sections.length-activeNodes.length+components.length),closedRings:sections.filter(e=>e.u===e.v).length,matchedPercent:Math.round((1-unmatchedPoints/Math.max(1,observations))*1000)/10,unmatchedPoints,meanOffset:offsetTotal/Math.max(1,offsetCount),source:'OpenStreetMap'}};
}
