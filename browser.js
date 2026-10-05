"use strict";
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const state = {catalog: [], contigs: new Map(), regions: [], targets: [], mode: "free", view: "tracks", result: null, pair: "", controller: null, generation: 0, offline: false, snapshot: null};
let apiBase = new URLSearchParams(location.search).get("api") || "";
try { apiBase ||= localStorage.getItem("vgp-region-api") || ""; } catch {}
apiBase = apiBase.replace(/\/+$/, "");
const colors = {"+": "#2267aa", "-": "#ce725e"};
const fmt = (n) => Number(n).toLocaleString("en-US");
const compact = (n) => n >= 1e6 ? `${(n/1e6).toFixed(2)} Mb` : n >= 1e3 ? `${(n/1e3).toFixed(1)} kb` : `${n} bp`;
function element(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function svgElement(tag, attrs = {}, text = null) { const node = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k, v); if (text != null) node.textContent = text; return node; }
function status(text, kind = "") { $("status").textContent = text; $("status").className = kind; }
async function api(path, options = {}) {
  const response = await fetch(apiBase ? `${apiBase}/${path}` : path, options);
  const data = await response.json().catch(() => ({detail: "The region API is unavailable. Run browser_server.py to serve this page."}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
  return data;
}
function sample(acc) { return state.catalog.find(s => s.accession === acc); }
async function getContigs(acc) {
  if (!state.contigs.has(acc)) state.contigs.set(acc, (await (state.offline ? fetch(`browser-data/contigs/${encodeURIComponent(acc)}.json`).then(r=>{if(!r.ok)throw new Error("Connect a query API to load this assembly.");return r.json();}) : api(`api/contigs/${encodeURIComponent(acc)}`))).contigs);
  return state.contigs.get(acc);
}
function lockPreviewInputs() {
  for(const node of document.querySelectorAll("#region-list input,#region-list select,#region-list button,#target-list button,.sample button,.query-controls input,.query-controls select,#mode-free,#mode-anchor"))node.disabled=state.offline;
  $("run-query").disabled=state.offline;$("run-query").textContent=state.offline?"Custom regions require API":"Browse alignments →";
}
function invalidate() {
  state.generation++;
  state.controller?.abort();
  state.result = null; $("export-query").disabled = true; $("share-query").disabled = true;
  $("result-stats").textContent = ""; $("run-query").disabled = false; $("run-query").textContent = "Browse alignments →";
  $("visualization").replaceChildren(element("div", "The selection changed. Browse alignments to update this view.", "empty-view"));
  $("pair-picker").hidden = true;
  $("details").replaceChildren(element("div", "03 / INSPECT EVIDENCE", "eyebrow"), element("h3", "Feature details"), element("p", "Select a feature after querying.", "muted"));
  status("Selection changed. Browse alignments to update this view.");
}
function renderCatalog() {
  const term = $("sample-search").value.trim().toLowerCase();
  const clade = $("clade-filter").value;
  const found = state.catalog.filter(s => (!clade || s.clade === clade) && [s.name,s.common,s.accession,...s.aliases].join(" ").toLowerCase().includes(term));
  $("catalog-count").textContent = `${fmt(found.length)} assemblies · ${state.regions.length} input windows`;
  $("sample-list").replaceChildren(...found.map(s => {
    const row = element("div", null, "sample"); const info = element("div", null, "sample-info");
    info.append(element("b", s.name), element("small", `${s.accession} · ${s.clade}`), element("small", s.annotation === "available" ? "Gene annotation available" : `Gene annotation unavailable · ${s.annotation_status}`, "annotation-tag"));
    const button = element("button", "+"); button.title = `Add ${s.name}`; button.setAttribute("aria-label", `Add ${s.name}`);
    button.onclick = () => addAssembly(s.accession).catch(e => status(e.message,"error")); row.append(info,button); return row;
  }));lockPreviewInputs();
}
async function addAssembly(acc, supplied = null) {
  if (state.mode === "anchor" && state.regions.length) {
    if (acc !== state.regions[0].accession && !state.targets.includes(acc)) { invalidate(); state.targets.push(acc); renderRegions(); }
    return;
  }
  if (state.regions.length >= 16) throw new Error("At most 16 input windows per query. Remove a window first.");
  const contigs = await getContigs(acc);
  if (!contigs.length) throw new Error(`No sequences found for ${acc}`);
  invalidate(); state.regions.push(supplied || {accession: acc, seq: contigs[0].seq, start: 0, end: Math.min(contigs[0].length, 100000)});
  renderRegions(); renderCatalog();
}
function moveRegion(i, delta) { const j=i+delta; if (j<0 || j>=state.regions.length) return; invalidate(); [state.regions[i],state.regions[j]]=[state.regions[j],state.regions[i]]; renderRegions(); }
function adjustRegion(i, action) {
  if(state.offline){status("This is a recorded real-data preview. Connect a query API to change intervals.");return;}
  const region = state.regions[i]; const length = state.contigs.get(region.accession).find(c => c.seq === region.seq).length;
  const span = region.end-region.start; let start=region.start, end=region.end;
  if (action === "left" || action === "right") { const shift = Math.round(span/2)*(action === "left" ? -1 : 1); start+=shift; end+=shift; }
  else { const next=Math.max(10,Math.round(span*(action === "in" ? .5 : 2))); start=Math.round((start+end-next)/2); end=start+next; }
  if (start<0) {end-=start;start=0;} if(end>length){start-=end-length;end=length;} region.start=Math.max(0,start);region.end=end;
  invalidate(); renderRegions();
}
function renderRegions() {
  $("mode-free").classList.toggle("active", state.mode === "free"); $("mode-anchor").classList.toggle("active", state.mode === "anchor");
  $("mode-help").textContent = state.mode === "free" ? "Each row has its own coordinates. Compare any selected intervals using direct pairwise alignments." : "The first assembly is your anchor. Matching loci in the selected targets are returned separately, including multiple mappings. Loci within 10 kb are grouped for display.";
  $("region-list").replaceChildren(...state.regions.map((r,i) => {
    const row=element("div",null,"region"); const name=element("div",null,"region-name");name.append(element("b",sample(r.accession).name),element("small",r.accession));row.append(name);
    const seqLabel=element("label","Sequence"); const select=element("select"); select.setAttribute("aria-label",`Sequence ${i+1}`);
    for(const c of state.contigs.get(r.accession)||[]){const opt=element("option",`${c.seq.split("#").at(-1)} · ${compact(c.length)}`);opt.value=c.seq;select.append(opt);}
    select.value=r.seq;select.onchange=()=>{invalidate();r.seq=select.value;r.start=0;r.end=Math.min(state.contigs.get(r.accession).find(c=>c.seq===r.seq).length,100000);renderRegions();};seqLabel.append(select);row.append(seqLabel);
    for(const key of ["start","end"]){const label=element("label",key==="start"?"Start (0-based)":"End (exclusive)");const input=element("input");input.type="number";input.min="0";input.step="1";input.value=r[key];input.setAttribute("aria-label",`${key} ${i+1}`);input.onchange=()=>{invalidate();r[key]=Number(input.value);};label.append(input);row.append(label);}
    const controls=element("div",null,"region-buttons");for(const [label,action,title] of [["←","left","Pan left"],["+","in","Zoom in"],["−","out","Zoom out"],["→","right","Pan right"]]){const b=element("button",label);b.title=title;b.onclick=()=>adjustRegion(i,action);controls.append(b);}
    if(state.mode==="free"){const b=element("button","↑");b.title="Move track up";b.disabled=i===0;b.onclick=()=>moveRegion(i,-1);controls.append(b);}
    const remove=element("button","×");remove.title="Remove region";remove.onclick=()=>{invalidate();state.regions.splice(i,1);renderRegions();renderCatalog();};controls.append(remove);row.append(controls);return row;
  }));
  $("target-list").hidden=state.mode!=="anchor";$("target-list").replaceChildren();
  if(state.mode==="anchor"){
    $("target-list").append(element("p","Target assemblies — add from the catalogue:"));
    for(const acc of state.targets){const chip=element("span",sample(acc).name,"target-chip");const b=element("button","×");b.title=`Remove ${acc}`;b.onclick=()=>{invalidate();state.targets=state.targets.filter(a=>a!==acc);renderRegions();};chip.append(b);$("target-list").append(chip);}
  }
  lockPreviewInputs();
}
function setMode(mode) {
  if(mode===state.mode)return;invalidate();
  if(mode==="anchor"){state.targets=[...new Set(state.regions.slice(1).map(r=>r.accession))].filter(a=>a!==state.regions[0]?.accession);state.regions=state.regions.slice(0,1);}
  else state.targets=[];
  state.mode=mode;renderRegions();renderCatalog();
}
function makeRequest() {
  const identity=Number($("min-identity").value),length=Number($("min-length").value);
  if(!Number.isFinite(identity)||identity<0||identity>100||!Number.isInteger(length)||length<0)throw new Error("Filters require identity 0–100% and a non-negative integer block length.");
  for(const r of state.regions){const contig=state.contigs.get(r.accession)?.find(c=>c.seq===r.seq);if(!contig||!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end<=r.start||r.end>contig.length)throw new Error(`Invalid interval for ${r.accession}: use 0 ≤ start < end ≤ ${contig?.length}.`);}
  if(state.mode==="free"&&state.regions.length<2)throw new Error("Select at least two region windows.");
  if(state.mode==="anchor"&&(!state.regions.length||!state.targets.length))throw new Error("Select an anchor region and at least one target assembly.");
  return {dataset:$("dataset").value,mode:state.mode,windows:state.regions.map(r=>({...r})),targets:[...state.targets],min_identity:identity/100,min_length:length,direction:$("direction").value};
}
async function runQuery() {
  if(state.offline){status("This is a recorded real-data preview. Connect a query API to query new regions.");return;}
  let request;try{request=makeRequest();}catch(e){status(e.message,"error");return;}
  state.controller?.abort();state.controller=new AbortController();const generation=++state.generation;
  $("run-query").disabled=true;$("run-query").textContent="Querying…";$("export-query").disabled=true;$("share-query").disabled=true;
  status("Reading indexed alignments and annotation. First access to an assembly builds its annotation cache.","loading");
  try{
    const result=await api("api/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request),signal:state.controller.signal});
    if(generation!==state.generation)return;
    state.result=result;state.pair="";for(const w of result.windows)await getContigs(w.accession);
    if(generation!==state.generation)return;
    const missing=result.pairs.filter(p=>p.status==="missing_file").length;
    const warnings=[];if(missing)warnings.push(`${missing} pair(s) have no local PAF`);if(result.truncated)warnings.push(`showing 5,000 of ${fmt(result.total_blocks)} alignment blocks — narrow the interval`);
    if(result.windows.some(w=>w.annotation.truncated))warnings.push("annotation display limited to 5,000 features per window");
    status(`${fmt(result.total_blocks)} blocks across ${result.windows.length} windows · ${result.elapsed_seconds.toFixed(2)} s.${warnings.length?" "+warnings.join("; ")+".":""}`,warnings.length?"error":"");
    $("result-title").textContent=request.mode==="anchor"?"Anchor-linked loci":"Direct pairwise alignments";
    $("result-subtitle").textContent=`${request.dataset} · independent assembly coordinates · ${result.coordinate_system}`;
    $("result-stats").textContent=`${fmt(result.total_blocks)} blocks / ${result.windows.length} windows`;
    $("export-query").disabled=false;$("share-query").disabled=false;renderView();
  }catch(e){if(e.name!=="AbortError"){state.result=null;status(e.message,"error");$("visualization").replaceChildren(element("div",`Query failed: ${e.message}`,"fatal-overlay"));}}
  finally{if(generation===state.generation){$("run-query").disabled=false;$("run-query").textContent="Browse alignments →";}}
}
function inspect(title, values) {
  const dl=element("dl");for(const [key,value] of Object.entries(values)){dl.append(element("dt",key),element("dd",value==null?"Unavailable":typeof value==="object"?JSON.stringify(value):String(value)));}
  $("details").replaceChildren(element("div","03 / INSPECT EVIDENCE","eyebrow"),element("h3",title),dl);
}
function inspectBlock(b) {
  inspect("Direct alignment · interval projection",{"Source direction":b.source_direction,"Target":`${b.target_seq}:${b.target_start}-${b.target_end}`,"Query":`${b.query_seq}:${b.query_start}-${b.query_end}`,"Strand":b.strand,"Base identity":`${(b.identity*100).toFixed(2)}%`,"Gap-compressed identity":b.gap_compressed_identity==null?null:`${(b.gap_compressed_identity*100).toFixed(2)}%`,"Aligned columns":b.alignment_length,"Matching bases":b.matches,"MAPQ":b.mapq,"CIGAR":b.cigar||"Unavailable after orientation normalization","Source PAF":b.source,"Coordinates":"0-based half-open","Provenance":b.provenance});
}
function trackX(w, pos, width) { return 215+(pos-w.start)/(w.end-w.start)*(width-240); }
function axis(svg,w,y,width) {
  svg.append(svgElement("line",{x1:215,x2:width-25,y1:y,y2:y,class:"axis"}));
  for(let t=0;t<=4;t++){const pos=Math.round(w.start+(w.end-w.start)*t/4),x=trackX(w,pos,width);svg.append(svgElement("line",{x1:x,x2:x,y1:y-3,y2:y+4,class:"axis"}),svgElement("text",{x,y:y-10,"text-anchor":t===0?"start":t===4?"end":"middle"},fmt(pos)));}
}
function adoptWindow(i) {
  if(state.offline){status("Connect a query API to browse a new anchor or interval.");return;}
  const result=state.result;const w=result.windows[i];
  if(state.mode==="anchor"){state.targets=[...new Set(result.windows.map(r=>r.accession))].filter(a=>a!==w.accession);state.regions=[{accession:w.accession,seq:w.seq,start:w.start,end:w.end}];}
  else state.regions=result.windows.slice(0,16).map(({accession,seq,start,end})=>({accession,seq,start,end}));
  invalidate();renderRegions();status("Result coordinates copied to the input. Adjust or browse again.");
}
function drawGenes(svg,w,y,width) {
  const ann=w.annotation,genes=ann.features.filter(f=>["gene","pseudogene"].includes(f.kind));
  const parents=new Map();for(const f of ann.features){if(f.id)parents.set(f.id,(f.parent||"").split(",").filter(Boolean));}
  function belongs(f,gene) {let pending=(f.parent||"").split(",").filter(Boolean),seen=new Set();while(pending.length){const id=pending.pop();if(id===gene.id)return true;if(seen.has(id))continue;seen.add(id);pending.push(...(parents.get(id)||[]));}return false;}
  const group=svgElement("g",{"clip-path":"url(#track-clip)"}),laneEnds=[-Infinity,-Infinity,-Infinity],labelEnds=[-Infinity,-Infinity,-Infinity];
  for(const gene of genes){const left=trackX(w,Math.max(gene.start,w.start),width),right=trackX(w,Math.min(gene.end,w.end),width);
    let lane=laneEnds.findIndex(end=>end+4<left);if(lane<0)lane=laneEnds.indexOf(Math.min(...laneEnds));laneEnds[lane]=Math.max(laneEnds[lane],right);const gy=y+15+lane*16;
    const sourceDetails=f=>inspect(`${f.kind} · ${f.name}`,{"Assembly":w.accession,"Assembly sequence":w.seq,"GFF sequence":f.seq,"Interval":`${f.start}-${f.end}`,"Strand":f.strand,"ID":f.id,"Parent":f.parent,"Gene":gene.name,"Annotation assembly":ann.annotation_accession,"Mapping":ann.mapping,"Source":ann.source,"Coordinates":"0-based half-open (converted from GFF)","Display":"Exons and CDS from all isoforms are overlaid within each gene"});
    const line=svgElement("line",{x1:left,x2:right,y1:gy,y2:gy,stroke:"#368775","stroke-width":2,class:"gene",tabindex:0,role:"button","aria-label":`gene ${gene.name}`});line.append(svgElement("title",{},`${gene.name} · ${gene.strand} · ${gene.start}-${gene.end} · collapsed isoforms`));line.onclick=()=>sourceDetails(gene);line.onkeydown=e=>{if(e.key==="Enter")sourceDetails(gene);};group.append(line);
    // Strand arrow belongs to the annotated gene, independent of alignment orientation.
    const arrowX=gene.strand==="-"?left:right,direction=gene.strand==="-"?-1:1;
    if(gene.strand==="+"||gene.strand==="-")group.append(svgElement("path",{d:`M${arrowX-direction*4},${gy-3} L${arrowX},${gy} L${arrowX-direction*4},${gy+3}`,stroke:"#368775",fill:"none","pointer-events":"none"}));
    const seen=new Set();for(const f of ann.features){if(!["exon","CDS"].includes(f.kind)||!belongs(f,gene))continue;const key=`${f.kind}:${f.start}:${f.end}`;if(seen.has(key))continue;seen.add(key);
      const x0=trackX(w,Math.max(f.start,w.start),width),x1=trackX(w,Math.min(f.end,w.end),width),height=f.kind==="CDS"?8:4;
      const rect=svgElement("rect",{x:x0,y:gy-height/2,width:Math.max(1,x1-x0),height,class:"gene",tabindex:0,role:"button","aria-label":`${f.kind} ${gene.name}`,"data-start":f.start,"data-end":f.end});rect.append(svgElement("title",{},`${f.kind} · ${f.start}-${f.end} · ${f.parent}`));rect.onclick=()=>sourceDetails(f);rect.onkeydown=e=>{if(e.key==="Enter")sourceDetails(f);};group.append(rect);
    }
    if(left>labelEnds[lane]+8&&right-left>40){const name=gene.name.length>22?gene.name.slice(0,21)+"…":gene.name;group.append(svgElement("text",{x:left,y:gy-6,class:"annotation-label","pointer-events":"none"},name));labelEnds[lane]=left+name.length*5;}
  }svg.append(group);
}
function drawTracks() {
  const result=state.result,width=Math.max(820,$("visualization").clientWidth-34),step=142;
  const svg=svgElement("svg",{viewBox:`0 0 ${width} ${result.windows.length*step+20}`,role:"img","aria-label":"Multi-assembly synteny tracks"});
  // Clip all geometry to the current viewport; endpoints outside it retain their true coordinates in details.
  const defs=svgElement("defs");const clip=svgElement("clipPath",{id:"track-clip"});clip.append(svgElement("rect",{x:215,y:0,width:width-240,height:result.windows.length*step+20}));defs.append(clip);svg.append(defs);
  const ribbons=svgElement("g",{"clip-path":"url(#track-clip)"});
  for(const b of result.blocks){const tw=result.windows[b.target_window],qw=result.windows[b.query_window];const ty=b.target_window*step+55,qy=b.query_window*step+55;
    const t0=trackX(tw,b.target_start,width),t1=trackX(tw,b.target_end,width),q0=trackX(qw,b.strand==="+"?b.query_start:b.query_end,width),q1=trackX(qw,b.strand==="+"?b.query_end:b.query_start,width),mid=(ty+qy)/2;
    const path=svgElement("path",{d:`M${t0},${ty} C${t0},${mid} ${q0},${mid} ${q0},${qy} L${q1},${qy} C${q1},${mid} ${t1},${mid} ${t1},${ty} Z`,fill:colors[b.strand],class:"ribbon",tabindex:0,role:"button","aria-label":`Alignment ${b.strand} ${(b.identity*100).toFixed(1)}% identity`});
    path.append(svgElement("title",{},`${b.source_direction} · ${b.strand} · ${(b.identity*100).toFixed(2)}% identity`));path.onclick=()=>inspectBlock(b);path.onkeydown=e=>{if(e.key==="Enter")inspectBlock(b);};ribbons.append(path);
  }svg.append(ribbons);
  result.windows.forEach((w,i)=>{const y=i*step+55;const label=svgElement("text",{x:8,y:y-12,class:"track-label result-region",tabindex:0,role:"button"},w.name.length>26?w.name.slice(0,25)+"…":w.name);label.append(svgElement("title",{},`${w.name} · ${w.accession} · click to reuse region`));label.onclick=()=>adoptWindow(i);label.onkeydown=e=>{if(e.key==="Enter")adoptWindow(i);};svg.append(label,svgElement("text",{x:8,y:y+5},w.accession),svgElement("text",{x:8,y:y+21},w.seq.split("#").at(-1)),svgElement("text",{x:8,y:y+37},compact(w.end-w.start)));axis(svg,w,y,width);
    const ann=w.annotation;let text=ann.status==="available"?`${fmt(ann.total)} annotation features · ${ann.mapping}`:ann.status==="unmapped_sequence"?"Annotation seqid unmapped":"Gene annotation unavailable";
    if(ann.truncated)text+=" · truncated";svg.append(svgElement("text",{x:215,y:y+66,class:"annotation-label"},text));
    if(!$("show-genes").checked||ann.status!=="available")return;
    drawGenes(svg,w,y,width);
  });$("visualization").replaceChildren(svg);
}
function pairOptions() {
  const result=state.result, options=[];
  for(let i=0;i<result.windows.length;i++)for(let j=i+1;j<result.windows.length;j++)if(result.windows[i].accession!==result.windows[j].accession)options.push([i,j]);
  return options;
}
function drawDotplot() {
  const result=state.result,options=pairOptions();$("pair-picker").hidden=false;
  if(!options.length){$("pair-picker").replaceChildren();$("visualization").replaceChildren(element("div","No mapped pair is available for a dotplot.","empty-view"));return;}
  if(!state.pair||!options.some(p=>p.join(",")===state.pair))state.pair=options[0].join(",");
  const select=element("select");select.setAttribute("aria-label","Dotplot pair");for(const [i,j] of options){const a=result.windows[i],b=result.windows[j],o=element("option",`${a.name} / ${a.seq.split("#").at(-1)} ↔ ${b.name} / ${b.seq.split("#").at(-1)}`);o.value=`${i},${j}`;select.append(o);}select.value=state.pair;select.onchange=()=>{state.pair=select.value;drawDotplot();};$("pair-picker").replaceChildren(select,element("p","Drag a rectangle in the plot to browse both selected intervals.","muted"));
  const [i,j]=state.pair.split(",").map(Number),a=result.windows[i],b=result.windows[j],width=850,height=480,left=110,right=820,top=35,bottom=405;
  const svg=svgElement("svg",{viewBox:`0 0 ${width} ${height}`,role:"img","aria-label":"Pairwise alignment dotplot"});
  const xx=p=>left+(p-a.start)/(a.end-a.start)*(right-left),yy=p=>bottom-(p-b.start)/(b.end-b.start)*(bottom-top);
  const defs=svgElement("defs"),clip=svgElement("clipPath",{id:"dotplot-clip"});clip.append(svgElement("rect",{x:left,y:top,width:right-left,height:bottom-top}));defs.append(clip);svg.append(defs);
  for(let k=0;k<=4;k++){const x=left+(right-left)*k/4,y=bottom-(bottom-top)*k/4;svg.append(svgElement("line",{x1:x,x2:x,y1:top,y2:bottom,class:"gridline"}),svgElement("line",{x1:left,x2:right,y1:y,y2:y,class:"gridline"}),svgElement("text",{x,y:bottom+20,"text-anchor":"middle"},fmt(Math.round(a.start+(a.end-a.start)*k/4))),svgElement("text",{x:left-12,y:y+3,"text-anchor":"end"},fmt(Math.round(b.start+(b.end-b.start)*k/4))));}
  svg.append(svgElement("text",{x:(left+right)/2,y:height-25,"text-anchor":"middle",class:"track-label"},`${a.name} · ${a.seq.split("#").at(-1)}`),svgElement("text",{transform:`translate(16 ${(top+bottom)/2}) rotate(-90)`,"text-anchor":"middle",class:"track-label"},`${b.name} · ${b.seq.split("#").at(-1)}`));
  const segments=svgElement("g",{"clip-path":"url(#dotplot-clip)"});let count=0;
  for(const block of result.blocks){let x0,x1,y0,y1;
    if(block.target_window===i&&block.query_window===j){x0=block.target_start;x1=block.target_end;y0=block.strand==="+"?block.query_start:block.query_end;y1=block.strand==="+"?block.query_end:block.query_start;}
    else if(block.target_window===j&&block.query_window===i){x0=block.query_start;x1=block.query_end;y0=block.strand==="+"?block.target_start:block.target_end;y1=block.strand==="+"?block.target_end:block.target_start;}else continue;
    const line=svgElement("line",{x1:xx(x0),x2:xx(x1),y1:yy(y0),y2:yy(y1),stroke:colors[block.strand],class:"dot-segment",tabindex:0,role:"button"});line.append(svgElement("title",{},`${block.strand} · ${(block.identity*100).toFixed(2)}% identity`));line.onclick=()=>inspectBlock(block);line.onkeydown=e=>{if(e.key==="Enter")inspectBlock(block);};segments.append(line);count++;
  }svg.append(segments);if(!count)svg.append(svgElement("text",{x:(left+right)/2,y:(top+bottom)/2,"text-anchor":"middle"},"No direct alignment blocks in these windows"));
  let origin=null,selection=null;
  const point=event=>{const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());return {x:Math.max(left,Math.min(right,p.x)),y:Math.max(top,Math.min(bottom,p.y))};};
  svg.addEventListener("pointerdown",e=>{if(e.target.closest(".dot-segment"))return;if(state.offline){status("Dotplot selection queries require an API. You can inspect every segment in this recorded view.");return;}const p=point(e);origin=p;selection=svgElement("rect",{x:p.x,y:p.y,width:0,height:0,fill:"#2267aa22",stroke:"#2267aa","pointer-events":"none"});svg.append(selection);svg.setPointerCapture(e.pointerId);});
  svg.addEventListener("pointermove",e=>{if(!origin)return;const p=point(e);selection.setAttribute("x",Math.min(origin.x,p.x));selection.setAttribute("y",Math.min(origin.y,p.y));selection.setAttribute("width",Math.abs(p.x-origin.x));selection.setAttribute("height",Math.abs(p.y-origin.y));});
  svg.addEventListener("pointerup",e=>{if(!origin)return;const p=point(e),o=origin;origin=null;selection.remove();if(Math.abs(o.x-p.x)<5||Math.abs(o.y-p.y)<5)return;
    const ax=x=>Math.round(a.start+(x-left)/(right-left)*(a.end-a.start)),by=y=>Math.round(b.start+(bottom-y)/(bottom-top)*(b.end-b.start));
    state.mode="free";state.targets=[];state.regions=[{accession:a.accession,seq:a.seq,start:ax(Math.min(o.x,p.x)),end:ax(Math.max(o.x,p.x))},{accession:b.accession,seq:b.seq,start:by(Math.max(o.y,p.y)),end:by(Math.min(o.y,p.y))}];invalidate();renderRegions();runQuery();
  });$("visualization").replaceChildren(svg);
}
function renderView() {
  $("view-tracks").classList.toggle("active",state.view==="tracks");$("view-dotplot").classList.toggle("active",state.view==="dotplot");
  if(!state.result)return;$("pair-picker").hidden=state.view!=="dotplot";state.view==="tracks"?drawTracks():drawDotplot();
}
function exportResults() {if(!state.result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(state.result,null,2)],{type:"application/json"}));const link=element("a");link.href=url;link.download=`vgp-${state.result.dataset}-regions.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function share() {if(!state.result)return;const url=new URL(location.href);if(apiBase)url.searchParams.set("api",apiBase);url.hash=new URLSearchParams({view:JSON.stringify(state.result.request),display:state.view,pair:state.pair,genes:$("show-genes").checked?"1":"0"}).toString();try{await navigator.clipboard.writeText(url.href);status(state.offline?"Preview link copied. This view contains recorded real alignments and annotation.":"View link copied. The recipient needs access to this region API.");}catch{location.hash=url.hash;status("View saved in the address bar. Copy this URL to share.");}}
async function openPreview() {
  const response=await fetch("browser-data/preview.json");if(!response.ok)throw new Error("Real-data preview is unavailable at this location.");
  const result=await response.json();if(result.site_mode!=="precomputed_real_data_preview")throw new Error("Unmarked preview data rejected");
  state.offline=true;state.snapshot=result;state.result=result;state.mode=result.request.mode;state.regions=result.request.windows;state.targets=result.request.targets;state.pair="";
  for(const w of result.windows)await getContigs(w.accession);
  $("dataset").value=result.request.dataset;$("min-identity").value=result.request.min_identity*100;$("min-length").value=result.request.min_length;$("direction").value=result.request.direction;
  $("backend-status").textContent="Recorded real-data preview";$("connection-title").textContent="Real alignments · precomputed region";document.querySelector(".connection-panel").classList.add("preview-mode");
  $("connection-note").textContent="This page displays a verified three-assembly interval. Inspect tracks, genes and dotplots here. Custom samples or intervals require a connected query API.";
  $("open-preview").hidden=false;$("result-title").textContent="Three-assembly alignment · recorded view";$("result-subtitle").textContent=`${result.dataset} · ${result.coordinate_system} · captured ${result.run_utc}`;$("result-subtitle").classList.add("snapshot-notice");
  $("result-stats").textContent=`${fmt(result.total_blocks)} blocks / ${result.windows.length} windows`;
  $("export-query").disabled=false;$("share-query").disabled=false;renderRegions();renderCatalog();renderView();
  status(`Recorded real data: ${fmt(result.total_blocks)} alignment blocks across ${result.windows.length} assemblies. Custom interval controls are disabled until a query API is connected.`);
}
function connectApi() {
  try{
    const value=$("api-address").value.trim();const url=new URL(value);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error("Enter an HTTP(S) API base address without credentials or query parameters.");
    if(location.protocol==="https:"&&url.protocol!=="https:")throw new Error("This HTTPS page requires an HTTPS query API.");
    const base=url.href.replace(/\/+$/,"");try{localStorage.setItem("vgp-region-api",base);}catch{}
    const next=new URL(location.href);next.searchParams.set("api",base);location.href=next.href;
  }catch(e){status(e.message,"error");}
}
async function init() {
  try{
    $("api-address").value=apiBase;
    let catalog,connectionError;
    try{catalog=await api("api/catalog");$("connection-note").textContent=apiBase?`Connected query API: ${apiBase}`:"Connected to the query API on this server.";}
    catch(e){connectionError=e;const response=await fetch("browser-data/catalog.json");if(!response.ok)throw e;catalog=await response.json();state.offline=true;}
    state.catalog=catalog.samples;$("backend-status").textContent=`${catalog.samples.length} assemblies · indexed PAF`;
    for(const clade of [...new Set(state.catalog.map(s=>s.clade))].sort()){$("clade-filter").append(element("option",clade));}renderCatalog();
    const hash=new URLSearchParams(location.hash.slice(1)),encoded=hash.get("view");
    if(state.offline){state.view=hash.get("display")==="dotplot"?"dotplot":"tracks";$("show-genes").checked=hash.get("genes")!=="0";await openPreview();if(hash.get("pair")){state.pair=hash.get("pair");renderView();}
      if(apiBase)status(`API connection failed (${connectionError.message}). Showing the recorded real-data preview; no new query was executed.`,"error");
      if(encoded&&JSON.stringify(JSON.parse(encoded))!==JSON.stringify(state.snapshot.request))status("Showing the recorded three-assembly preview. The saved custom query needs a connected API.");
      if(hash.has("samples"))status("The selected heatmap assemblies need a query API. Showing the recorded three-assembly preview instead; no query for the selected genomes was executed.");
      return;
    }
    if(encoded){const saved=JSON.parse(encoded);if(!["free","anchor"].includes(saved.mode)||!Array.isArray(saved.windows)||saved.windows.length>16)throw new Error("Invalid saved view");
      for(const r of saved.windows){if(!sample(r.accession))throw new Error(`Unknown saved assembly ${r.accession}`);await getContigs(r.accession);}state.regions=saved.windows;state.mode=saved.mode;state.targets=saved.targets||[];
      if(!state.targets.every(a=>sample(a)))throw new Error("Unknown target assembly in saved view");
      $("dataset").value=saved.dataset;$("min-identity").value=saved.min_identity*100;$("min-length").value=saved.min_length;$("direction").value=saved.direction;
      state.view=hash.get("display")==="dotplot"?"dotplot":"tracks";$("show-genes").checked=hash.get("genes")!=="0";
      renderRegions();renderCatalog();await runQuery();if(hash.get("pair")){state.pair=hash.get("pair");renderView();}
    }else if(hash.has("samples")){
      const ids=hash.get("samples").split(",");if(ids.length>16)throw new Error("At most 16 assemblies can be loaded from the heatmap.");
      for(const id of ids){const match=state.catalog.find(s=>s.accession===id||s.aliases.includes(id));if(!match)throw new Error(`No local assembly for ${id}`);await addAssembly(match.accession);}
      if(catalog.datasets.includes(hash.get("dataset")))$("dataset").value=hash.get("dataset");status("Heatmap assemblies loaded. Select sequences and intervals, then browse alignments.");
    }
  }catch(e){status(e.message,"error");const box=element("div",null,"fatal-overlay");
    if(state.catalog.length){box.append(element("h3","Unable to load saved view"),element("p",e.message));}
    else{$("backend-status").textContent="API unavailable";box.append(element("h3","Region API required"),element("p",e.message),element("p","Serve this browser with the included backend:"),element("code",".venv-browser/bin/python browser_server.py --port 8766"));}
    $("visualization").replaceChildren(box);}
}
$("sample-search").oninput=renderCatalog;$("clade-filter").onchange=renderCatalog;
$("mode-free").onclick=()=>setMode("free");$("mode-anchor").onclick=()=>setMode("anchor");$("run-query").onclick=runQuery;
$("view-tracks").onclick=()=>{state.view="tracks";renderView();};$("view-dotplot").onclick=()=>{state.view="dotplot";renderView();};$("show-genes").onchange=renderView;
for(const id of ["dataset","min-identity","min-length","direction"])$(id).onchange=invalidate;
$("export-query").onclick=exportResults;$("share-query").onclick=share;
$("connect-api").onclick=connectApi;$("open-preview").onclick=()=>openPreview().catch(e=>status(e.message,"error"));
let resizeTimer;window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderView,100);});init();
