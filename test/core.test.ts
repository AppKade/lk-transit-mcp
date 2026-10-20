import test from 'node:test';
import assert from 'node:assert/strict';
import { TransitStore, canonicalId, distanceMeters, freshness } from '../src/core.ts';
import { demo } from '../src/demo.ts';

const store=()=>{const s=new TransitStore();s.activate(demo);return s;};
test('canonical IDs preserve provider source IDs and reject ambiguous provider names',()=>{
  assert.equal(canonicalId('lmt','stop','001:A'),'lmt:stop:001:A');
  assert.throws(()=>canonicalId('LMT:other','stop','1'));
  assert.throws(()=>canonicalId('lmt','stop',''));
  assert.throws(()=>canonicalId('lmt','stop','secret\n'));
});
test('freshness rejects future and unknown timestamps and never refreshes an old observation',()=>{
  const observed='2026-10-21T08:00:00+05:30';
  assert.equal(freshness(observed,new Date('2026-10-21T02:31:30Z')).status,'fresh');
  assert.equal(freshness(observed,new Date('2026-10-21T02:31:31Z')).status,'stale');
  assert.equal(freshness(observed,new Date('2026-10-21T02:29:59Z')).status,'invalid');
  assert.equal(freshness(null,new Date()).status,'unavailable');
  assert.equal(freshness('not a date',new Date()).status,'invalid');
  assert.throws(()=>freshness(observed,new Date('invalid')));
});
test('nearby stops are ordered by bounded haversine distance',()=>{
  const s=store();
  const stops=s.nearby(6.9271,79.8612,1000);
  assert.deepEqual(stops.map(s=>s.id),['demo:stop:A','demo:stop:B']);
  assert.equal(stops[0].distance_m,0);
  // Independent equatorial vector: one degree of longitude is about 111.195 km.
  assert.ok(Math.abs(distanceMeters(0,0,0,1)-111194.9266)<0.1);
  assert.throws(()=>s.nearby(91,0));
  assert.throws(()=>s.nearby(0,0,10001));
  assert.throws(()=>s.nearby(0,0,1000,51));
});
test('invalid snapshots cannot replace last known-good data',()=>{
  const s=store(), before=s.route('demo:route:D1');
  const mutations=[
    {...demo,stops:[...demo.stops,demo.stops[0]]},
    {...demo,routes:[{...demo.routes[0],stop_ids:['A','missing']}]},
    {...demo,arrivals:[{...demo.arrivals[0],stop_id:'missing'}]},
    {...demo,source:{...demo.source,type:'live'}},
    {...demo,stops:[{...demo.stops[0],longitude:Infinity}]},
  ];
  for(const invalid of mutations){assert.throws(()=>s.activate(invalid));assert.deepEqual(s.route('demo:route:D1'),before);}
  const mutable=structuredClone(demo);s.activate(mutable);mutable.stops[0].name='changed';
  assert.equal(s.route('demo:route:D1').stops[0].name,'Demo Stop A','validated state owns its data');
});
test('queries require canonical IDs and offset times, and always disclose synthetic coverage',()=>{
  const s=store();
  assert.equal(s.search(' d1 ')[0].id,'demo:route:D1');
  assert.throws(()=>s.search(' '));
  assert.throws(()=>s.route('D1'));
  const arrivals=s.arrivals('demo:stop:A','2026-10-21T07:30:00+05:30');
  assert.equal(arrivals.length,2);
  assert.equal(arrivals[0].prediction_type,'scheduled');
  assert.equal(s.arrivals('demo:stop:A','2026-10-22T00:00:00Z').length,0);
  assert.throws(()=>s.arrivals('demo:stop:unknown','2026-10-21T00:00:00Z'));
  assert.throws(()=>s.arrivals('demo:stop:A','2026-10-21T08:00:00'));
  const envelope=s.envelope(arrivals);
  assert.equal(envelope.production_ready,false);
  assert.equal(envelope.mode,'synthetic_demo');
  assert.equal(envelope.source.type,'synthetic');
  assert.equal(envelope.freshness.status,'synthetic');
  assert.equal(s.status().realtime.status,'unavailable');
});
