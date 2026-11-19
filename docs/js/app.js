import {nearestPoint, recommendedStart, inspectRoundTripStart, toGPX, networkGeoJSON, project} from "./network.js";
import {NetworkMap} from "./map.js";
import {loadReference,ensureReference,saveMatches} from "./osm-data.js";
const $ = id => document.getElementById(id);
const number = (v, digits=0) => new Intl.NumberFormat('de-DE',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(v);
const km = v => number(v/1000,1);
const palette=['#527eae','#ba8750','#669f84','#9575ad','#cb788a','#778b51','#64989b','#b8a24b'];
let tracks=[],demo=[],network=null,result=null,selectedVariant=0,busy=false,pickMode=null,mode='loop',nextJob=0,job=null,toastTimer;
let start=null,end=null,waypoints=[];
let startIssue=null,checkedNetwork=null,checkedStartKey=null;
let connectionIssue=null;
let osmReference=null;
const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
const map=new NetworkMap($('map'),onMapClick);
window.addEventListener('error',e=>{if(e.message?.includes('ResizeObserver'))return;console.error(e.error||e.message);});
worker.addEventListener('message',({data})=>{
  if(!job||job.id!==data.id)return;
  if(data.type==='progress'){$('busy-stage').textContent=data.stage;$('busy-progress').style.width=data.percent+'%';}
  else if(data.type==='error'){const j=job;job=null;j.reject(Object.assign(new Error(data.message),{code:data.code,details:data.details}));}
  else if(data.type==='result'){const j=job;job=null;j.resolve(data);}
});
worker.addEventListener('error',e=>{if(job){job.reject(new Error('Die Berechnung konnte nicht gestartet werden. Bitte die Seite neu laden.'));job=null;}console.error(e);});
function compute(type,payload){return new Promise((resolve,reject)=>{const id=++nextJob;job={id,resolve,reject};worker.postMessage({id,type,...payload});});}
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:5000);}
function setBusy(value,title='Deine Wege werden verbunden'){
  busy=value;$('busy').classList.remove('error');$('busy').hidden=!value;$('busy-title').textContent=title;$('busy-progress').style.width='4%';
  for(const id of ['generate','regenerate','rebuild','import','restore-demo','export-network'])$(id).disabled=value||(['generate','regenerate','export-network'].includes(id)&&!network);
  for(const id of ['distance','distance-slider','length-tolerance','hills','turns','seed','clear-waypoints','network-mode','allow-pushing','respect-access','allow-unmatched','repair-deadends','max-end-gap','use-osm-connections'])$(id).disabled=value;
  for(const id of ['pick-start','pick-end','add-waypoint'])$(id).disabled=value||!network||(id==='add-waypoint'&&waypoints.length>=8);
  $('use-start-suggestion').disabled=value;
  $('show-connection').disabled=value;
  $('show-confirmed-connection').disabled=value;
  $('load-canal-example').disabled=value;
  document.querySelectorAll('[data-mode]').forEach(e=>e.disabled=value);updatePoints();
  document.querySelectorAll('.track-item input,.track-remove').forEach(e=>e.disabled=value);
  $('footer-status').textContent=value?'Berechnung läuft …':network?'Wegenetz bereit':'Noch kein Wegenetz';
}
function switchTab(name){
  for(const item of document.querySelectorAll('[data-tab]')){const active=item.dataset.tab===name;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));$('panel-'+item.dataset.tab).hidden=!active;}
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>switchTab(button.dataset.tab)));
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{
  cancelPicking();mode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
  updatePoints();$('generate').querySelector('span').textContent=mode==='ab'?'Neue Strecke finden':'Neue Runde finden';
  invalidateRoute();if(mode==='ab'&&!end)toast('Wähle über „Zielpunkt“ ein Ziel auf der Karte.');
}));
function invalidateRoute(){result=null;map.setRoute(null);$('route-card').hidden=true;connectionIssue=null;$('connection-issue').hidden=true;map.connectionGeometry=[];map.schedule();}
$('show-confirmed-connection').addEventListener('click',()=>{
  map.extensionGeometry=(network?.confirmedConnections||[]).map(c=>c.geometry);
  if(map.extensionGeometry.length)map.fit(map.extensionGeometry.flat());
});
$('load-canal-example').addEventListener('click',async()=>{
  if(busy||$('network-mode').value!=='osm')return;
  document.querySelector('[data-mode="loop"]').click();
  start=[13.475458,52.5001663];waypoints=[[13.6217,52.3936],[13.6935,52.3718],[13.6959,52.3751]];
  $('distance').value=70;$('distance-slider').value=70;$('length-tolerance').value=.1;$('seed').value='kanalrunde-70';
  for(const id of ['allow-pushing','allow-unmatched','repair-deadends','use-osm-connections'])$(id).checked=true;
  $('respect-access').checked=false;$('max-end-gap').value=25;
  for(const id of ['hills','turns']){$(id).value=0;$(id+'-label').textContent='Ausgewogen';}
  await rebuild(false,false);switchTab('plan');await generate(true);
});
$('show-connection').addEventListener('click',()=>{if(connectionIssue)map.fit(connectionIssue.sections.flatMap(s=>s.geometry));});
for(const id of ['distance','distance-slider'])$(id).addEventListener('input',()=>{
  if(id==='distance-slider')$('distance').value=$('distance-slider').value;else $('distance-slider').value=$('distance').value;
  invalidateRoute();
});
$('length-tolerance').addEventListener('change',invalidateRoute);
for(const id of ['hills','turns'])$(id).addEventListener('input',()=>{
  const val=Number($(id).value);$(id+'-label').textContent=val===0?'Ausgewogen':id==='hills'?(val<0?'Flacher':'Hügeliger'):(val<0?'Weniger':'Mehr');
  invalidateRoute();
});
function updatePoints(){
  $('start-label').textContent=start?`${number(start[1],4)}° N, ${number(start[0],4)}° E`:'Wird auf das Wegenetz gesetzt';
  $('end-label').textContent=end?`${number(end[1],4)}° N, ${number(end[0],4)}° E`:'Auf der Karte auswählen';
  const startKey=mode+':'+(start?.slice(0,2).join(',')||'');
  if(network!==checkedNetwork||startKey!==checkedStartKey){checkedNetwork=network;checkedStartKey=startKey;startIssue=mode==='loop'?inspectRoundTripStart(network,start):null;}
  $('start-issue').hidden=!startIssue;
  if(startIssue){
    $('start-issue-message').textContent='Der gesetzte Start liegt auf einem Wegabschnitt, der keiner Runde zugeordnet ist. Das beschreibt die importierten Daten, keine tatsächliche Sackgasse vor Ort.';
    $('use-start-suggestion').hidden=!startIssue.suggestion;
    $('use-start-suggestion').textContent=startIssue.suggestion?`Start auf Rundkurs setzen · ${number(startIssue.suggestion.distance)} m versetzt`:'';
    $('start-issue').querySelector('small').hidden=!startIssue.suggestion;
  }
  $('pick-end').hidden=mode!=='ab';$('roundtrip-end').hidden=mode!=='loop';
  $('waypoint-list').replaceChildren();
  waypoints.forEach((point,i)=>{
    const row=document.createElement('li');row.className='waypoint-row';
    const location=document.createElement('button');location.className='point-button waypoint-location';location.setAttribute('aria-label',`Zwischenpunkt ${i+1} auf der Karte ändern`);
    const badge=document.createElement('span');badge.className='point-letter waypoint-letter';badge.textContent=i+1;
    const info=document.createElement('span'),title=document.createElement('b'),coord=document.createElement('small');title.textContent=`Zwischenpunkt ${i+1}`;coord.textContent=`${number(point[1],4)}° N, ${number(point[0],4)}° E`;info.append(title,coord);location.append(badge,info);location.addEventListener('click',()=>beginPicking('waypoint-'+i));
    const actions=document.createElement('div');actions.className='waypoint-actions';
    for(const [label,symbol,delta]of [['Nach oben','↑',-1],['Nach unten','↓',1],['Entfernen','×',0]]){
      const b=document.createElement('button');b.textContent=symbol;b.title=label;b.setAttribute('aria-label',`Zwischenpunkt ${i+1}: ${label}`);b.disabled=busy||(delta!==0&&(i+delta<0||i+delta>=waypoints.length));
      b.addEventListener('click',()=>{cancelPicking();if(delta)[waypoints[i],waypoints[i+delta]]=[waypoints[i+delta],waypoints[i]];else waypoints.splice(i,1);updatePoints();invalidateRoute();});actions.append(b);
    }
    location.disabled=busy;row.append(location,actions);$('waypoint-list').append(row);
  });
  $('waypoint-count').textContent=`${waypoints.length} / 8`;$('clear-waypoints').hidden=!waypoints.length;
  $('route-caption').textContent=waypoints.length?'Alle gesetzten Punkte werden angefahren · bis zu 3 Varianten':'Verteilte Zwischenziele · bis zu 3 geprüfte Varianten';
  $('add-waypoint').disabled=busy||!network||waypoints.length>=8;
  $('waypoint-hint').textContent=waypoints.length?`Reihenfolge: S → ${waypoints.map((_,i)=>i+1).join(' → ')} → ${mode==='loop'?'S':'Z'}. Punkte anklicken zum Versetzen; Pfeile ändern die Reihenfolge.`:'Optional: Punkte auf der Karte setzen. Ohne Punkte wird die Route automatisch geplant.';
  map.start=network?start:null;map.end=network&&mode==='ab'?end:null;map.waypoints=network?waypoints:[];map.schedule();
}
function beginPicking(type){
  if(!network||busy)return;
  if(pickMode===type){cancelPicking();return;}
  if(type==='add'&&waypoints.length>=8)return;
  pickMode=type;$('pick-banner').hidden=false;$('pick-banner').querySelector('span').textContent=type==='start'?'Startpunkt auf der Karte wählen':type==='end'?'Zielpunkt auf der Karte wählen':type==='add'?`Zwischenpunkt ${waypoints.length+1} auf der Karte setzen`:`Zwischenpunkt ${Number(type.slice(9))+1} auf der Karte versetzen`;
  $('map').classList.add('picking');$('pick-start').classList.toggle('picking',type==='start');$('pick-end').classList.toggle('picking',type==='end');
  $('add-waypoint').classList.toggle('picking',type==='add');document.querySelectorAll('.waypoint-location').forEach((b,i)=>b.classList.toggle('picking',type==='waypoint-'+i));
  if(innerWidth<=700)$('map').scrollIntoView({behavior:'smooth',block:'start'});
}
function cancelPicking(){pickMode=null;$('pick-banner').hidden=true;$('map').classList.remove('picking');document.querySelectorAll('.points .picking').forEach(b=>b.classList.remove('picking'));}
$('pick-start').addEventListener('click',()=>beginPicking('start'));$('pick-end').addEventListener('click',()=>beginPicking('end'));$('cancel-pick').addEventListener('click',cancelPicking);
$('add-waypoint').addEventListener('click',()=>beginPicking('add'));
$('clear-waypoints').addEventListener('click',()=>{cancelPicking();waypoints=[];updatePoints();invalidateRoute();});
$('use-start-suggestion').addEventListener('click',()=>{
  if(busy||!startIssue?.suggestion)return;
  const suggestion=startIssue.suggestion;cancelPicking();start=suggestion.coord;updatePoints();invalidateRoute();
  toast(`Start um ${number(suggestion.distance)} m auf einen Rundkurs gesetzt. Deine Zwischenpunkte bleiben erhalten.`);
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){cancelPicking();$('node-detail').hidden=true;map.highlightNode=null;map.schedule();}});
function onMapClick(coord,pixel){
  if(busy||!network)return;
  if(pickMode){
    const snapped=nearestPoint(network,coord);if(!snapped)return;
    if(pickMode==='start')start=snapped.coord;else if(pickMode==='end')end=snapped.coord;else if(pickMode==='add')waypoints.push(snapped.coord);else waypoints[Number(pickMode.slice(9))]=snapped.coord;
    cancelPicking();updatePoints();invalidateRoute();
    toast(snapped.confirmedSnap?`Auf die bestätigte OSM-Verbindung gesetzt (${number(snapped.distance)} m versetzt).`:snapped.distance>30?`Punkt auf den nächsten Weg gesetzt (${number(snapped.distance)} m versetzt).`:'Punkt auf dem Wegenetz gesetzt.');return;
  }
  if(map.layers.nodes){
    const n=map.closestNode(pixel);
    if(n){map.highlightNode=n;map.schedule();$('node-detail').hidden=false;$('node-title').textContent=`Knoten ${n.id} · ${n.degree} Anschlüsse`;
      $('node-description').textContent=n.kind==='osm'?`${n.osmId?'Gemeinsamer OSM-Knoten '+n.osmId:'Ende eines zugeordneten OSM-Abschnitts'}. Verbindungen folgen den OSM-Wegen, einschließlich Über- und Unterführungen.`:n.kind==='gpx'?'Endpunkt eines ungeprüften Original-GPX-Abschnitts. Keine bestätigte OSM-Verbindung.':n.kind==='snap'?'Nahe Linien wurden anhand von Richtung und Verlauf verbunden oder als Track-Ende an einen Querweg angeschlossen.':n.degree===1?'Endpunkt eines importierten Weges.':'Geometrischer Schnittpunkt oder gemeinsame Streckenverzweigung.';
      $('node-location').textContent=`${number(n.coord[1],6)}° N · ${number(n.coord[0],6)}° E`;
    }else{$('node-detail').hidden=true;map.highlightNode=null;map.schedule();}
  }
}
$('close-node').addEventListener('click',()=>{$('node-detail').hidden=true;map.highlightNode=null;map.schedule();});
$('fit').addEventListener('click',()=>map.fitNetwork());$('zoom-in').addEventListener('click',()=>map.zoomBy(.75));$('zoom-out').addEventListener('click',()=>map.zoomBy(-.75));
for(const name of ['network','original','nodes','basemap','uncertain'])$('layer-'+name).addEventListener('click',()=>{
  map.layers[name]=!map.layers[name];$('layer-'+name).classList.toggle('active',map.layers[name]);$('layer-'+name).setAttribute('aria-pressed',String(map.layers[name]));
  if(name==='nodes'&&map.layers.nodes)toast(network?.options.kind==='osm'?'Knoten folgen den OSM-Verbindungen. Anklicken für Details.':'Gelb: per Nähe verbunden · Hell: geometrischer Knoten · Grau ×: Höhenprüfung.');
  if(name==='uncertain'&&map.layers.uncertain)toast('Violett gestrichelt: unklare GPX-Abschnitte. Zugelassene GPX-Ergänzungen bleiben ungeprüft.');map.schedule();
});
function renderTracks(){
  $('track-list').replaceChildren();$('track-count').textContent=tracks.length;
  const enabled=tracks.filter(r=>r.enabled);$('data-summary').textContent=`${enabled.length} / ${tracks.length} aktiv · ${km(enabled.reduce((s,r)=>s+(r.length||0),0))} km`;
  for(const r of tracks){
    const card=document.createElement('div');card.className='track-item';card.title=r.fileName;
    const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=r.enabled;check.disabled=busy;check.setAttribute('aria-label',r.name+' im Wegenetz verwenden');
    check.addEventListener('change',async()=>{r.enabled=check.checked;await rebuild(false);});
    const info=document.createElement('span');info.className='track-info';const title=document.createElement('span');title.className='track-title';title.textContent=r.name;
    const meta=document.createElement('span');meta.className='track-meta';const line=document.createElement('i');line.className='track-color';line.style.background=r.color;const match=network?.routes.find(x=>x.id===r.id)?.matching;meta.append(line,document.createTextNode(`${km(r.length||0)} km · ${number(r.points)} Punkte${match?' · OSM '+match.matchedPercent+' %':''}`));info.append(title,meta);label.append(check,info);
    const remove=document.createElement('button');remove.className='track-remove';remove.title='Track entfernen';remove.setAttribute('aria-label',r.name+' entfernen');remove.innerHTML='<svg><use href="#i-close"/></svg>';remove.disabled=busy;
    remove.addEventListener('click',async()=>{tracks=tracks.filter(x=>x!==r);await rebuild(false);});card.append(label,remove);$('track-list').append(card);
  }
}
function quickStats(r){
  let length=0,points=0;const rad=Math.PI/180;
  for(const part of r.segments){points+=part.length;for(let i=1;i<part.length;i++){const a=part[i-1],b=part[i],dlat=(b[1]-a[1])*rad,dlon=(b[0]-a[0])*rad;
    length+=12742017.6*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dlon/2)**2)));}}
  return {...r,length,points,enabled:r.enabled??true};
}
function renderStatistics(){
  if(!network)return;const s=network.stats;
  const isOSM=network.options.kind==='osm';
  $('show-confirmed-connection').hidden=!network.confirmedConnections?.length;
  $('net-badge').hidden=false;$('net-badge-title').textContent=`${km(s.length)} km ${isOSM?(s.unverifiedLength?'OSM + GPX-Netz':'OSM-Wegenetz'):'GPX-Näherung'}`;$('net-badge-subtitle').textContent=`${number(s.junctions)} Abzweigungen · ${number(s.sections)} Sektionen${isOSM?' · '+number(s.matchedPercent,1)+' % zugeordnet':' · '+network.options.tolerance+' m Toleranz'}`;
  $('map-subtitle').textContent=`${network.routes.length} GPX-Tracks → ${s.components.length===1?'ein zusammenhängendes Netz':s.components.length+' Teilnetze'}`;
  document.querySelector('.map-region').textContent=tracks.some(r=>r.enabled&&!r.id.startsWith('demo-'))?'DEIN GPX-NETZ':'BERLIN · BRANDENBURG';
  const container=$('network-statistics');container.replaceChildren();const title=document.createElement('div');title.className='stats-title';title.append(document.createTextNode('Das Ergebnis'));const badge=document.createElement('span');badge.className='connected-badge';badge.textContent=`${s.components.length} ${s.components.length===1?'Teilnetz':'Teilnetze'}`;title.append(badge);container.append(title);
  for(const [name,value]of [['Importierte Strecken',km(s.inputLength)+' km'],['Gemeinsames Wegenetz',km(s.length)+' km'],['GPX-Punkte',number(s.inputPoints)],['Knoten / davon Abzweigungen',number(s.nodes)+' / '+number(s.junctions)],['Sektionen',number(s.sections)],['Wegeabgleich',isOSM?'OSM-Wegabschnitte':'Richtung + Verlauf'],...(isOSM?[['Zugeordnete Messpunkte',number(s.matchedPercent,1)+' %'],['Unklare Messpunkte',number(s.unmatchedPoints)],['Ungeprüfte GPX-Ergänzungen',km(s.unverifiedLength)+' km'],['Strenge Zugangsprüfung',network.options.respectAccess?'An':'Aus'],['Gezielte OSM-Ergänzungen',number(s.confirmedConnections||0)+' · '+number(s.connectionLength||0)+' m neu'],['OSM-Lücken geschlossen',number(s.repairedGaps||0)+' · '+number(s.repairedLength||0,1)+' m'],['Grenze für Sackgassen-Anschlüsse',network.options.endpointGap?number(network.options.endpointGap)+' m':'Aus'],['Zyklen im Wegenetz',number(s.cycles)],['OSM-Daten vorbereitet',new Date(osmReference.preparedAt).toLocaleDateString('de-DE')]]:[['Mögliche Überführungen',number(network.blocked.length)]])]){
    const row=document.createElement('div');row.className='stat-row';const label=document.createElement('span'),strong=document.createElement('strong');label.textContent=name;strong.textContent=value;row.append(label,strong);container.append(row);
  }
  $('matching-notice').hidden=!isOSM||!s.unmatchedPoints;$('matching-notice').textContent=isOSM?`${number(s.unmatchedPoints)} Messpunkte sind nicht sicher zugeordnet. Die Ebene „Unklar“ zeigt die betroffenen Abschnitte; ungeprüfte GPX-Ergänzungen sind im Netz violett gestrichelt.`:'';
  $('osm-attribution').hidden=!isOSM;
  if(s.components.length>1){const p=document.createElement('p');p.className='help-text';p.textContent='Zufallsrouten bleiben im Teilnetz ihres Startpunkts. Zwischen getrennten Teilnetzen werden keine Verbindungen erfunden.';container.append(p);}
}
async function rebuild(fit=true,autoGenerate=true){
  if(busy)return;cancelPicking();invalidateRoute();
  const active=tracks.filter(r=>r.enabled);renderTracks();
  if(!active.length){network=null;map.setNetwork(null,[]);map.start=null;map.end=null;map.waypoints=[];$('net-badge').hidden=true;$('network-statistics').replaceChildren();setBusy(false);$('generate').disabled=true;toast('Bitte mindestens einen GPX-Track auswählen.',true);return;}
  setBusy(true);$('busy-stage').textContent='Strecken vorbereiten …';
  try{
    const useOSM=$('network-mode').value==='osm',endpointGap=$('repair-deadends').checked?Number($('max-end-gap').value):0;
    if(useOSM&&$('repair-deadends').checked&&(!Number.isFinite(endpointGap)||endpointGap<1||endpointGap>30))throw new Error('Bitte für die OSM-Lückenprüfung eine Länge zwischen 1 und 30 m eingeben.');
    if(useOSM){if(!osmReference)throw new Error('OSM-Referenzdaten sind noch nicht geladen.');await ensureReference(active,osmReference,stage=>{$('busy-stage').textContent=stage;});}
    const response=await compute('build',{routes:active,options:{tolerance:Number($('snap-tolerance').value),endpointGap,allowConnections:$('use-osm-connections').checked,allowUnmatched:$('allow-unmatched').checked,allowPushing:$('allow-pushing').checked,respectAccess:$('respect-access').checked,heightCheck:$('height-check').checked,heightThreshold:Number($('height-threshold').value),...(useOSM?{osmReference}:{})}});
    network=response.network;if(useOSM)await saveMatches(osmReference,network.matchingUpdates);delete network.matchingUpdates;map.setNetwork(network,active);renderStatistics();
    if(!start)start=recommendedStart(network,active[0].segments[0][0]).coord;
    start=nearestPoint(network,start).coord;if(end)end=nearestPoint(network,end).coord;const pointSnaps=waypoints.map(p=>nearestPoint(network,p));waypoints=pointSnaps.map(p=>p.coord);updatePoints();
    const moved=pointSnaps.flatMap((p,i)=>p.confirmedSnap?[`Punkt ${i+1}: ${number(p.distance)} m`]:[]);if(moved.length)toast('Auf die bestätigte OSM-Verbindung gesetzt ('+moved.join(', ')+').');
    if(fit)map.fitNetwork();$('network-dirty').hidden=true;setBusy(false);renderTracks();
    if(autoGenerate&&(mode==='loop'||end))await generate(false);
  }catch(e){network=null;map.setNetwork(null,active);$('net-badge').hidden=true;setBusy(false);renderTracks();toast(e.message,true);$('busy').hidden=false;$('busy').classList.add('error');$('busy-title').textContent='Wegenetz konnte nicht aufgebaut werden';$('busy-stage').textContent=e.message;}
}
$('rebuild').addEventListener('click',()=>rebuild(false));
$('network-mode').addEventListener('change',()=>{
  const osm=$('network-mode').value==='osm';$('legacy-height').hidden=osm;$('osm-pushing-field').hidden=!osm;$('osm-access-field').hidden=!osm;$('osm-fallback-field').hidden=!osm;$('osm-endpoint-field').hidden=!osm;$('osm-connections-field').hidden=!osm;$('load-canal-example').hidden=!osm;$('snap-label').textContent=osm?'Suchradius für neue GPX-Zuordnungen':'Toleranz für GPS-Abweichungen';$('snap-help').textContent=osm?'Die Sammlung ist vorbereitet. Neue Tracks werden als Punktfolge OSM-Wegen zugeordnet. Für fehlende Kartendaten werden Streckenkoordinaten an OSM Overpass übermittelt.':'GPX-Näherung ohne OSM: Geometrische Kreuzungen und nahe Spuren können fehlerhafte Verbindungen erzeugen.';$('snap-tolerance').min=osm?5:1;$('snap-tolerance').max=osm?60:35;$('snap-tolerance').value=osm?30:15;$('snap-output').textContent=$('snap-tolerance').value;const labels=document.querySelectorAll('.tolerance-field .range-labels span');labels[0].textContent=osm?'5 m · genau':'1 m · genau';labels[1].textContent=osm?'60 m · großzügig':'35 m · großzügig';rebuild(false);
});
for(const id of ['snap-tolerance','height-check','height-threshold','allow-pushing','respect-access','allow-unmatched','repair-deadends','max-end-gap','use-osm-connections'])$(id).addEventListener('input',()=>{
  $('snap-output').textContent=$('snap-tolerance').value;$('network-dirty').hidden=false;
});
const isMobile=()=>window.matchMedia('(max-width:700px)').matches;
async function generate(fit=false){
  if(busy||!network)return;
  const distance=Number($('distance').value);if(!Number.isFinite(distance)||distance<5||distance>150){toast('Bitte eine Wunschlänge zwischen 5 und 150 km eingeben.',true);return;}
  if(mode==='ab'&&!end){beginPicking('end');return;}
  if(mode==='loop'&&startIssue){$('start-issue').scrollIntoView({behavior:'smooth',block:'nearest'});toast(startIssue.message,true);return;}
  const seed=$('seed').value.trim()||Math.random().toString(36).slice(2,10);
  setBusy(true,'Deine nächste Tour entsteht');$('busy-stage').textContent='Neue Kombinationen auf dem Wegenetz suchen …';
  try{
    const response=await compute('generate',{options:{mode,start,end,waypoints,distanceKm:distance,lengthTolerance:Number($('length-tolerance').value),hills:Number($('hills').value),turns:Number($('turns').value),seed}});
    result=response.result;selectedVariant=0;renderResult();setBusy(false);if(fit||isMobile()){map.fit(result.routes[0].geometry,true);}if(isMobile())window.scrollTo({top:0,behavior:'smooth'});
  }catch(e){setBusy(false);if(e.details?.connectionIssue){
    connectionIssue=e.details.connectionIssue;$('connection-issue-message').textContent=connectionIssue.message;$('connection-issue').hidden=false;
    map.connectionGeometry=connectionIssue.sections.map(s=>s.geometry);map.schedule();$('connection-issue').scrollIntoView({behavior:'smooth',block:'nearest'});
  }toast(e.message,true);}
}
$('generate').addEventListener('click',()=>generate(false));
$('regenerate').addEventListener('click',()=>generate(false));
function renderResult(){
  connectionIssue=null;$('connection-issue').hidden=true;map.connectionGeometry=[];
  if(!result)return;const r=result.routes[selectedVariant];map.setRoute(r);$('route-card').hidden=false;$('route-length').textContent=km(r.length);$('route-ascent').textContent=r.ascent===null?'—':number(r.ascent)+' ↑ / '+number(r.descent)+' ↓';$('route-repeat').textContent=number((r.quality?.nearRetraced??r.repeated)/r.length*100,1)+' %';
  const count=r.manualWaypoints?.length||r.waypoints?.length||0;
  $('route-footnote').textContent=`* Höhen aus GPX geschätzt. Befahrbarkeit vor Ort prüfen.${r.pushingLength?' Mögliche Schiebepassagen: '+number(r.pushingLength)+' m.':''}${r.uncertainLength?' Ungeprüfte GPX-Wege: '+number(r.uncertainLength)+' m.':''}${r.restrictedLength?' OSM-Zugang eingeschränkt: '+number(r.restrictedLength)+' m – vor Fahrt prüfen.':''}`;
  $('route-strategy').textContent=count?`${count} ${r.manualWaypoints?.length?(count===1?'GESETZTER PUNKT':'GESETZTE PUNKTE'):(count===1?'ZWISCHENZIEL':'ZWISCHENZIELE')} · ${result.mode==='loop'?'RUNDTOUR':'A → B'}`:'DEIN ROUTENVORSCHLAG';
  const profile=$('elevation-profile');profile.replaceChildren();
  const points=r.geometry.filter(p=>Number.isFinite(p[2]));const distances=[0];for(let i=1;i<points.length;i++){const a=project(points[i-1],network.origin),b=project(points[i],network.origin);distances.push(distances.at(-1)+Math.hypot(b[0]-a[0],b[1]-a[1]));}
  if(points.length>1){const elevations=points.map(p=>p[2]),min=Math.min(...elevations),max=Math.max(...elevations),range=Math.max(10,max-min);let d='M0 50';
    points.forEach((p,i)=>{d+=` L${(distances[i]/Math.max(1,distances.at(-1))*400).toFixed(1)} ${(46-(p[2]-min)/range*40).toFixed(1)}`;});d+=' L400 50 Z';
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);path.setAttribute('fill','#d5ec8b');profile.append(path);
    profile.setAttribute('aria-label',`Höhenprofil, ${number(min)} bis ${number(max)} Meter. Entfernung entlang der Route.`);
  }
  const match=$('route-match');match.classList.toggle('outside',!r.withinTolerance);match.textContent=r.withinTolerance?'Innerhalb Wunschlänge':'Wunschlänge verfehlt';
  $('variant-buttons').replaceChildren();
  result.routes.forEach((route,i)=>{const b=document.createElement('button');b.textContent=String(i+1).padStart(2,'0');b.classList.toggle('selected',i===selectedVariant);b.title=`Variante ${i+1}: ${km(route.length)} km`;b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(i===selectedVariant));b.addEventListener('click',()=>{selectedVariant=i;renderResult();if(isMobile())map.fit(result.routes[i].geometry,true);});$('variant-buttons').append(b);});
  const warnings=[];if(r.connectionLength)warnings.push(`${number(r.connectionLength)} m gezielte OSM-Ergänzung über den Schmöckwitzwerdersteg.`);if(r.uncertainLength>30)warnings.push(`${km(r.uncertainLength)} km ungeprüfte Original-GPX-Wege · violett markiert.`);
  if(!r.withinTolerance)warnings.push(`Ziel: ${km(result.target)} km ± ${number(result.lengthTolerance*100)} %. Beste gefundene Variante: ${km(r.length)} km.`);
  if(result.shortest>result.target*(1+result.lengthTolerance))warnings.push(r.manualWaypoints?.length?`Schon die kürzesten Teilwege über deine Punkte ergeben ${km(result.shortest)} km.`:`Schon die kürzeste Verbindung ist ${km(result.shortest)} km lang.`);
  if(r.repeatedRatio>.15)warnings.push('Diese Variante fährt mehrere Abschnitte doppelt. Ein anderer Startpunkt oder eine andere Länge kann helfen.');
  $('route-warning').textContent=warnings.join(' ');$('route-warning').hidden=!warnings.length;
  $('export-gpx').title=`Seed: ${r.seed}`;
}
function download(text,type,file){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=file;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
$('export-gpx').addEventListener('click',()=>{
  if(!result)return;const r=result.routes[selectedVariant],name=`Randomizer ${mode==='ab'?'A nach B':'Rundtour'} ${km(r.length)} km`;
  download(toGPX(r,name),'application/gpx+xml',`randomizer-${(r.length/1000).toFixed(1)}km-${r.seed.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,30)||'route'}.gpx`);toast('GPX-Datei exportiert. Der Seed steht in der Datei.');
});
$('export-network').addEventListener('click',()=>{if(network)download(JSON.stringify(networkGeoJSON(network),null,2),'application/geo+json','randomizer-wegenetz.geojson');});

export function parseGPX(text,fileName,id,color){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.getElementsByTagName('parsererror').length)throw new Error(`${fileName}: Die Datei ist kein gültiges GPX/XML.`);
  if(doc.documentElement.localName!=='gpx')throw new Error(`${fileName}: Das GPX-Wurzelelement fehlt.`);
  const all=(parent,name)=>[...parent.getElementsByTagNameNS('*',name)];
  const readPoints=(parent,tag)=>all(parent,tag).map(p=>{
    const lon=Number(p.getAttribute('lon')),lat=Number(p.getAttribute('lat')),ele=all(p,'ele')[0]?.textContent;
    if(!p.hasAttribute('lon')||!p.hasAttribute('lat')||!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lon)>180||Math.abs(lat)>85)throw new Error(`${fileName}: Ungültige GPX-Koordinate.`);
    return[lon,lat,ele!==undefined&&ele.trim()!==''&&Number.isFinite(Number(ele))?Number(ele):null];
  });
  const segments=[];for(const seg of all(doc,'trkseg')){const p=readPoints(seg,'trkpt');if(p.length>1)segments.push(p);}
  for(const rte of all(doc,'rte')){const p=readPoints(rte,'rtept');if(p.length>1)segments.push(p);}
  if(!segments.length)throw new Error(`${fileName}: Keine Track- oder Routenlinie mit mindestens zwei Punkten gefunden.`);
  const track=all(doc,'trk')[0]||all(doc,'rte')[0],name=track?[...track.children].find(n=>n.localName==='name')?.textContent:null;
  return quickStats({id,name:name?.trim()||fileName.replace(/\.gpx$/i,''),fileName,segments,color});
}
$('import').addEventListener('click',()=>$('files').click());
$('files').addEventListener('change',async event=>{
  const files=[...event.target.files];event.target.value='';if(!files.length||busy)return;
  setBusy(true,'GPX-Dateien importieren');$('busy-stage').textContent='Track- und Routenpunkte einlesen …';
  const imported=[],errors=[];let points=tracks.reduce((s,r)=>s+r.points,0);
  for(const file of files){
    try{
      if(file.size>20*1024*1024)throw new Error(`${file.name}: Für diesen MVP bitte Dateien kleiner als 20 MB verwenden.`);
      if(tracks.some(r=>r.fileName===file.name)||imported.some(r=>r.fileName===file.name))throw new Error(`${file.name}: Bereits im Datensatz.`);
      const route=parseGPX(await file.text(),file.name,'import-'+Date.now()+'-'+imported.length,palette[(tracks.length+imported.length)%palette.length]);
      if(points+route.points>100000)throw new Error('Maximal 100.000 GPX-Punkte in diesem MVP. Bitte vorher Tracks entfernen.');
      imported.push(route);points+=route.points;
    }catch(e){errors.push(e.message);}
  }
  setBusy(false);
  if(imported.length){tracks.push(...imported);await rebuild(true);switchTab('data');}
  if(errors.length)toast(errors.join(' '),true);else if(imported.length)toast(`${imported.length} GPX-Datei${imported.length===1?'':'en'} importiert und im Wegenetz verbunden.`);
});
$('restore-demo').addEventListener('click',async()=>{if(busy)return;tracks=structuredClone(demo).map(quickStats);start=null;end=null;await rebuild(true);toast(`${demo.length} Tracks aus dem Routenpaket sind wieder geladen.`);});
async function init(){
  try{demo=await fetch(new URL('../data/demo-tracks.json',import.meta.url)).then(r=>{if(!r.ok)throw new Error('Der Testdatensatz konnte nicht geladen werden.');return r.json();});
    const base=await fetch(new URL('../data/osm-reference.json',import.meta.url)).then(r=>{if(!r.ok)throw new Error('Die OSM-Referenzdaten konnten nicht geladen werden.');return r.json();});osmReference=await loadReference(base);
    tracks=structuredClone(demo).map(quickStats);renderTracks();await rebuild(true);
  }catch(e){setBusy(false);$('busy').hidden=false;$('busy').classList.add('error');$('busy-title').textContent='Testdatensatz nicht verfügbar';$('busy-stage').textContent=e.message;toast(e.message,true);}
}
init();
// Read-only QA hook: local state, no credentials or external operations.
window.gpxLab={get network(){return network;},get result(){return result;},get tracks(){return tracks;},parseGPX};
