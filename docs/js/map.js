const WORLD = 256, MAX_LAT = 85.05112878;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function world(p) {const lat = clamp(p[1], -MAX_LAT, MAX_LAT) * Math.PI / 180; return [(p[0] + 180) / 360, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2];}
function geographic(p) {return [p[0] * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * p[1]))) * 180 / Math.PI];}

export class NetworkMap {
  constructor(container, onClick) {
    this.container = container; this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-label','Karte: zum Verschieben ziehen, zum Zoomen scrollen; Start, Ziel und Zwischenpunkte über die Schaltflächen wählen.'); this.canvas.tabIndex = 0;
    container.append(this.canvas); this.ctx = this.canvas.getContext('2d');
    this.center = world([13.605,52.44]); this.zoom = 11.5; this.width = 1; this.height = 1;
    this.layers = {network: true, original: false, nodes: false, basemap: true, uncertain:false};
    this.network = null; this.routes = []; this.route = null; this.start = null; this.end = null; this.waypoints = []; this.connectionGeometry=[];this.extensionGeometry=[];
    this.frame = null; this.highlightNode = null;
    const observer = new ResizeObserver(() => this.resize()); observer.observe(container);
    let drag = null;
    this.canvas.addEventListener('pointerdown', e => {
      this.canvas.focus({preventScroll:true});
      drag = {x:e.clientX,y:e.clientY,center:[...this.center],moved:false}; this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX-drag.x, dy=e.clientY-drag.y; if (Math.hypot(dx,dy)>4) drag.moved=true;
      const size=WORLD*2**this.zoom; this.center=[drag.center[0]-dx/size,clamp(drag.center[1]-dy/size,0,1)]; this.schedule();
    });
    this.canvas.addEventListener('pointerup', e => {
      if (!drag) return;
      if (!drag.moved) {const rect=this.canvas.getBoundingClientRect();const x=e.clientX-rect.left,y=e.clientY-rect.top;onClick(this.toGeo([x,y]),[x,y]);}
      drag=null;
    });
    this.canvas.addEventListener('pointercancel',()=>drag=null);
    this.canvas.addEventListener('wheel',e=>{e.preventDefault();const rect=this.canvas.getBoundingClientRect();this.zoomBy(e.deltaY>0?-.35:.35,[e.clientX-rect.left,e.clientY-rect.top]);},{passive:false});
    this.canvas.addEventListener('dblclick',e=>{e.preventDefault();const rect=this.canvas.getBoundingClientRect();this.zoomBy(1,[e.clientX-rect.left,e.clientY-rect.top]);});
    this.canvas.addEventListener('keydown',e=>{
      if(e.key==='+'||e.key==='='){this.zoomBy(.5);e.preventDefault();}
      if(e.key==='-'){this.zoomBy(-.5);e.preventDefault();}
      const shifts={ArrowLeft:[-80,0],ArrowRight:[80,0],ArrowUp:[0,-80],ArrowDown:[0,80]};
      if(shifts[e.key]){e.preventDefault();const d=shifts[e.key],s=WORLD*2**this.zoom;this.center=[this.center[0]+d[0]/s,this.center[1]+d[1]/s];this.schedule();}
    });
    this.resize();
    this.tiles=new Map();
    try{if(window.maplibregl){
      const bg=document.createElement('div');bg.className='basemap-host';container.prepend(bg);
      this.base=new window.maplibregl.Map({container:bg,style:'https://tiles.openfreemap.org/styles/liberty',center:[13.605,52.44],zoom:this.zoom-1,interactive:false,attributionControl:true});
      this.base.on('load',()=>{document.getElementById('map-service-status').textContent='';this.schedule();});
      this.base.on('error',()=>{document.getElementById('map-service-status').textContent='Kartenhintergrund nicht erreichbar · Netz bleibt nutzbar';});
    }}catch(e){this.base=null;document.getElementById('map-service-status').textContent='Rasterkarte wird geladen …';}

  }
  resize(){const r=this.container.getBoundingClientRect();this.width=r.width;this.height=r.height;const dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.round(r.width*dpr);this.canvas.height=Math.round(r.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);this.schedule();}
  toScreen(p){const w=world(p),s=WORLD*2**this.zoom;return[(w[0]-this.center[0])*s+this.width/2,(w[1]-this.center[1])*s+this.height/2];}
  toGeo(p){const s=WORLD*2**this.zoom;return geographic([this.center[0]+(p[0]-this.width/2)/s,this.center[1]+(p[1]-this.height/2)/s]);}
  zoomBy(delta,at=[this.width/2,this.height/2]){const anchor=this.toGeo(at);this.zoom=clamp(this.zoom+delta,6,18.5);const w=world(anchor),s=WORLD*2**this.zoom;this.center=[w[0]-(at[0]-this.width/2)/s,w[1]-(at[1]-this.height/2)/s];this.schedule();}
  fit(points,route=false){
    if(!points?.length)return;
    const projected=points.map(world),xs=projected.map(p=>p[0]),ys=projected.map(p=>p[1]);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const bottom=route?205:185,top=120,pad=65;
    const w=Math.max(100,this.width-pad*2),h=Math.max(100,this.height-top-bottom);
    this.zoom=clamp(Math.log2(Math.min(w/((maxX-minX)*WORLD||1),h/((maxY-minY)*WORLD||1))),6,17);
    const s=WORLD*2**this.zoom;this.center=[(minX+maxX)/2,(minY+maxY)/2+(bottom-top)/2/s];this.schedule();
  }
  fitNetwork(){if(this.network)this.fit(this.network.edges.flatMap(e=>e.geometry));}
  setNetwork(network,routes){this.extensionGeometry=[];this.network=network;this.routes=routes;this.highlightNode=null;this.schedule();}
  setRoute(route){this.route=route;this.schedule();}
  schedule(){if(this.frame!==null)return;this.frame=requestAnimationFrame(()=>{this.frame=null;this.draw();});}
  path(points,color,width,alpha=1){
    if(!points.length)return;
    const c=this.ctx;c.beginPath();for(let i=0;i<points.length;i++){const [x,y]=this.toScreen(points[i]);if(i===0)c.moveTo(x,y);else c.lineTo(x,y);}
    c.strokeStyle=color;c.lineWidth=width;c.globalAlpha=alpha;c.lineCap='round';c.lineJoin='round';c.stroke();c.globalAlpha=1;
  }
  background(){
    const c=this.ctx;c.clearRect(0,0,this.width,this.height);
    if(this.base){const pos=geographic(this.center);this.base.getContainer().style.display=this.layers.basemap?'block':'none';this.base.resize();this.base.jumpTo({center:pos,zoom:this.zoom-1});if(this.layers.basemap)return;}
    c.fillStyle='#edf0e8';c.fillRect(0,0,this.width,this.height);
    if(this.layers.basemap){
      const z=Math.min(18,Math.floor(this.zoom)),n=2**z,sz=256*2**(this.zoom-z),cx=this.center[0]*n,cy=this.center[1]*n;
      for(let x=Math.floor(cx-this.width/2/sz);x<=Math.ceil(cx+this.width/2/sz);x++)for(let y=Math.floor(cy-this.height/2/sz);y<=Math.ceil(cy+this.height/2/sz);y++){
        const key=`${z}/${y}/${x}`;let tile=this.tiles.get(key);
        if(!tile){tile=new Image();this.tiles.set(key,tile);tile.onload=()=>{document.getElementById('map-service-status').textContent='© basemap.de / BKG · Datenquellen: basemap.de';this.schedule();};tile.onerror=()=>{document.getElementById('map-service-status').textContent='Hintergrundkarte nicht erreichbar';};tile.src=`https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/${key}.png`;}
        if(tile.complete&&tile.naturalWidth)c.drawImage(tile,(x-cx)*sz+this.width/2,(y-cy)*sz+this.height/2,sz+.5,sz+.5);
      }
      return;
    }
    // Local geographic grid: the MVP needs no external map service.
    if(!this.layers.basemap)return;
    const a=this.toGeo([0,0]),b=this.toGeo([this.width,this.height]);
    const step=this.zoom>13?.005:this.zoom>11?.02:.05;
    c.strokeStyle='#dce3d5';c.lineWidth=.65;c.fillStyle='#a7b49e';c.font='8px ui-sans-serif,system-ui';
    for(let lon=Math.ceil(a[0]/step)*step;lon<b[0];lon+=step){const x=this.toScreen([lon,a[1]])[0];c.beginPath();c.moveTo(x,0);c.lineTo(x,this.height);c.stroke();c.fillText(lon.toFixed(3)+'° E',x+5,this.height-15);}
    for(let lat=Math.ceil(b[1]/step)*step;lat<a[1];lat+=step){const y=this.toScreen([a[0],lat])[1];c.beginPath();c.moveTo(0,y);c.lineTo(this.width,y);c.stroke();c.fillText(lat.toFixed(3)+'° N',5,y-5);}
  }
  marker(p,letter,fill){if(!p)return;const[x,y]=this.toScreen(p),c=this.ctx;c.beginPath();c.arc(x,y,10,0,Math.PI*2);c.fillStyle='#fbfcf9';c.fill();c.beginPath();c.arc(x,y,7.6,0,Math.PI*2);c.fillStyle=fill;c.fill();c.strokeStyle='#344d3c';c.lineWidth=1.3;c.stroke();c.fillStyle='#263b30';c.font='bold 8px ui-sans-serif,system-ui';c.textAlign='center';c.textBaseline='middle';c.fillText(letter,x,y+.5);c.textAlign='start';c.textBaseline='alphabetic';}
  draw(){
    this.background();const c=this.ctx,n=this.network;
    if(this.layers.original)for(const r of this.routes)for(const p of r.segments)this.path(p,r.color||'#9c79a7',this.layers.network?1.5:2.5,.8);
    if(n&&this.layers.network)for(const e of n.edges){this.path(e.geometry,'#fbfcf9',this.zoom>13?5:3.7,.65);if(e.unclear){c.save();c.setLineDash([4,4]);this.path(e.geometry,'#a36891',2,.9);c.restore();}else this.path(e.geometry,'#3d7e80',this.zoom>13?2.3:1.7,.85);}
    if(n&&this.layers.uncertain){c.save();c.setLineDash([4,4]);for(const item of n.uncertain||[])this.path(item.geometry,'#a36891',2,.9);c.restore();}
    if(this.route){
      this.path(this.route.geometry,'#fffdf7',7.5);this.path(this.route.geometry,'#ed7353',4.2);c.save();c.setLineDash([4,4]);for(const g of this.route.uncertainGeometry||[])this.path(g,'#8d4d91',2.4);c.restore();
      let walked=0;const g=this.route.geometry;
      for(let i=1;i<g.length;i++){const a=this.toScreen(g[i-1]),b=this.toScreen(g[i]),length=Math.hypot(b[0]-a[0],b[1]-a[1]);walked+=length;
        if(walked>125&&length>6){const x=(a[0]+b[0])/2,y=(a[1]+b[1])/2,angle=Math.atan2(b[1]-a[1],b[0]-a[0]);c.save();c.translate(x,y);c.rotate(angle);c.beginPath();c.moveTo(-3,-3);c.lineTo(1,0);c.lineTo(-3,3);c.strokeStyle='#fff9ef';c.lineWidth=1.3;c.stroke();c.restore();walked=0;}
      }
    }
    for(const shape of this.connectionGeometry){this.path(shape,'#fffdf7',7);this.path(shape,'#b58125',3.5);}
    for(const shape of this.extensionGeometry){this.path(shape,'#fffdf7',7);this.path(shape,'#71933c',3.5);}
    if(n&&this.layers.nodes){
      for(const node of n.nodes){const[x,y]=this.toScreen(node.coord),radius=this.zoom>13?4.2:2.8;
        if(x<0||y<0||x>this.width||y>this.height)continue;
        c.beginPath();c.arc(x,y,radius,0,Math.PI*2);c.fillStyle=node.kind==='snap'?'#dfb870':node.degree<=1?'#9caba2':'#edf2df';c.fill();c.strokeStyle=node.kind==='snap'?'#a68549':'#416c65';c.lineWidth=.9;c.stroke();
      }
      for(const item of n.blocked){const[x,y]=this.toScreen(item.coord);c.strokeStyle='#9c9f93';c.lineWidth=1;c.beginPath();c.moveTo(x-3,y-3);c.lineTo(x+3,y+3);c.moveTo(x-3,y+3);c.lineTo(x+3,y-3);c.stroke();}
    }
    if(this.highlightNode){const[x,y]=this.toScreen(this.highlightNode.coord);c.beginPath();c.arc(x,y,12,0,Math.PI*2);c.strokeStyle='#9baf64';c.lineWidth=2;c.stroke();}
    if(!this.waypoints.length)for(const [i,p]of (this.route?.waypoints||[]).entries())this.marker(p,String(i+1),'#fff0ca');
    for(const [i,p]of this.waypoints.entries())this.marker(p,String(i+1),'#ffdba4');
    this.marker(this.start,'S','#d5eb92');this.marker(this.end,'Z','#ccdad1');
    const lat=this.toGeo([this.width/2,this.height/2])[1],mpp=Math.cos(lat*Math.PI/180)*40075016.686/(WORLD*2**this.zoom),aim=mpp*80;
    const exp=10**Math.floor(Math.log10(aim)),scale=[1,2,5,10].map(x=>x*exp).find(x=>x>=aim)||aim;
    document.getElementById('map-scale').textContent=scale>=1000?`${scale/1000} km`:`${Math.round(scale)} m`;
    document.getElementById('map-scale').style.width=scale/mpp+'px';
  }
  closestNode(pixel){if(!this.network)return null;let best=null,distance=14;for(const n of this.network.nodes){const p=this.toScreen(n.coord),d=Math.hypot(pixel[0]-p[0],pixel[1]-p[1]);if(d<distance){distance=d;best=n;}}return best;}
}
