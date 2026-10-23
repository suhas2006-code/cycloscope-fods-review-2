const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const NS = "http://www.w3.org/2000/svg";
const palette = { ink: "#10231f", coral: "#f06f52", mint: "#70ad92", yellow: "#f6c453", blue: "#5e89a7", gray: "#bac1b8", paper: "#f3f0e7" };
const state = { daily: [], hourly: [], questions: [], models: [], predictions: [], summary: null, selectedQuestion: 1, metric: "r2", page: 1, sort: "dteday", sortDir: -1 };
const STATIC_MODE = location.hostname.endsWith("github.io") || location.protocol === "file:" || document.querySelector('meta[name="deployment-mode"]')?.content === "static";
const staticCache = {};

const fmt = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const esc = (v) => String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function query() {
  const p = new URLSearchParams({
    year: $("#year-filter").value,
    season: $("#season-filter").value,
    weather: $("#weather-filter").value,
    day_type: $("#day-filter").value,
    date_from: $("#date-from").value,
    date_to: $("#date-to").value,
    min_demand: $("#demand-min").value,
  });
  return p.toString();
}

async function getJSON(path) {
  if (STATIC_MODE) return getStaticJSON(path);
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function staticAsset(name) {
  if (!staticCache[name]) {
    const response = await fetch(`./data/${name}.json`);
    if (!response.ok) throw new Error(`Static data unavailable: ${name}`);
    staticCache[name] = await response.json();
  }
  return staticCache[name];
}

function filterStatic(rows, params, applyMinimum=true) {
  const value=(key,fallback="all")=>params.get(key)||fallback;
  return rows.filter(r=>{
    if(value("year")!=="all"&&String(r.year_label)!==value("year"))return false;
    if(value("season")!=="all"&&r.season_label!==value("season"))return false;
    if(value("weather")!=="all"&&r.weather_label!==value("weather"))return false;
    if(value("day_type")==="working"&&r.workingday!==1)return false;
    if(value("day_type")==="off"&&r.workingday!==0)return false;
    if(value("date_from","")&&r.dteday<value("date_from",""))return false;
    if(value("date_to","")&&r.dteday>value("date_to",""))return false;
    if(applyMinimum&&r.cnt<+(value("min_demand","0")))return false;
    return true;
  });
}

async function getStaticJSON(path) {
  const url=new URL(path,location.href),endpoint=url.pathname.split("/").pop(),params=url.searchParams;
  if(endpoint==="questions")return staticAsset("questions");
  if(endpoint==="hypotheses")return staticAsset("hypotheses");
  if(endpoint==="models")return staticAsset("models");
  if(endpoint==="manifest")return staticAsset("powerbi");
  if(endpoint==="daily")return filterStatic(await staticAsset("daily"),params,true);
  if(endpoint==="hourly")return filterStatic(await staticAsset("hourly"),params,false);
  if(endpoint==="summary"){
    const rows=filterStatic(await staticAsset("daily"),params,true),total=rows.reduce((s,r)=>s+r.cnt,0),peak=rows.length?rows.reduce((a,b)=>a.cnt>b.cnt?a:b):null;
    return {records:rows.length,total,daily_average:rows.length?total/rows.length:0,registered_share:total?rows.reduce((s,r)=>s+r.registered,0)/total*100:0,peak:peak?{date:peak.dteday,rentals:peak.cnt}:null};
  }
  throw new Error(`Unknown static endpoint: ${endpoint}`);
}

function svgNode(tag, attrs = {}, text = "") {
  const node = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  if (text !== "") node.textContent = text;
  return node;
}

function makeSvg(container, height = 300) {
  container.innerHTML = "";
  const width = Math.max(container.clientWidth || 600, 320);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  container.appendChild(svg);
  return { svg, width, height };
}

function empty(container, message = "No records match this filter combination.") {
  container.innerHTML = `<div class="empty">${esc(message)}</div>`;
}

function groupMean(rows, key, value = "cnt", order = null) {
  const map = new Map();
  rows.forEach(r => {
    const k = r[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(+r[value]);
  });
  let data = [...map].map(([label, values]) => ({ label, value: values.reduce((a,b)=>a+b,0)/values.length }));
  if (order) data.sort((a,b) => order.indexOf(String(a.label)) - order.indexOf(String(b.label)));
  return data;
}

function groupSum(rows, key, values) {
  const map = new Map();
  rows.forEach(r => {
    const k = r[key];
    if (!map.has(k)) map.set(k, Object.fromEntries(values.map(v => [v, 0])));
    values.forEach(v => map.get(k)[v] += +r[v]);
  });
  return [...map].map(([label, sums]) => ({label, ...sums}));
}

function axes(svg, width, height, max, margin = {l:48,r:16,t:15,b:38}, ticks = 4) {
  const innerH = height - margin.t - margin.b;
  for (let i=0;i<=ticks;i++) {
    const y = margin.t + innerH * i/ticks;
    const value = max * (1-i/ticks);
    svg.append(svgNode("line", {x1:margin.l,y1:y,x2:width-margin.r,y2:y,class:"grid-line"}));
    svg.append(svgNode("text", {x:margin.l-8,y:y+3,"text-anchor":"end",class:"axis-text"}, compact.format(value)));
  }
  return { x0:margin.l, y0:height-margin.b, w:width-margin.l-margin.r, h:innerH, margin };
}

function barChart(container, data, options = {}) {
  if (!data.length) return empty(container);
  const {svg,width,height} = makeSvg(container, options.height || 300);
  const max = options.max || Math.max(...data.flatMap(d => options.series ? options.series.map(s=>+d[s.key]) : [+d.value])) * 1.12 || 1;
  const a = axes(svg,width,height,max,options.margin);
  const series = options.series || [{key:"value",color:palette.coral}];
  const groupW = a.w/data.length;
  const barW = Math.min(45, groupW*.7/series.length);
  data.forEach((d,i) => {
    series.forEach((s,j) => {
      const val = +d[s.key]; const h = val/max*a.h;
      const x = a.x0+i*groupW+(groupW-barW*series.length)/2+j*barW;
      svg.append(svgNode("rect", {x,y:a.y0-h,width:Math.max(2,barW-2),height:h,fill:s.color || palette.coral,rx:2,class:"tip-target"}));
    });
    const label = String(d.label);
    svg.append(svgNode("text", {x:a.x0+(i+.5)*groupW,y:a.y0+18,"text-anchor":"middle",class:"axis-text"}, label.length>12?label.slice(0,11)+"…":label));
  });
  if (options.valueLabels) data.forEach((d,i)=>{
    const v=+d[series[0].key];
    svg.append(svgNode("text",{x:a.x0+(i+.5)*groupW,y:a.y0-v/max*a.h-7,"text-anchor":"middle",class:"axis-text"},options.format?options.format(v):compact.format(v)));
  });
}

function lineChart(container, series, options = {}) {
  const all = series.flatMap(s=>s.data.map(d=>+d.value));
  if (!all.length) return empty(container);
  const {svg,width,height}=makeSvg(container,options.height||300);
  const max=(options.max||Math.max(...all))*1.08 || 1;
  const a=axes(svg,width,height,max,options.margin);
  const maxLen=Math.max(...series.map(s=>s.data.length));
  series.forEach((s,si)=>{
    const points=s.data.map((d,i)=>`${a.x0+(maxLen===1?a.w/2:i/(maxLen-1)*a.w)},${a.y0-(+d.value/max*a.h)}`).join(" ");
    svg.append(svgNode("polyline",{points,fill:"none",stroke:s.color||[palette.coral,palette.mint,palette.blue][si],"stroke-width":s.width||2,"stroke-linejoin":"round","stroke-linecap":"round",opacity:s.opacity||1}));
  });
  const labels=series[0].data;
  const wanted=Math.min(7,labels.length);
  for(let i=0;i<wanted;i++){
    const idx=Math.round(i*(labels.length-1)/Math.max(1,wanted-1));
    const x=a.x0+(labels.length===1?a.w/2:idx/(labels.length-1)*a.w);
    svg.append(svgNode("text",{x,y:a.y0+18,"text-anchor":"middle",class:"axis-text"},String(labels[idx].label)));
  }
}

function scatterChart(container, data, xKey, yKey) {
  if (!data.length) return empty(container);
  const {svg,width,height}=makeSvg(container,300); const m={l:47,r:18,t:15,b:38};
  const xs=data.map(d=>+d[xKey]), ys=data.map(d=>+d[yKey]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),maxY=Math.max(...ys)*1.05;
  const a=axes(svg,width,height,maxY,m);
  data.forEach((d,i)=>{const x=a.x0+((+d[xKey]-minX)/(maxX-minX||1))*a.w;const y=a.y0-(+d[yKey]/maxY)*a.h;svg.append(svgNode("circle",{cx:x,cy:y,r:2.4,fill:i%2?palette.coral:palette.mint,opacity:.45}));});
  for(let i=0;i<5;i++){const val=minX+(maxX-minX)*i/4;svg.append(svgNode("text",{x:a.x0+a.w*i/4,y:a.y0+18,"text-anchor":"middle",class:"axis-text"},`${val.toFixed(0)}°`));}
}

function heatmap(container, rows, rowKey, colKey) {
  if(!rows.length) return empty(container);
  const rowLabels=["Spring","Summer","Fall","Winter"].filter(x=>rows.some(r=>r[rowKey]===x));
  const colLabels=["Clear","Mist/Cloudy","Light Rain/Snow"].filter(x=>rows.some(r=>r[colKey]===x));
  const grouped=new Map(); rows.forEach(r=>{const k=`${r[rowKey]}|${r[colKey]}`;if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(+r.cnt)});
  const values=[...grouped.values()].map(v=>v.reduce((a,b)=>a+b,0)/v.length), max=Math.max(...values);
  const {svg,width,height}=makeSvg(container,300),m={l:80,r:12,t:35,b:18},cw=(width-m.l-m.r)/colLabels.length,ch=(height-m.t-m.b)/rowLabels.length;
  colLabels.forEach((c,i)=>svg.append(svgNode("text",{x:m.l+(i+.5)*cw,y:18,"text-anchor":"middle",class:"axis-text"},c)));
  rowLabels.forEach((r,ri)=>{svg.append(svgNode("text",{x:m.l-9,y:m.t+(ri+.55)*ch,"text-anchor":"end",class:"axis-text"},r));colLabels.forEach((c,ci)=>{const vals=grouped.get(`${r}|${c}`)||[],v=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0,alpha=.12+.88*v/max;svg.append(svgNode("rect",{x:m.l+ci*cw+2,y:m.t+ri*ch+2,width:cw-4,height:ch-4,rx:3,fill:palette.coral,opacity:alpha}));svg.append(svgNode("text",{x:m.l+(ci+.5)*cw,y:m.t+(ri+.57)*ch,"text-anchor":"middle",fill:alpha>.55?"white":palette.ink,"font-size":"11","font-weight":"800"},fmt.format(Math.round(v))));});});
}

function rollingMean(rows, window=30) {
  return rows.map((r,i)=>({label:r.dteday.slice(0,7),value:rows.slice(Math.max(0,i-window+1),i+1).reduce((s,x)=>s+x.cnt,0)/Math.min(window,i+1)}));
}

function renderOverview(summary) {
  $("#kpi-total").textContent=compact.format(summary.total);
  $("#kpi-average").textContent=fmt.format(Math.round(summary.daily_average));
  $("#kpi-share").textContent=`${summary.registered_share}%`;
  $("#kpi-peak").textContent=summary.peak?fmt.format(summary.peak.rentals):"—";
  $("#kpi-peak-date").textContent=summary.peak?summary.peak.date:"No matching days";
  $("#filter-status").textContent=`${summary.records} day${summary.records===1?"":"s"} selected`;
  const raw=state.daily.map(r=>({label:r.dteday.slice(0,7),value:r.cnt}));
  lineChart($("#trend-chart"),[{data:raw,color:palette.coral,width:1,opacity:.38},{data:rollingMean(state.daily),color:palette.mint,width:3}],{height:270});
  const hourly=groupMean(state.hourly,"hr").sort((a,b)=>+a.label-+b.label).map(d=>({...d,label:String(d.label).padStart(2,"0")}));
  lineChart($("#hour-chart"),[{data:hourly,color:palette.coral,width:3}],{height:270});
}

function renderAdmin() {
  const search=$("#record-search").value.trim().toLowerCase();
  const rider=$("#rider-focus").value;
  let rows=state.daily.filter(r=>!search||[r.dteday,r.weekday_label,r.season_label,r.weather_label].some(v=>String(v).toLowerCase().includes(search)));
  rows.sort((a,b)=>{const av=a[state.sort],bv=b[state.sort];return (av>bv?1:av<bv?-1:0)*state.sortDir});
  const mean=k=>rows.length?rows.reduce((s,r)=>s+(+r[k]),0)/rows.length:0;
  $("#admin-days").textContent=fmt.format(rows.length); $("#admin-total").textContent=fmt.format(Math.round(mean("cnt")));
  $("#admin-registered").textContent=fmt.format(Math.round(mean("registered"))); $("#admin-casual").textContent=fmt.format(Math.round(mean("casual")));
  const size=+$("#page-size").value,pages=Math.max(1,Math.ceil(rows.length/size));state.page=Math.min(state.page,pages);
  const pageRows=rows.slice((state.page-1)*size,state.page*size);
  $("#records-body").innerHTML=pageRows.length?pageRows.map(r=>{const band=r.cnt>=6000?["surge","Surge"]:r.cnt>=3000?["normal","Standard"]:["quiet","Quiet"];return `<tr><td><b>${esc(r.dteday)}</b></td><td>${esc(r.weekday_label)}</td><td>${esc(r.season_label)}</td><td>${esc(r.weather_label)}</td><td>${(+r.temp_actual).toFixed(1)}°C</td><td class="${rider==="casual"?"focus-col":""}">${fmt.format(r.casual)}</td><td class="${rider==="registered"?"focus-col":""}">${fmt.format(r.registered)}</td><td class="${rider==="cnt"?"focus-col":""}"><b>${fmt.format(r.cnt)}</b></td><td><span class="load ${band[0]}">${band[1]}</span></td></tr>`}).join(""):`<tr><td colspan="9" class="no-records">No records match the current controls.</td></tr>`;
  $("#page-label").textContent=`Page ${state.page} of ${pages} · ${rows.length} records`;$("#page-prev").disabled=state.page<=1;$("#page-next").disabled=state.page>=pages;
  $("#table-caption").textContent=`Daily operations log · ${$("#rider-focus").selectedOptions[0].text}`;
  $("#admin-export").href=STATIC_MODE?"#":`/api/bi/daily.csv?${query()}`;
  $$("th[data-sort]").forEach(th=>th.classList.toggle("sorted",th.dataset.sort===state.sort));
}

const methods={season:"Grouped daily mean",workhour:"Hourly cohort comparison",weather:"Grouped daily mean",year:"Year-over-year comparison",userweekday:"User-segment aggregation",temp:"Binned correlation analysis",humidity:"Binned correlation analysis",wind:"Binned correlation analysis",timeline:"Monthly time series",holiday:"Two-group comparison",weekday:"Grouped daily mean",hour:"Hourly aggregation",feel:"Bivariate scatter",seasonweather:"Interaction heatmap",usermix:"Proportional composition"};

function bins(rows,key,size) {
  const map=new Map(); rows.forEach(r=>{const start=Math.floor(+r[key]/size)*size,k=start;if(!map.has(k))map.set(k,[]);map.get(k).push(+r.cnt)});
  return [...map].sort((a,b)=>a[0]-b[0]).map(([k,v])=>({label:`${Math.round(k)}–${Math.round(k+size)}`,value:v.reduce((a,b)=>a+b,0)/v.length}));
}

function renderAnalysis() {
  const q=state.questions.find(x=>x.id===state.selectedQuestion); if(!q)return;
  $$(".question-button").forEach(b=>b.classList.toggle("active",+b.dataset.id===q.id));
  $("#question-number").textContent=`Question ${String(q.id).padStart(2,"0")}`;
  $("#question-title").textContent=q.title; $("#question-method").textContent=methods[q.view];
  $("#question-finding").textContent=q.finding; $("#question-decision").textContent=q.decision;
  const d=state.daily,h=state.hourly,c=$("#analysis-chart");
  if(q.view==="season") barChart(c,groupMean(d,"season_label","cnt",["Spring","Summer","Fall","Winter"]),{valueLabels:true});
  else if(q.view==="weather") barChart(c,groupMean(d,"weather_label"),{valueLabels:true});
  else if(q.view==="year") barChart(c,groupMean(d,"year_label"),{valueLabels:true});
  else if(q.view==="holiday") barChart(c,groupMean(d,"holiday").map(x=>({...x,label:+x.label?"Holiday":"Non-holiday"})),{valueLabels:true});
  else if(q.view==="weekday") barChart(c,groupMean(d,"weekday_label","cnt",["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]),{valueLabels:true});
  else if(q.view==="hour") lineChart(c,[{data:groupMean(h,"hr").sort((a,b)=>a.label-b.label),color:palette.coral,width:3}],{height:300});
  else if(q.view==="timeline") {const m=groupMean(d,"dteday"); const grouped=new Map();d.forEach(r=>{const k=r.dteday.slice(0,7);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(r.cnt)});lineChart(c,[{data:[...grouped].map(([label,v])=>({label,value:v.reduce((a,b)=>a+b,0)/v.length})),color:palette.coral,width:3}],{height:300});}
  else if(q.view==="workhour") {const work=groupMean(h.filter(x=>x.workingday===1),"hr").sort((a,b)=>a.label-b.label),off=groupMean(h.filter(x=>x.workingday===0),"hr").sort((a,b)=>a.label-b.label);lineChart(c,[{data:work,color:palette.coral,width:3},{data:off,color:palette.mint,width:3}],{height:300});}
  else if(q.view==="temp") lineChart(c,[{data:bins(d,"temp_actual",4),color:palette.coral,width:3}],{height:300});
  else if(q.view==="humidity") lineChart(c,[{data:bins(d,"hum_actual",10),color:palette.blue,width:3}],{height:300});
  else if(q.view==="wind") lineChart(c,[{data:bins(d,"wind_actual",5),color:palette.mint,width:3}],{height:300});
  else if(q.view==="feel") scatterChart(c,d,"temp_actual","atemp_actual");
  else if(q.view==="seasonweather") heatmap(c,d,"season_label","weather_label");
  else if(q.view==="userweekday") {let data=groupSum(d,"weekday_label",["casual","registered"]);data.sort((a,b)=>["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(a.label)-["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(b.label));barChart(c,data,{series:[{key:"registered",color:palette.mint},{key:"casual",color:palette.coral}]});}
  else if(q.view==="usermix") {let data=groupSum(d,"season_label",["casual","registered"]);data.forEach(x=>{const t=x.casual+x.registered;x.casual=x.casual/t*100;x.registered=x.registered/t*100});data.sort((a,b)=>["Spring","Summer","Fall","Winter"].indexOf(a.label)-["Spring","Summer","Fall","Winter"].indexOf(b.label));barChart(c,data,{series:[{key:"registered",color:palette.mint},{key:"casual",color:palette.coral}],max:100});}
}

function renderQuestions() {
  $("#question-list").innerHTML=state.questions.map(q=>`<button class="question-button ${q.id===1?"active":""}" role="tab" data-id="${q.id}"><span>${String(q.id).padStart(2,"0")}</span>${esc(q.title)}</button>`).join("");
  $$(".question-button").forEach(btn=>btn.addEventListener("click",()=>{state.selectedQuestion=+btn.dataset.id;renderAnalysis()}));
}

function renderTests(tests) {
  $("#test-grid").innerHTML=tests.map(t=>`<article class="test-card"><span class="test-no">Test ${String(t.id).padStart(2,"0")} · ${esc(t.test)}</span><h3>${esc(t.decision)}</h3><p><b>H₀:</b> ${esc(t.null)}</p><div class="test-result"><div><small>${esc(t.stat)}</small><br><span>p ${esc(t.p.startsWith("<")?t.p:`= ${t.p}`)}</span></div><b>${esc(t.verdict)}</b></div></article>`).join("");
}

function renderModels() {
  const metric=state.metric, data=state.models.map(m=>({label:m.name.split(" ")[0],value:m[metric]}));
  const formats={r2:v=>v.toFixed(3),mae:v=>Math.round(v),rmse:v=>Math.round(v)};
  barChart($("#model-chart"),data,{height:330,valueLabels:true,format:formats[metric],max:metric==="r2"?1:undefined});
  $$(".metric-switch button").forEach(b=>b.classList.toggle("active",b.dataset.metric===metric));
  $("#model-note").textContent=metric==="r2"?"Gradient Boosting explains the most variance; Random Forest is close behind.":metric==="mae"?"Random Forest has the lowest average absolute miss: 439 bikes.":"Gradient Boosting has the lowest penalty on large errors in the exported holdout set.";
}

function renderModelIntelligence() {
  const rows=state.predictions;
  if(!rows.length)return;
  const pct=fn=>`${(rows.filter(fn).length/rows.length*100).toFixed(1)}%`;
  $("#prob-accurate").textContent=pct(r=>Math.abs(+r.Residual_RF)<=500);
  $("#prob-high").textContent=pct(r=>+r.Actual_Rentals>=6000);
  $("#prob-over").textContent=pct(r=>+r.Random_Forest>+r.Actual_Rentals);
  const sampled=rows.filter((_,i)=>i%6===0).slice(0,25);
  lineChart($("#prediction-chart"),[
    {data:sampled.map((r,i)=>({label:i+1,value:+r.Actual_Rentals})),color:palette.ink,width:3},
    {data:sampled.map((r,i)=>({label:i+1,value:+r.Random_Forest})),color:palette.coral,width:2}
  ],{height:280});
  const within=rows.filter(r=>Math.abs(+r.Residual_RF)<=500).length;
  const peakError=rows.reduce((a,r)=>Math.abs(+r.Residual_RF)>Math.abs(+a.Residual_RF)?r:a,rows[0]);
  $("#model-insights").innerHTML=[
    `<li><b>${within} of ${rows.length}</b> forecasts are within 500 rentals, supporting tactical planning with a safety buffer.</li>`,
    `<li><b>R² 0.884</b> means Random Forest explains 88.4% of held-out demand variation without using rider-count leakage.</li>`,
    `<li><b>Largest miss: ${fmt.format(Math.round(Math.abs(+peakError.Residual_RF)))}</b> rentals. Extreme disruption days still require human and weather review.</li>`,
    `<li><b>Decision rule:</b> use predictions for staffing and rebalancing; retain EDA and hypothesis tests for policy decisions.</li>`
  ].join("");
}

function predictDemand() {
  const input={year:+$("#pred-year").value,season:$("#pred-season").value,weather:$("#pred-weather").value,working:+$("#pred-working").value,temp:+$("#pred-temp").value,humidity:+$("#pred-humidity").value,wind:+$("#pred-wind").value};
  const scored=state.daily.map(r=>{
    const distance=Math.pow((+r.temp_actual-input.temp)/8,2)+Math.pow((+r.hum_actual-input.humidity)/20,2)+Math.pow((+r.wind_actual-input.wind)/12,2)+(r.season_label===input.season?0:2)+(r.weather_label===input.weather?0:2.5)+(+r.workingday===input.working?0:1.5)+(+r.year_label===input.year?0:1);
    return {row:r,distance};
  }).sort((a,b)=>a.distance-b.distance).slice(0,25);
  const weights=scored.map(x=>1/(.25+x.distance)),weightTotal=weights.reduce((a,b)=>a+b,0);
  const prediction=scored.reduce((sum,x,i)=>sum+(+x.row.cnt)*weights[i],0)/weightTotal;
  const values=scored.map(x=>+x.row.cnt).sort((a,b)=>a-b),low=values[2],high=values[22];
  const highProbability=scored.filter(x=>+x.row.cnt>=6000).length/scored.length*100;
  $("#pred-result").textContent=fmt.format(Math.round(prediction));
  $("#pred-range").textContent=`${fmt.format(low)}–${fmt.format(high)}`;
  $("#pred-probability").textContent=`${highProbability.toFixed(0)}%`;
  $("#pred-band").textContent=prediction>=6000?"High-demand day · pre-stage bikes":prediction>=3500?"Standard demand · normal staffing":"Lower demand · reduce repositioning";
  $("#pred-confidence").textContent="10th–90th percentile across 25 nearest days";
}

function renderPowerBI(manifest){
  $("#pbi-tables").textContent=manifest.tables.length;$("#pbi-measures").textContent=manifest.semantic_measures;$("#pbi-pages").textContent=manifest.report_pages;$("#pbi-visuals").textContent=manifest.native_visuals;$("#pbi-project").href=manifest.repository_url;
  $("#pbi-table-list").innerHTML=manifest.tables.map(name=>`<span>${esc(name)}</span>`).join("");
}

async function refresh() {
  try {
    const q=query();
    const [summary,daily,hourly]=await Promise.all([getJSON(`/api/summary?${q}`),getJSON(`/api/daily?${q}`),getJSON(`/api/hourly?${q}`)]);
    state.daily=daily; state.hourly=hourly; state.summary=summary; state.page=1; renderOverview(summary); renderAdmin(); renderAnalysis();
  } catch(err) { $("#footer-status").textContent="Backend unavailable"; $("#footer-status").style.color=palette.coral; console.error(err); }
}

async function init() {
  try {
    const [questions,tests,models,powerbi]=await Promise.all([getJSON("/api/questions"),getJSON("/api/hypotheses"),getJSON("/api/models"),getJSON("/api/powerbi/manifest")]);
    state.questions=questions;state.models=models.metrics;state.predictions=models.predictions;renderQuestions();renderTests(tests);renderModels();renderModelIntelligence();renderPowerBI(powerbi);await refresh();
    ["year-filter","season-filter","weather-filter","day-filter"].forEach(id=>$("#"+id).addEventListener("change",refresh));
    ["date-from","date-to","demand-min"].forEach(id=>$("#"+id).addEventListener("change",refresh));
    $("#demand-min").addEventListener("input",()=>$("#demand-output").textContent=`${fmt.format(+$("#demand-min").value)} bikes`);
    ["record-search","rider-focus","page-size"].forEach(id=>$("#"+id).addEventListener(id==="record-search"?"input":"change",()=>{state.page=1;renderAdmin()}));
    $$("th[data-sort]").forEach(th=>th.addEventListener("click",()=>{if(state.sort===th.dataset.sort)state.sortDir*=-1;else{state.sort=th.dataset.sort;state.sortDir=1}renderAdmin()}));
    $("#page-prev").addEventListener("click",()=>{state.page--;renderAdmin()}); $("#page-next").addEventListener("click",()=>{state.page++;renderAdmin()});
    $("#clear-advanced").addEventListener("click",()=>{$("#date-from").value="2011-01-01";$("#date-to").value="2012-12-31";$("#demand-min").value=0;$("#demand-output").textContent="0 bikes";$("#rider-focus").value="cnt";$("#record-search").value="";refresh()});
    $("#reset-filters").addEventListener("click",()=>{$$(".filter-dock select").forEach(s=>s.value="all");$("#clear-advanced").click()});
    $$(".metric-switch button").forEach(b=>b.addEventListener("click",()=>{state.metric=b.dataset.metric;renderModels()}));
    [["pred-temp","pred-temp-out","°C"],["pred-humidity","pred-humidity-out","%"],["pred-wind","pred-wind-out"," km/h"]].forEach(([input,output,unit])=>$("#"+input).addEventListener("input",()=>$("#"+output).textContent=$("#"+input).value+unit));
    $("#prediction-form").addEventListener("submit",event=>{event.preventDefault();predictDemand()});predictDemand();
    $$(".copy").forEach(b=>b.addEventListener("click",async()=>{await navigator.clipboard.writeText($("#"+b.dataset.copy).textContent);const t=$("#toast");t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1600)}));
    if(STATIC_MODE){
      const urls={daily:"daily",hourly:"hourly",model:"predictions"};
      Object.entries(urls).forEach(([k,v])=>$("#"+k+"-url").textContent=new URL(`data/${v}.csv`,location.href).href);
      $("#download-bi").href="./data/daily.csv";
      $("#admin-export").addEventListener("click",event=>{event.preventDefault();downloadAdminCSV()});
      $("#footer-status").textContent="GitHub Pages · static data connected";
    }else ["daily","hourly","model"].forEach(k=>$("#"+k+"-url").textContent=`${location.origin}/api/bi/${k==="model"?"predictions":k}.csv`);
  } catch(err) { document.body.innerHTML=`<main class="section"><h1>Dashboard could not connect</h1><p>Start the Python backend and reload this page.</p><code>${esc(err.message)}</code></main>`; }
}

function downloadAdminCSV(){
  const search=$("#record-search").value.trim().toLowerCase();
  const rows=state.daily.filter(r=>!search||[r.dteday,r.weekday_label,r.season_label,r.weather_label].some(v=>String(v).toLowerCase().includes(search)));
  if(!rows.length)return;
  const keys=Object.keys(rows[0]),quote=v=>`"${String(v).replaceAll('"','""')}"`,csv=[keys.join(","),...rows.map(r=>keys.map(k=>quote(r[k])).join(","))].join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"})),a=document.createElement("a");a.href=url;a.download="cycloscope_admin_view.csv";a.click();URL.revokeObjectURL(url);
}

window.addEventListener("resize",()=>{if(state.daily.length&&state.summary){renderOverview(state.summary);renderAnalysis();renderModels();renderModelIntelligence()}});
document.addEventListener("DOMContentLoaded",init);
