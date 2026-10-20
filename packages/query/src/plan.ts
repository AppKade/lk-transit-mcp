import {
  THRESHOLDS,
  ToolError,
  addDays,
  colomboDate,
  computeFreshness,
  haversineMeters,
  makeId,
  serviceDayStartMs,
  toColomboIso,
} from '@lkt/core';
import type { Envelope, PlanTripInput, ProviderConfig } from '@lkt/core';
import { TtlCache } from './cache.js';
import { routeRef } from './catalog.js';
import type { Catalog } from './catalog.js';
import { envelopeOf, realtimeKey, staticFreshness, staticKey } from './envelope.js';
import type { ActiveFeed, QueryEnv } from './env.js';
import { overlayLive } from './plan/live.js';
import { MIN_TRANSFER_MS, TRANSFER_WALK_M, WALK_BUFFER_MS, WALK_MPS, loadNetwork, walkMs } from './plan/network.js';
import type { NetStop, Network } from './plan/network.js';
import { search } from './plan/search.js';
import type { Inst, Label, Reached } from './plan/search.js';
import { pickProvider, sourceId } from './refs.js';
import { activeServices } from './schedule.js';
import type { Journey, TripLeg } from './types.js';

/** Coordinates are matched to at most this many stops, within this radius. */
const COORD_RADIUS_M = 600;
const COORD_MAX_STOPS = 3;
/** Boardings are searched this long after the departure time. */
const HORIZON_MS = 3 * 3_600_000;
const MAX_JOURNEYS = 3;
/** Two coordinate points closer than this are the same place. */
const SAME_PLACE_M = 25;
const NETWORK_TTL_MS = 5 * 60_000;

const networks = new WeakMap<QueryEnv, TtlCache<Network>>();

/** The whole timetable of a feed version, loaded once per TTL; service-date filtering happens per call on top of it. */
function network(env: QueryEnv, cfg: ProviderConfig, feed: ActiveFeed): Promise<Network> {
  let cache = networks.get(env);
  if (!cache) {
    cache = new TtlCache(env.ctx.clock, NETWORK_TTL_MS, 8);
    networks.set(env, cache);
  }
  return cache.getOrLoad(`${cfg.id}:${feed.id}`, () => loadNetwork(env.ctx.db, feed.id));
}

interface Endpoint {
  /** Candidate stops with the straight-line walk from (to) the given place; 0 m for a stop. */
  stops: { stop: NetStop; meters: number }[];
  coords: boolean;
  lat: number;
  lon: number;
}

const PSEUDO = {
  origin: { stop_id: 'origin', name: 'Origin (coordinates)' },
  destination: { stop_id: 'destination', name: 'Destination (coordinates)' },
} as const;

function resolvePlace(cfg: ProviderConfig, net: Network, place: PlanTripInput['origin']): Endpoint {
  if (place.stop_id !== undefined) {
    const stop = net.byId.get(sourceId(cfg, place.stop_id, 'stop'));
    if (!stop) throw new ToolError('unknown_stop', `Unknown stop '${place.stop_id}'.`, { stop_id: place.stop_id });
    return { stops: [{ stop, meters: 0 }], coords: false, lat: stop.lat, lon: stop.lon };
  }
  const { latitude, longitude } = place;
  if (latitude === undefined || longitude === undefined) {
    throw new ToolError('invalid_argument', 'Provide stop_id, or both latitude and longitude.');
  }
  const stops = net.stops
    .filter((s) => net.served[s.idx])
    .map((stop) => ({ stop, meters: haversineMeters(latitude, longitude, stop.lat, stop.lon) }))
    .filter((c) => c.meters <= COORD_RADIUS_M)
    .sort((a, b) => a.meters - b.meters || a.stop.id.localeCompare(b.stop.id))
    .slice(0, COORD_MAX_STOPS);
  return { stops, coords: true, lat: latitude, lon: longitude };
}

/** Trip runs that can still be caught in [fromMs, toMs], over the service days that may overlap it (>24:00 times included). */
function instantiate(net: Network, catalog: Catalog, fromMs: number, toMs: number, wheelchairOnly: boolean): { runs: Inst[]; hadService: boolean } {
  const out: Inst[] = [];
  let hadService = false;
  const lastDate = colomboDate(toMs);
  for (let date = addDays(colomboDate(fromMs), -1); date <= lastDate; date = addDays(date, 1)) {
    const services = new Set(activeServices(catalog.calendar, date));
    if (services.size === 0) continue;
    if (date >= colomboDate(fromMs)) hadService = true;
    const start = serviceDayStartMs(date);
    for (const trip of net.trips) {
      if (!services.has(trip.serviceId) || (wheelchairOnly && trip.wheelchair !== 1)) continue;
      const arr = trip.arr.map((s) => start + s * 1000);
      const dep = trip.dep.map((s) => start + s * 1000);
      if (arr[arr.length - 1]! < fromMs || dep[0]! > toMs) continue;
      out.push({ trip, date, arr, dep, live: dep.map(() => false) });
    }
  }
  out.sort((a, b) => a.dep[0]! - b.dep[0]! || a.trip.tripId.localeCompare(b.trip.tripId) || a.date.localeCompare(b.date));
  return { runs: out, hadService };
}

const hhmm = (ms: number) => toColomboIso(ms).slice(11, 16);

export async function planTrip(env: QueryEnv, input: PlanTripInput): Promise<Envelope<Journey[]>> {
  const cfg = pickProvider(env.ctx, undefined, [input.origin.stop_id, input.destination.stop_id]);
  const feed = await env.requireFeed(cfg);
  const now = env.now();
  const depMs = input.departure_time === undefined ? now : Date.parse(input.departure_time);
  if (!Number.isFinite(depMs)) throw new ToolError('invalid_argument', 'departure_time is not a valid ISO 8601 timestamp.');
  const maxTransfers = input.max_transfers ?? 1;
  const horizonEnd = depMs + HORIZON_MS;

  const [net, catalog, snapshot] = await Promise.all([network(env, cfg, feed), env.catalog(cfg, feed), env.snapshot(cfg)]);
  // Coordinates live only in these locals for the duration of the call.
  const origin = resolvePlace(cfg, net, input.origin);
  const dest = resolvePlace(cfg, net, input.destination);
  const sameStop = !origin.coords && !dest.coords && origin.stops[0]!.stop.id === dest.stops[0]!.stop.id;
  if (sameStop || ((origin.coords || dest.coords) && haversineMeters(origin.lat, origin.lon, dest.lat, dest.lon) <= SAME_PLACE_M)) {
    throw new ToolError('invalid_argument', 'Origin and destination are the same place.');
  }

  const assumptions = [
    `Walking at ${WALK_MPS} m/s (${(WALK_MPS * 3.6).toFixed(1)} km/h) over straight-line distance; real walking routes can be longer.`,
    `Transfers at the same stop need at least ${MIN_TRANSFER_MS / 1000} s; transfers on foot to a stop within ${TRANSFER_WALK_M} m add ${WALK_BUFFER_MS / 1000} s on top of the walk.`,
    'Timetable-based; live delay applied only where a fresh provider update exists.',
  ];
  if (origin.coords || dest.coords) {
    assumptions.push(`Coordinates are matched to the ${COORD_MAX_STOPS} closest stops within ${COORD_RADIUS_M} m and are not stored.`);
  }
  const wheelchairOnly = input.wheelchair_accessible && net.hasWheelchairData;
  if (input.wheelchair_accessible) {
    assumptions.push(
      wheelchairOnly
        ? 'Only trips the feed flags as wheelchair accessible are used; stop access and walking legs are not verified.'
        : 'Wheelchair accessibility is unknown: the feed has no accessibility data, so journeys are not filtered and no accessibility is claimed.',
    );
  }

  const tuFeed = computeFreshness(snapshot.feeds.trip_updates.header_timestamp_ms, now, THRESHOLDS.tripUpdateSeconds);
  if (tuFeed.status === 'stale') {
    assumptions.push(`Live trip updates are stale (${tuFeed.age_seconds} s old), so timetable times are used.`);
  }

  const { runs: insts, hadService } = instantiate(net, catalog, depMs, horizonEnd, wheelchairOnly);
  if (tuFeed.status === 'fresh') overlayLive(net, insts, snapshot, now);

  const originStops = new Set(origin.stops.map((c) => c.stop.idx));
  const targetMeters = new Map(dest.stops.filter((c) => !originStops.has(c.stop.idx)).map((c) => [c.stop.idx, c.meters]));
  const starts: Label[] = origin.stops.map(({ stop, meters }) => {
    const arrMs = depMs + (origin.coords ? walkMs(meters) : 0);
    return { kind: 'start', k: 0, stop: stop.idx, arrMs, readyMs: arrMs, parent: null, walkM: origin.coords ? meters : 0 };
  });

  const reached = search(net, insts, starts, {
    maxLegs: maxTransfers + 1,
    horizonEnd,
    targets: new Map([...targetMeters].map(([idx, m]) => [idx, dest.coords ? walkMs(m) : 0])),
  });

  const build = { cfg, net, catalog, dest, targetMeters };
  const data = reached
    .map((r) => buildJourney(build, r, assumptions))
    .filter((j): j is Journey => j !== null)
    .sort((a, b) => Date.parse(a.arrives) - Date.parse(b.arrives) || a.transfers - b.transfers)
    .slice(0, MAX_JOURNEYS);

  const liveUsed = data.some((j) => j.legs.some((l) => l.prediction_type === 'provider_live'));
  const usedLiveFeed = liveUsed || tuFeed.status === 'stale';
  const urlRef = [staticKey(cfg), ...(usedLiveFeed ? [realtimeKey(cfg, 'trip_updates')] : [])];
  // A degraded live feed is always reported; a healthy one only when its data is actually in the answer.
  const freshness = tuFeed.status !== 'fresh' || liveUsed ? tuFeed : staticFreshness(feed, now, env.today());
  const result: Envelope<Journey[]> & { notes?: string[] } = envelopeOf(cfg, now, feed, liveUsed ? 'mixed' : 'gtfs_static', urlRef, freshness, data);
  if (data.length === 0) {
    result.notes = [...assumptions, noJourneyReason(origin, dest, targetMeters.size, hadService, depMs, maxTransfers)];
  }
  return result;
}

function noJourneyReason(origin: Endpoint, dest: Endpoint, targets: number, hadService: boolean, depMs: number, maxTransfers: number): string {
  if (origin.stops.length === 0) return `No served stop within ${COORD_RADIUS_M} m of the origin coordinates.`;
  if (dest.stops.length === 0) return `No served stop within ${COORD_RADIUS_M} m of the destination coordinates.`;
  if (targets === 0) return 'Origin and destination are served by the same nearby stop; walking is the better option.';
  if (!hadService) return `No scheduled service found from ${colomboDate(depMs)} within the search horizon.`;
  return (
    `No journey with at most ${maxTransfers} transfer(s) found for boardings between ${hhmm(depMs)} and ${hhmm(depMs + HORIZON_MS)} ` +
    `(${HORIZON_MS / 3_600_000}-hour search horizon); a later departure or more transfers may work.`
  );
}

interface BuildContext {
  cfg: ProviderConfig;
  net: Network;
  catalog: Catalog;
  dest: Endpoint;
  targetMeters: Map<number, number>;
}

function buildJourney({ cfg, net, catalog, dest, targetMeters }: BuildContext, r: Reached, assumptions: string[]): Journey | null {
  const chain: Label[] = [];
  for (let l: Label | null = r.label; l; l = l.parent) chain.unshift(l);
  if (new Set(chain.map((l) => l.stop)).size !== chain.length) return null; // never revisit a stop

  const ref = (s: NetStop) => ({ stop_id: makeId(cfg.id, 'stop', s.id), name: s.name });
  const stopAt = (idx: number) => net.stops[idx]!;
  const iso = toColomboIso;
  const legs: TripLeg[] = [];

  for (const l of chain) {
    if (l.kind === 'bus') {
      const { inst, from, to } = l;
      if (!inst || from === undefined || to === undefined) return null;
      const route = catalog.routes.get(inst.trip.routeId);
      legs.push({
        mode: 'bus',
        route: route ? routeRef(cfg, route) : { route_id: makeId(cfg.id, 'route', inst.trip.routeId), short_name: null, long_name: null },
        headsign: inst.trip.headsign ?? catalog.directionHeadsign.get(`${inst.trip.routeId}|${inst.trip.directionId ?? ''}`) ?? null,
        from_stop: ref(stopAt(inst.trip.stops[from]!)),
        to_stop: ref(stopAt(inst.trip.stops[to]!)),
        departs: iso(inst.dep[from]!),
        arrives: iso(inst.arr[to]!),
        prediction_type: inst.live[from] || inst.live[to] ? 'provider_live' : 'scheduled',
      });
    } else if (l.kind === 'walk' && l.parent) {
      legs.push({
        mode: 'walk',
        from_stop: ref(stopAt(l.parent.stop)),
        to_stop: ref(stopAt(l.stop)),
        departs: iso(l.parent.arrMs),
        arrives: iso(l.arrMs),
        walk_meters: Math.round(l.walkM),
      });
    }
  }

  const first = chain[0]!;
  const firstBus = legs[0];
  if (first.walkM > 0 && firstBus) {
    // Leave as late as possible while still reaching the stop a minute before the bus.
    const walk = walkMs(first.walkM);
    const departMs = Math.max(first.arrMs - walk, Date.parse(firstBus.departs) - walk - WALK_BUFFER_MS);
    legs.unshift({
      mode: 'walk',
      from_stop: PSEUDO.origin,
      to_stop: firstBus.from_stop,
      departs: iso(departMs),
      arrives: iso(departMs + walk),
      walk_meters: Math.round(first.walkM),
    });
  }
  const egress = targetMeters.get(r.label.stop) ?? 0;
  if (dest.coords && egress > 0) {
    legs.push({
      mode: 'walk',
      from_stop: ref(stopAt(r.label.stop)),
      to_stop: PSEUDO.destination,
      departs: iso(r.label.arrMs),
      arrives: iso(r.finalMs),
      walk_meters: Math.round(egress),
    });
  }

  const departs = legs[0]!.departs;
  const arrives = legs[legs.length - 1]!.arrives;
  const buses = legs.filter((l) => l.mode === 'bus');
  const live = buses.filter((l) => l.prediction_type === 'provider_live').length;
  return {
    departs,
    arrives,
    duration_minutes: Math.round((Date.parse(arrives) - Date.parse(departs)) / 60_000),
    transfers: buses.length - 1,
    legs,
    assumptions: live > 0 ? [...assumptions, `${live} of ${buses.length} bus leg(s) use fresh provider live predictions; the rest are timetable times.`] : assumptions,
  };
}
