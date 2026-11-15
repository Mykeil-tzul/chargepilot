import {vehicles,conditions,range,decodeStation,corridor,compatible,planTrip} from "./engine.mjs";

const $=id=>document.getElementById(id);
const num=id=>$(id).valueAsNumber;
const money=n=>n.toLocaleString("en-US",{style:"currency",currency:"USD"});
const miles=n=>n.toLocaleString("en-US",{maximumFractionDigits:0})+" mi";
const span=n=>Math.floor(Math.round(n)/60)+"h "+Math.round(n)%60+"m";
const pct=n=>n.toFixed(1)+"%";
const node=(tag,text,cls)=>{
  const e=document.createElement(tag);
  if (text!==undefined) e.textContent=text;
  if (cls) e.className=cls;
  return e;
};
const local={
  read(key,fallback) {
    try {return JSON.parse(localStorage.getItem("chargepilot."+key) || "null") ?? fallback;}
    catch {return fallback;}
  },
  save(key,value) {localStorage.setItem("chargepilot."+key,JSON.stringify(value));}
};
let custom=local.read("garage",null), logs=local.read("charges",[]), saved=local.read("trips",[]);
if (!Array.isArray(logs)) logs=[];
if (!Array.isArray(saved)) saved=[];
let map, layers, current, stations=[], cities={}, cached={}, stationCatalog=null, active=false;

function fillVehicles(value="modelY") {
  $("vehicle").replaceChildren(...Object.entries({...vehicles,...(custom ? {custom} : {})}).map(([id,v])=>new Option(v.name,id)));
  $("vehicle").value=value==="custom" && !custom ? "modelY" : value;
  $("remove-vehicle").disabled=!custom;
}
fillVehicles(custom ? "custom" : "modelY");
const car=()=> $("vehicle").value==="custom" ? custom : vehicles[$("vehicle").value];

function scenario() {
  return {speed:num("speed"),temp:num("temp"),load:num("load")};
}

function updateRange() {
  const v=car(), start=num("start"), reserve=num("reserve"), input=scenario();
  const result=conditions(v.wh,input);
  $("speed-label").value=input.speed+" mph";
  $("temp-label").value=input.temp+" °F";
  $("load-label").value=input.load+" lb";
  $("range").textContent=Number.isFinite(start-reserve) ? miles(range(v.capacity,start,reserve,result.wh)) : "—";
  $("consumption").textContent=Math.round(result.wh)+" Wh/mi · "+v.capacity+" kWh usable battery · "+v.plug;
  const comparisons=[
    ["Reference · 65 mph / 70 °F / empty",v.wh],
    ["Current conditions",result.wh],
    ["Cold highway · 30 °F",conditions(v.wh,{...input,temp:30}).wh]
  ].map(([name,wh])=>[name,range(v.capacity,start,reserve,wh)]);
  const max=Math.max(1,...comparisons.map(row=>row[1]).filter(Number.isFinite));
  $("range-bars").replaceChildren(...comparisons.map(([label,distance])=>{
    const bar=node("div",label+" · "+(Number.isFinite(distance)?miles(distance):"—"),"bar");
    const fill=node("i");
    fill.style.width=(Number.isFinite(distance)?100*distance/max:0)+"%";
    bar.prepend(fill);
    return bar;
  }));
  updateCosts();
}

function updateCosts() {
  const inputs=["home-price","gas","mpg","annual-miles","home-share","ev-fixed","gas-fixed","price"];
  if (inputs.some(id=>!$(id).validity.valid || !Number.isFinite(num(id)))) {
    $("cost-results").replaceChildren(node("p","Enter valid numbers to compare costs.","caption"));
    return;
  }
  const home=num("home-price"), gas=num("gas"), mpg=num("mpg"), total=num("annual-miles");
  const homeShare=num("home-share")/100;
  const wh=conditions(car().wh,scenario()).wh;
  const annualEV=total*wh/1000/0.9*(homeShare*home+(1-homeShare)*num("price"))+num("ev-fixed");
  const annualGas=total/mpg*gas+num("gas-fixed");
  const entries=[node("p","Annual scenario · EV "+money(annualEV)+" · Gas "+money(annualGas),"stop")];
  if (current?.plan && !current.stale) {
    const p=current.plan;
    const initialUse=Math.max(0,current.vehicle.capacity*current.start/100-p.energy);
    entries.unshift(node("p","Trip scenario · EV "+money(p.cost+initialUse/0.9*home)+" · Gas "+money(current.miles/mpg*gas),"stop"));
  }
  entries.push(node("p","Annual costs include your fixed-cost inputs and modeled energy. Add maintenance, insurance, or other expenses to those inputs. Taxes, tolls and purchase price are outside the trip estimate.","caption"));
  $("cost-results").replaceChildren(...entries);
}

function markStale() {
  if (current) {
    current.stale=true;
    $("trip-status").textContent="Assumptions changed. Calculate trip to update the displayed itinerary.";
    $("save-trip").disabled=true;
  }
  updateRange();
}

async function json(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(16000)});
  if (!response.ok) throw Error("Data request failed.");
  return response.json();
}

async function routeFor(from,to) {
  const key=from+"|"+to;
  if (cached[key]) return cached[key];
  const coord=cities[from].join(",")+";"+cities[to].join(",");
  const data=await json("https://routing.openstreetmap.de/routed-car/route/v1/driving/"+coord+"?geometries=geojson&overview=simplified&steps=false");
  const r=data.routes?.[0];
  if (!r?.geometry?.coordinates?.length || !(r.distance>0)) throw Error("No driving route between those cities.");
  cached[key]=r;
  return r;
}

function initMap() {
  if (!window.L) {
    $("map").textContent="The map library is unavailable. The itinerary remains usable.";
    return;
  }
  map=L.map("map",{scrollWheelZoom:false,preferCanvas:true});
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{
    attribution:"© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors © <a href='https://carto.com/attributions'>CARTO</a>",
    maxZoom:18
  }).addTo(map);
  map.setView([33,-83],5);
  layers=L.layerGroup().addTo(map);
}

function stationPopup(site) {
  const el=node("div");
  el.append(node("strong",site.name),node("p",site.network+" · "+site.plugs.join(" / ")+" · "+site.ports+" listed DC ports"),
    node("p",[site.address,site.city,site.state].filter(Boolean).join(", ")),
    node("p",site.pricing ? "AFDC price note: "+site.pricing : "No price listed in the catalog."),
    node("p",site.access || "Hours not listed. Check with operator."));
  return el;
}

function paintMap(fit=false) {
  if (!current) return;
  const network=$("network").value, connector=$("connector").value;
  const points=current.nearby.filter(site=>(!network || site.network===network) &&
    (connector==="all" || (connector ? site.plugs.includes(connector) : compatible(site,current.vehicle))));
  $("map-summary").textContent=points.length+" matching DC sites within roughly 5 miles of the route. Gold markers are planned stops. Filters change the map view.";
  if (!map) return;
  layers.clearLayers();
  const path=L.geoJSON(current.route.geometry,{style:{color:"#65e8f6",weight:4,opacity:0.9}}).addTo(layers);
  for (const site of points) L.circleMarker([site.lat,site.lon],{
    radius:3.5,color:"#6bd5e8",stroke:false,fillOpacity:.66
  }).addTo(layers).bindPopup(()=>stationPopup(site));
  for (const [i,site] of (current.plan?.stops || []).entries()) L.circleMarker([site.lat,site.lon],{
    radius:7,color:"#f9d283",weight:2,fillColor:"#d7a247",fillOpacity:1
  }).addTo(layers).bindTooltip("Stop "+(i+1)).bindPopup(()=>stationPopup(site));
  if (fit) map.fitBounds(path.getBounds(),{padding:[20,20],maxZoom:13});
}

function showTrip() {
  const {plan,route,alternate,preference}=current;
  $("miles").textContent=miles(current.miles);
  $("stop-count").textContent=plan ? plan.stops.length : "—";
  $("extra").textContent=plan ? (Math.round(plan.extra)+" min") : "—";
  $("arrival").textContent=plan ? pct(plan.arrival) : "—";
  $("paid").textContent=plan ? money(plan.cost) : "—";
  $("road-time").textContent="Road routing estimate "+span(route.duration/60)+
    (plan ? " · With modeled stops "+span(route.duration/60+plan.extra) : "");
  $("trip-status").textContent=plan ? "Plan calculated using "+Math.round(current.wh)+" Wh/mi and a "+current.reserve+"% reserve." :
    "No route meets this reserve with the catalog’s compatible stations. Try starting with more charge, changing conditions, or checking independent station listings.";
  const previous=$("network").value;
  $("network").replaceChildren(new Option("All networks",""),...[...new Set(current.nearby.map(site=>site.network))]
    .sort().map(n=>new Option(n,n)));
  if ([...$("network").options].some(o=>o.value===previous)) $("network").value=previous;
  const cards=(plan?.stops || []).map((site,i)=>{
    const item=node("article",undefined,"stop");
    item.append(node("b","Stop "+(i+1)+" · "+site.name),
      node("p",site.network+" · "+site.city+", "+site.state+" · Mile "+Math.round(site.mile)),
      node("p",pct(site.arrive)+" → "+pct(site.depart)+" · "+site.added.toFixed(1)+" kWh added"),
      node("p","~"+Math.round(site.charging)+" min charging · "+money(site.paid)+" · "+(site.detour*2).toFixed(1)+" mi modeled round-trip detour"));
    const link=node("a","Open station in maps ↗");
    link.href="https://www.google.com/maps/search/?api=1&query="+site.lat+","+site.lon;
    link.target="_blank";
    link.rel="noopener noreferrer";
    item.append(link);
    return item;
  });
  if (!cards.length) cards.push(node("p",plan ? "No charge stop needed under these assumptions." : "No feasible itinerary found.","caption"));
  if (plan?.stops.length) cards.push(node("p","Verify connector access, pricing, and station status with the operator. These are planning estimates.","caption"));
  if (alternate && plan) cards.push(node("p",(preference==="cost" ? "Time-first option" : "Cost-first option")+
    " · "+alternate.stops.length+" stops · "+Math.round(alternate.extra)+" min · "+money(alternate.cost)+" paid at stops.","stop"));
  $("stops").replaceChildren(...cards);
  $("save-trip").disabled=!plan;
  paintMap(true);
  updateCosts();
}

async function calculate(event) {
  event?.preventDefault();
  if (active || !$("trip-form").reportValidity()) return;
  const from=$("origin").value,to=$("destination").value;
  const start=num("start"),reserve=num("reserve"),price=num("price"), preference=$("preference").value;
  if (from===to || start<reserve) {
    $("trip-status").textContent=from===to ? "Choose two different cities." : "Starting battery must be at or above the reserve.";
    return;
  }
  const vehicle=car(), wh=conditions(vehicle.wh,scenario()).wh;
  active=true;
  $("run").disabled=true;
  $("trip-status").textContent="Calculating route and charging options…";
  try {
    const route=await routeFor(from,to);
    const distance=route.distance/1609.344;
    const nearby=corridor(route,stations);
    const inputs={miles:distance,stations:nearby,vehicle,wh,start,reserve,price};
    const plan=planTrip({...inputs,preference});
    const alternate=plan ? planTrip({...inputs,preference:preference==="cost" ? "time" : "cost"}) : null;
    current={route,miles:distance,nearby,plan,alternate,preference,from,to,start,reserve,vehicle,wh,stale:false};
    showTrip();
    if (from!==$("origin").value || to!==$("destination").value || start!==num("start") || reserve!==num("reserve") ||
        price!==num("price") || preference!==$("preference").value || vehicle!==car() || wh!==conditions(car().wh,scenario()).wh) markStale();
  } catch {
    if (current) current.stale=true;
    $("save-trip").disabled=true;
    $("trip-status").textContent="Could not calculate this route. Try Atlanta → Miami or retry the routing service.";
    updateCosts();
  } finally {
    active=false;
    $("run").disabled=false;
  }
}

$("trip-form").onsubmit=calculate;
$("trip-form").oninput=markStale;
for (const id of ["speed","temp","load"]) $(id).oninput=markStale;
for (const id of ["network","connector"]) $(id).onchange=()=>paintMap();
for (const id of ["home-price","gas","mpg","annual-miles","home-share","ev-fixed","gas-fixed"]) $(id).oninput=updateCosts;

const garage=$("garage-form");
function showGarage() {
  for (const key of ["name","capacity","wh","peak","plug"]) garage.elements.namedItem(key).value=(custom || car())[key];
  garage.elements.namedItem("tesla").checked=(custom || car()).tesla;
}
showGarage();
$("vehicle").addEventListener("change",()=>{if (!custom || $("vehicle").value==="custom") showGarage();});
garage.onsubmit=event=>{
  event.preventDefault();
  const data=new FormData(garage);
  const value={name:data.get("name").trim(),capacity:Number(data.get("capacity")),wh:Number(data.get("wh")),
    peak:Number(data.get("peak")),plug:data.get("plug"),tesla:data.has("tesla")};
  if (!value.name) {$("garage-status").textContent="Enter a scenario name.";return;}
  try {
    local.save("garage",value);
    custom=value;
    fillVehicles("custom");
    markStale();
    $("garage-status").textContent="Saved on this device and selected for the next calculation.";
  } catch {$("garage-status").textContent="The browser blocked local storage.";}
};
$("remove-vehicle").onclick=()=>{
  try {
    localStorage.removeItem("chargepilot.garage");
    custom=null;fillVehicles();showGarage();markStale();
    $("garage-status").textContent="Saved scenario removed.";
  } catch {$("garage-status").textContent="The browser blocked local storage.";}
};

function renderHistory() {
  const total=logs.reduce((a,r)=>[a[0]+r.miles,a[1]+r.kwh,a[2]+r.cost],[0,0,0]);
  $("log-totals").textContent=logs.length ? miles(total[0])+" · "+total[1].toFixed(1)+" kWh billed · "+money(total[2])+
    (total[0]>0 ? " · "+(total[0]/total[1]).toFixed(2)+" mi/kWh billed · "+money(total[2]/total[0])+"/mi" : "") :
    "No charging records yet.";
  $("records").replaceChildren(...logs.slice(-8).reverse().map(r=>node("li",r.date+" · "+miles(r.miles)+" · "+r.kwh+" kWh · "+money(r.cost))));
  $("saved-trips").replaceChildren(...saved.slice(-8).reverse().map(r=>node("li",r.from+" → "+r.to+" · "+miles(r.miles)+" · "+r.stops+" stops · "+money(r.cost)+" paid at stops")));
  $("export").disabled=!logs.length;
}
function saveHistory(key,next) {
  try {
    local.save(key,next);
    if (key==="charges") logs=next; else saved=next;
    renderHistory();
    $("log-status").textContent="Saved on this device.";
    return true;
  } catch {
    $("log-status").textContent="The browser blocked local storage.";
    return false;
  }
}
$("log-form").onsubmit=event=>{
  event.preventDefault();
  const data=new FormData(event.target);
  const record={date:new Date().toISOString().slice(0,10),miles:Number(data.get("miles")),kwh:Number(data.get("kwh")),cost:Number(data.get("cost"))};
  if (saveHistory("charges",[...logs,record].slice(-500))) event.target.reset();
};
$("save-trip").onclick=()=>{
  if (!current?.plan || current.stale) return;
  const {from,to,miles,plan}=current;
  saveHistory("trips",[...saved,{from,to,miles,cost:plan.cost,stops:plan.stops.length}].slice(-100));
};
$("export").onclick=()=>{
  const csv=["date,miles,kwh,cost",...logs.map(r=>[r.date,r.miles,r.kwh,r.cost].join(","))].join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  const a=node("a");
  a.download="chargepilot-charging.csv";
  a.href=url;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};

async function start() {
  [cities,cached,stationCatalog]=await Promise.all([json("data/cities.json"),json("data/routes.json"),json("data/stations.json")]);
  stations=stationCatalog.rows.map(decodeStation);
  for (const id of ["origin","destination"]) $(id).replaceChildren(...Object.keys(cities).sort().map(n=>new Option(n)));
  $("origin").value="Atlanta, GA";
  $("destination").value="Miami, FL";
  $("data-status").textContent=stations.length.toLocaleString()+" DC sites · AFDC "+new Date(stationCatalog.downloaded).toLocaleDateString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",year:"numeric"});
  initMap();
  $("run").disabled=false;
  await calculate();
}
updateRange();
renderHistory();
start().catch(()=>{
  $("data-status").textContent="Station catalog unavailable";
  $("trip-status").textContent="The bundled data could not load. Reload the app to retry.";
});
