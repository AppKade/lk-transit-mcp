import { THRESHOLDS } from '@lkt/core';
import type { RealtimeSnapshot, RtStopTimeUpdate, RtTripUpdate } from '@lkt/core';
import type { Network } from './network.js';
import type { Inst } from './search.js';

/** Same tolerance as arrivals: a prediction belongs to a timetable row within |delay| + this many seconds. */
const MATCH_SLACK_MS = 180_000;

interface Pair {
  tu: RtTripUpdate;
  inst: Inst;
  hits: Map<number, number>;
  gap: number;
}

/**
 * Shifts the times of trip instances that a fresh TripUpdate belongs to. LMT realtime trip ids do not match static
 * ones, so a TripUpdate is paired with the timetable run of the same route/direction whose stop times it fits best
 * (each run used once). A prediction sets the time at its stop and its delay carries forward to later stops until the
 * next prediction. Returns the number of runs shifted. The caller decides whether the feed is fresh enough to call this.
 */
export function overlayLive(net: Network, insts: Inst[], snapshot: RealtimeSnapshot, nowMs: number): number {
  const byRoute = new Map<string, Inst[]>();
  for (const inst of insts) {
    const list = byRoute.get(inst.trip.routeId);
    if (list) list.push(inst);
    else byRoute.set(inst.trip.routeId, [inst]);
  }

  const pairs: Pair[] = [];
  for (const tu of snapshot.tripUpdates) {
    const rid = tu.resolution.route_id;
    if (rid === null || tu.schedule_relationship === 'CANCELED' || tu.schedule_relationship === 'DELETED') continue;
    if (nowMs - tu.observed_at_ms > THRESHOLDS.tripUpdateSeconds * 1000) continue;
    const direction = tu.resolution.direction_id ?? tu.direction_id;
    const updates = tu.stop_time_updates.filter(usable);
    if (updates.length === 0) continue;
    for (const inst of byRoute.get(rid) ?? []) {
      if (direction !== null && inst.trip.directionId !== null && direction !== inst.trip.directionId) continue;
      const hits = match(net, inst, updates);
      if (hits.size === 0) continue;
      let gap = 0;
      for (const [i, liveMs] of hits) gap += Math.abs(inst.dep[i]! - liveMs);
      pairs.push({ tu, inst, hits, gap });
    }
  }
  pairs.sort(
    (a, b) =>
      b.hits.size - a.hits.size ||
      a.gap / a.hits.size - b.gap / b.hits.size ||
      a.tu.entity_id.localeCompare(b.tu.entity_id) ||
      a.inst.dep[0]! - b.inst.dep[0]!,
  );

  const usedTu = new Set<RtTripUpdate>();
  const usedInst = new Set<Inst>();
  for (const p of pairs) {
    if (usedTu.has(p.tu) || usedInst.has(p.inst)) continue;
    usedTu.add(p.tu);
    usedInst.add(p.inst);
    shift(p.inst, p.hits);
  }
  return usedInst.size;
}

const usable = (u: RtStopTimeUpdate): boolean =>
  u.schedule_relationship !== 'SKIPPED' && u.schedule_relationship !== 'NO_DATA' && (u.departure_time_ms ?? u.arrival_time_ms) !== null;

/** position in the run -> predicted time, for the updates that fit the timetable. */
function match(net: Network, inst: Inst, updates: RtStopTimeUpdate[]): Map<number, number> {
  const hits = new Map<number, number>();
  for (const u of updates) {
    const stop = u.stop_id === null ? undefined : net.byId.get(u.stop_id);
    if (!stop) continue;
    const i = inst.trip.stops.indexOf(stop.idx);
    if (i < 0 || hits.has(i)) continue;
    const liveMs = (u.departure_time_ms ?? u.arrival_time_ms)!;
    const tolerance = Math.abs(u.departure_delay_s ?? u.arrival_delay_s ?? 0) * 1000 + MATCH_SLACK_MS;
    if (Math.abs(inst.dep[i]! - liveMs) <= tolerance) hits.set(i, liveMs);
  }
  return hits;
}

function shift(inst: Inst, hits: Map<number, number>): void {
  let delay: number | null = null;
  let clock = 0;
  for (let i = 0; i < inst.dep.length; i++) {
    const liveMs = hits.get(i);
    if (liveMs !== undefined) delay = liveMs - inst.dep[i]!;
    if (delay !== null) {
      inst.arr[i] = inst.arr[i]! + delay;
      inst.dep[i] = inst.dep[i]! + delay;
      inst.live[i] = true;
    }
    // Keep the run monotone even if predictions disagree.
    inst.arr[i] = Math.max(inst.arr[i]!, clock);
    inst.dep[i] = Math.max(inst.dep[i]!, inst.arr[i]!);
    clock = inst.dep[i]!;
  }
}
