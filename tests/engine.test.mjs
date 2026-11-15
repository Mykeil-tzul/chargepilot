import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {vehicles,range,conditions,chargeMinutes,compatible,decodeStation,corridor,planTrip} from "../site/engine.mjs";

test("range math and weather assumptions",()=>{
  assert.ok(Math.abs(range(75,80,0,270)-222.2222)<.001);
  assert.equal(range(75,15,15,270),0);
  assert.equal(conditions(270,{speed:65,temp:70,load:0}).wh,270);
  assert.ok(conditions(270,{speed:80,temp:30,load:400}).wh>350);
});
test("charging tapers and compatibility does not assume third-party Tesla access",()=>{
  assert.ok(chargeMinutes(60,67.5,75,150)>chargeMinutes(15,22.5,75,150));
  assert.equal(compatible({plugs:["NACS"],network:"Tesla"},{plug:"NACS",tesla:false}),false);
  assert.equal(compatible({plugs:["CCS"],network:"Tesla"},vehicles.ioniq5),true);
});
test("planner handles direct trips and refuses an unreachable corridor",()=>{
  const args={stations:[],vehicle:vehicles.modelY,wh:270,start:80,reserve:15,preference:"time",price:.4};
  assert.equal(planTrip({...args,miles:20}).stops.length,0);
  assert.equal(planTrip({...args,miles:600}),null);
  assert.equal(planTrip({...args,miles:20,start:8}),null);
});
test("real Atlanta–Miami route yields compatible stops and respects battery reserve",()=>{
  const read=f=>JSON.parse(readFileSync(new URL("../site/data/"+f+".json",import.meta.url)));
  const route=read("routes")["Atlanta, GA|Miami, FL"];
  const stations=corridor(route,read("stations").rows.map(decodeStation));
  assert.ok(stations.length>100);
  const args={miles:route.distance/1609.344,stations,vehicle:vehicles.modelY,wh:278.1,start:80,reserve:15,price:.42};
  const fast=planTrip({...args,preference:"time"});
  const cheap=planTrip({...args,preference:"cost"});
  assert.ok(fast?.stops.length>0 && cheap?.stops.length>0);
  assert.ok(fast.extra<cheap.extra && cheap.cost<fast.cost);
  for (const itinerary of [fast,cheap]) {
    assert.ok(itinerary.arrival>=15-1e-7);
    let energy=args.start*args.vehicle.capacity/100;
    let mile=0, detour=0;
    for (const stop of [...itinerary.stops,{mile:args.miles,detour:0,added:0}]) {
      energy-=(stop.mile-mile+detour+stop.detour)*args.wh/1000;
      assert.ok(energy>=args.vehicle.capacity*.15-1e-7);
      energy+=stop.added;
      assert.ok(energy<=args.vehicle.capacity+1e-7);
      if (stop.id) assert.ok(compatible(stop,args.vehicle));
      mile=stop.mile;
      detour=stop.detour;
    }
  }
});
