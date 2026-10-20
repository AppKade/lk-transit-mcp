import { MIN_TRANSFER_MS, WALK_BUFFER_MS, walkMs } from './network.js';
import type { NetTrip, Network } from './network.js';

/** A trip on one service date, with absolute epoch-ms times (live-shifted where a fresh prediction applies). */
export interface Inst {
  trip: NetTrip;
  date: string;
  arr: number[];
  dep: number[];
  /** Position i carries a time taken from (or propagated from) a fresh provider prediction. */
  live: boolean[];
}

/**
 * How a passenger holds a stop. `arrMs` is when they are there; `readyMs` is the earliest they can board the next bus
 * (arrival plus the transfer allowance).
 */
export interface Label {
  kind: 'start' | 'bus' | 'walk';
  /** Bus legs used so far. */
  k: number;
  stop: number;
  arrMs: number;
  readyMs: number;
  parent: Label | null;
  /** bus: the trip instance and the positions boarded / alighted. */
  inst?: Inst;
  from?: number;
  to?: number;
  /** walk: metres walked (start labels: the access walk from the origin coordinates, 0 for a stop origin). */
  walkM: number;
}

export interface Reached {
  label: Label;
  finalMs: number;
}

export interface SearchOptions {
  /** Maximum number of bus legs (max_transfers + 1). */
  maxLegs: number;
  /** Latest boarding time. */
  horizonEnd: number;
  /** Destination stop index -> egress walk in ms. */
  targets: Map<number, number>;
}

const INF = Number.POSITIVE_INFINITY;

/**
 * Round-based earliest-arrival scan (RAPTOR-lite): round k holds the best way to reach each stop with at most k bus
 * legs; walking transfers are relaxed after each round. Returns the Pareto set over (arrival, bus legs), at most one
 * journey per round and only when a round strictly improves the final arrival.
 */
export function search(net: Network, insts: Inst[], starts: Label[], opts: SearchOptions): Reached[] {
  const n = net.stops.length;
  const best: (Label | undefined)[] = new Array<Label | undefined>(n);
  const ready: (Label | undefined)[] = new Array<Label | undefined>(n);
  const offer = (l: Label): boolean => {
    let kept = false;
    if (l.arrMs < (best[l.stop]?.arrMs ?? INF)) {
      best[l.stop] = l;
      kept = true;
    }
    if (l.readyMs < (ready[l.stop]?.readyMs ?? INF)) {
      ready[l.stop] = l;
      kept = true;
    }
    return kept;
  };
  for (const s of starts) offer(s);

  const found: Reached[] = [];
  let bestFinal = INF;
  for (let k = 1; k <= opts.maxLegs; k++) {
    const boardable = ready.slice();
    const fresh: Label[] = [];
    for (const inst of insts) {
      const t = inst.trip;
      let boarded: Label | undefined;
      let boardedAt = -1;
      for (let i = 0; i < t.stops.length; i++) {
        const stop = t.stops[i]!;
        if (boarded && t.alight[i]) {
          const arrMs = inst.arr[i]!;
          const label: Label = {
            kind: 'bus', k: boarded.k + 1, stop, arrMs, readyMs: arrMs + MIN_TRANSFER_MS,
            parent: boarded, inst, from: boardedAt, to: i, walkM: 0,
          };
          if (offer(label)) fresh.push(label);
        }
        if (!boarded && t.board[i]) {
          const here = boardable[stop];
          const dep = inst.dep[i]!;
          if (here && here.readyMs <= dep && dep <= opts.horizonEnd) {
            boarded = here;
            boardedAt = i;
          }
        }
      }
    }
    for (const bus of fresh) {
      if (best[bus.stop] !== bus && ready[bus.stop] !== bus) continue;
      for (const f of net.footpaths[bus.stop]!) {
        const arrMs = bus.arrMs + walkMs(f.meters);
        offer({ kind: 'walk', k: bus.k, stop: f.to, arrMs, readyMs: arrMs + WALK_BUFFER_MS, parent: bus, walkM: f.meters });
      }
    }

    let top: Reached | undefined;
    for (const [stop, egressMs] of opts.targets) {
      const label = best[stop];
      if (!label || label.k === 0) continue;
      const finalMs = label.arrMs + egressMs;
      if (!top || finalMs < top.finalMs) top = { label, finalMs };
    }
    if (top && top.finalMs < bestFinal) {
      found.push(top);
      bestFinal = top.finalMs;
    }
    if (fresh.length === 0) break;
  }
  return found;
}
