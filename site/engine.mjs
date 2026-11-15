export const vehicles = {
  modelY: {name:"Tesla Model Y · Long Range",capacity:75,wh:270,peak:250,plug:"NACS",tesla:true},
  model3: {name:"Tesla Model 3 · Long Range",capacity:75,wh:242,peak:250,plug:"NACS",tesla:true},
  ioniq5: {name:"Hyundai IONIQ 5 · Long Range",capacity:77.4,wh:305,peak:230,plug:"CCS",tesla:false},
  machE: {name:"Ford Mustang Mach-E · Extended Range",capacity:91,wh:320,peak:150,plug:"CCS",tesla:false},
  bolt: {name:"Chevrolet Bolt EV",capacity:65,wh:285,peak:55,plug:"CCS",tesla:false},
  leaf: {name:"Nissan LEAF Plus",capacity:59,wh:300,peak:75,plug:"CHAdeMO",tesla:false}
};

export function conditions(base,{speed,temp,load}) {
  const speedFactor=0.42+0.58*(speed/65)**2;
  const weatherFactor=1+Math.max(0,55-temp)*0.005+Math.max(0,temp-85)*0.003;
  const loadFactor=1+load*0.00012;
  return {wh:base*speedFactor*weatherFactor*loadFactor,speedFactor,weatherFactor,loadFactor};
}

export function range(capacity,soc,reserve,wh) {
  return Math.max(0,capacity*(soc-reserve)/100)*1000/wh;
}

export function decodeStation(row) {
  const [id,name,lat,lon,network,plugs,ports,address,city,state,pricing,access]=row;
  return {id,name,lat,lon,network,plugs,ports,address,city,state,pricing,access};
}

export function compatible(station,vehicle) {
  if (!station.plugs.includes(vehicle.plug)) return false;
  return station.network!=="Tesla" || vehicle.plug==="CCS" || vehicle.tesla;
}

function roadSegments(coordinates,miles) {
  const scaleX=69*Math.cos((coordinates[0][1]+coordinates.at(-1)[1])/2*Math.PI/180);
  const step=Math.max(1,Math.ceil(coordinates.length/1600));
  const points=coordinates.filter((_,i)=>i%step===0 || i===coordinates.length-1);
  let total=0;
  const segments=[];
  for (let i=1;i<points.length;i++) {
    const [lon,lat]=points[i-1];
    const dx=(points[i][0]-lon)*scaleX,dy=(points[i][1]-lat)*69;
    const length=Math.hypot(dx,dy);
    if (!length) continue;
    segments.push({lon,lat,dx,dy,length,start:total});
    total+=length;
  }
  return {scaleX,segments,factor:total ? miles/total : 1};
}

export function corridor(route,stations,radius=5) {
  const coordinates=route.geometry.coordinates;
  const miles=route.distance/1609.344;
  const {scaleX,segments,factor}=roadSegments(coordinates,miles);
  const bbox=coordinates.reduce(([w,s,e,n],[lon,lat])=>[Math.min(lon,w),Math.min(lat,s),Math.max(lon,e),Math.max(lat,n)],
    [Infinity,Infinity,-Infinity,-Infinity]);
  const result=[];
  for (const station of stations) {
    if (station.lon<bbox[0]-radius/scaleX || station.lon>bbox[2]+radius/scaleX ||
        station.lat<bbox[1]-radius/69 || station.lat>bbox[3]+radius/69) continue;
    let near=Infinity,along=0;
    for (const segment of segments) {
      const {lon,lat,dx,dy,length,start}=segment;
      const px=(station.lon-lon)*scaleX,py=(station.lat-lat)*69;
      if (Math.abs(px)>radius+Math.abs(dx) || Math.abs(py)>radius+Math.abs(dy)) continue;
      const t=Math.max(0,Math.min(1,(px*dx+py*dy)/length**2));
      const offset=Math.hypot(px-t*dx,py-t*dy);
      if (offset<near) {near=offset;along=(start+t*length)*factor;}
    }
    if (near<=radius) result.push({...station,mile:along,detour:Math.max(0.25,near*1.4)});
  }
  return result.sort((a,b)=>a.mile-b.mile);
}

export function modeledStation(station,basePrice) {
  const network=station.network.toLowerCase();
  if (network==="tesla") return {kw:150,price:basePrice};
  if (network.includes("electrify") || network.includes("ionna") || network.includes("evgo")) return {kw:150,price:basePrice+0.06};
  return {kw:75,price:Math.max(0,basePrice-0.06)};
}

export function chargeMinutes(from,to,capacity,peak) {
  let minutes=0;
  for (const [low,high,fraction] of [[0,0.5,0.78],[0.5,0.7,0.59],[0.7,0.8,0.43],[0.8,0.9,0.28],[0.9,1,0.16]]) {
    const overlap=Math.max(0,Math.min(to,high*capacity)-Math.max(from,low*capacity));
    minutes+=60*overlap/(peak*fraction);
  }
  return minutes;
}

export function planTrip({miles,stations,vehicle,wh,start,reserve,preference,price}) {
  const capacity=vehicle.capacity, minEnergy=capacity*reserve/100, perMile=wh/1000;
  const initial=capacity*start/100;
  if (initial+1e-8<minEnergy) return null;
  // Keep the closest site in each six-mile bucket for each modeled cost/power class.
  const candidates=new Map();
  for (const station of stations) {
    if (station.mile<=0 || station.mile>=miles || !compatible(station,vehicle)) continue;
    const offer=modeledStation(station,price);
    const key=[Math.floor(station.mile/6),offer.kw,offer.price].join("|");
    const prior=candidates.get(key);
    if (!prior || prior.detour>station.detour) candidates.set(key,{...station,...offer});
  }
  const nodes=[{mile:0,detour:0},...[...candidates.values()].sort((a,b)=>a.mile-b.mile),{mile:miles,detour:0}];
  const states=nodes.map(()=>new Map());
  states[0].set(0,{energy:initial,score:0,kwh:0,cost:0,extra:0,stops:[]});
  for (let i=0;i<nodes.length-1;i++) {
    const here=nodes[i];
    for (const current of states[i].values()) {
      for (let j=i+1;j<nodes.length;j++) {
        const next=nodes[j];
        const stretch=next.mile-here.mile;
        if (stretch*perMile>capacity-minEnergy+1e-8) break;
        const need=(stretch+here.detour+next.detour)*perMile;
        const required=minEnergy+need;
        if (required>capacity+1e-8) continue;
        const targets=[current.energy];
        if (i) {
          for (let percent=Math.max(Math.ceil(required/capacity*20),Math.floor(current.energy/capacity*20)+1);percent<=19;percent++) {
            targets.push(capacity*percent/20);
          }
          if (required>current.energy) targets.push(Math.min(capacity,required));
        }
        for (const departure of targets) {
          if (departure+1e-8<required) continue;
          const added=departure-current.energy;
          // A station node is an actual stop, never a zero-charge waypoint.
          if (i && added<0.05) continue;
          const arrived=departure-need;
          const bucket=Math.floor(arrived/capacity*50+1e-8);
          const paid=i ? added/0.9*here.price : 0;
          const charging=i ? chargeMinutes(current.energy,departure,capacity,Math.min(vehicle.peak,here.kw)) : 0;
          const extra=i ? charging+5+here.detour*2/25*60 : 0;
          const score=current.score+(preference==="cost" ? paid+0.015*extra : extra+0.03*paid);
          if ((states[j].get(bucket)?.score ?? Infinity)<=score) continue;
          const stop={...here,arrive:current.energy/capacity*100,depart:departure/capacity*100,added,charging,paid};
          states[j].set(bucket,{energy:arrived,score,kwh:current.kwh+added,cost:current.cost+paid,
            extra:current.extra+extra,stops:i ? [...current.stops,stop] : current.stops});
        }
      }
    }
  }
  const best=[...states.at(-1).values()].sort((a,b)=>a.score-b.score)[0];
  return best ? {...best,arrival:best.energy/capacity*100} : null;
}
