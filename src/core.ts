import { z } from 'zod';

const label = z.string().min(1).max(200);
export const providerId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);
export const instant = z.iso.datetime({offset:true});
const stop = z.strictObject({id:label, name:label, latitude, longitude});
const route = z.strictObject({id:label, name:label, stop_ids:z.array(label).min(2).max(500)});
const arrival = z.strictObject({route_id:label, stop_id:label, scheduled_at:instant});
export const snapshotSchema = z.strictObject({
  provider:providerId,
  source:z.strictObject({type:z.literal('synthetic'), attribution:label, license:z.literal('Apache-2.0')}),
  stops:z.array(stop).min(1).max(5000),
  routes:z.array(route).min(1).max(5000),
  arrivals:z.array(arrival).max(10000),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function canonicalId(provider:string, kind:'stop'|'route'|'trip'|'vehicle', sourceId:string) {
  providerId.parse(provider);
  if (!['stop','route','trip','vehicle'].includes(kind) || typeof sourceId!=='string' || !sourceId || sourceId.length>200 || /[\u0000-\u001f\u007f]/.test(sourceId)) throw new Error('INVALID_ID');
  return `${provider}:${kind}:${sourceId}`;
}

/** Age is based on the observation, never the time a cache was read. */
export function freshness(observedAt:string|null, now:Date, maxAgeSeconds=90) {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds<0) throw new Error('INVALID_CLOCK');
  if (observedAt===null) return {status:'unavailable' as const, age_seconds:null};
  if (!instant.safeParse(observedAt).success) return {status:'invalid' as const, age_seconds:null};
  const age=(now.getTime()-Date.parse(observedAt))/1000;
  if (!Number.isFinite(age) || age<0) return {status:'invalid' as const, age_seconds:null};
  return {status:age<=maxAgeSeconds?'fresh' as const:'stale' as const, age_seconds:age};
}

export function distanceMeters(lat1:number, lon1:number, lat2:number, lon2:number) {
  latitude.parse(lat1); longitude.parse(lon1); latitude.parse(lat2); longitude.parse(lon2);
  const rad=(v:number)=>v*Math.PI/180;
  const a=Math.sin(rad(lat2-lat1)/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(rad(lon2-lon1)/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,a))));
}

/** Validates an entire candidate before replacing the last known-good snapshot. */
export class TransitStore {
  private active:Snapshot|undefined;
  activate(input:unknown) {
    const next=snapshotSchema.parse(input);
    const unique=(values:string[])=>new Set(values).size===values.length;
    const stops=new Set(next.stops.map(s=>s.id)), routes=new Map(next.routes.map(r=>[r.id,r]));
    if (!unique(next.stops.map(s=>s.id)) || !unique(next.routes.map(r=>r.id))) throw new Error('DUPLICATE_ID');
    for (const stop of next.stops) canonicalId(next.provider,'stop',stop.id);
    for (const route of next.routes) {
      canonicalId(next.provider,'route',route.id);
      if (route.stop_ids.some(id=>!stops.has(id))) throw new Error('UNKNOWN_STOP');
    }
    for (const arrival of next.arrivals) {
      if (!routes.get(arrival.route_id)?.stop_ids.includes(arrival.stop_id)) throw new Error('ORPHAN_ARRIVAL');
    }
    this.active=next;
  }
  private snapshot() {
    if (!this.active) throw new Error('NO_FEED');
    return this.active;
  }
  envelope(data:unknown, now=new Date()) {
    const snapshot=this.snapshot();
    return {mode:'synthetic_demo', production_ready:false, provider:snapshot.provider, as_of:now.toISOString(),
      freshness:{status:'synthetic',age_seconds:null}, source:{...snapshot.source},
      warning:'Invented demo data. No live provider connection. Do not use for travel decisions.', data};
  }
  nearby(lat:number, lon:number, radius=1000, limit=10) {
    latitude.parse(lat); longitude.parse(lon);
    z.number().positive().max(10000).parse(radius); z.number().int().min(1).max(50).parse(limit);
    const snapshot=this.snapshot();
    return snapshot.stops.map(s=>({...s,id:canonicalId(snapshot.provider,'stop',s.id),distance_m:distanceMeters(lat,lon,s.latitude,s.longitude)}))
      .filter(s=>s.distance_m<=radius).sort((a,b)=>a.distance_m-b.distance_m||a.id.localeCompare(b.id)).slice(0,limit);
  }
  search(query:string, limit=10) {
    z.string().min(1).max(100).parse(query); z.number().int().min(1).max(50).parse(limit);
    const term=query.trim().toLowerCase();
    if (!term) throw new Error('EMPTY_QUERY');
    const snapshot=this.snapshot();
    return snapshot.routes.filter(r=>r.name.toLowerCase().includes(term)||r.id.toLowerCase().includes(term)).slice(0,limit)
      .map(r=>({id:canonicalId(snapshot.provider,'route',r.id),name:r.name}));
  }
  route(id:string) {
    const snapshot=this.snapshot();
    const route=snapshot.routes.find(r=>canonicalId(snapshot.provider,'route',r.id)===id);
    if (!route) throw new Error('ROUTE_NOT_FOUND');
    return {id, name:route.name, stops:route.stop_ids.map(stopId=>{
      const stop=snapshot.stops.find(s=>s.id===stopId)!;
      return {...stop,id:canonicalId(snapshot.provider,'stop',stop.id)};
    })};
  }
  arrivals(stopId:string, at:string, limit=10) {
    instant.parse(at); z.number().int().min(1).max(50).parse(limit);
    const snapshot=this.snapshot();
    if (!snapshot.stops.some(s=>canonicalId(snapshot.provider,'stop',s.id)===stopId)) throw new Error('STOP_NOT_FOUND');
    return snapshot.arrivals.filter(a=>canonicalId(snapshot.provider,'stop',a.stop_id)===stopId&&Date.parse(a.scheduled_at)>=Date.parse(at))
      .sort((a,b)=>Date.parse(a.scheduled_at)-Date.parse(b.scheduled_at)).slice(0,limit)
      .map(a=>({route_id:canonicalId(snapshot.provider,'route',a.route_id), stop_id:stopId, scheduled_at:a.scheduled_at,
        prediction_type:'scheduled', synthetic:true}));
  }
  status() {
    const snapshot=this.snapshot();
    return {static:{status:'synthetic',stops:snapshot.stops.length,routes:snapshot.routes.length},
      realtime:{status:'unavailable',vehicles:0,trip_updates:0,alerts:0},
      missing:['authorized_provider_source','gtfs_ingestion','gtfs_rt_ingestion','journey_planning','eta_validation']};
  }
}
