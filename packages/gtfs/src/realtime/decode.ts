import { pb, type transit_realtime } from './proto.js';
import { secondsToMs } from './util.js';

export interface DecodedFeed {
  ok: true;
  header: {
    /** FeedHeader.timestamp in epoch ms; the basis for feed freshness. */
    timestamp_ms: number;
    version: string | null;
    incrementality: 'FULL_DATASET' | 'DIFFERENTIAL';
  };
  entities: transit_realtime.IFeedEntity[];
}

export interface DecodeFailure {
  ok: false;
  reason: 'empty_payload' | 'decode_error' | 'header_timestamp_missing' | 'header_timestamp_future';
  error: string;
}

export interface DecodeOptions {
  /** When given, a header timestamp more than `maxFutureMs` ahead of it is rejected (it would look fresh forever). */
  nowMs?: number;
  maxFutureMs?: number;
}

export const DEFAULT_MAX_FUTURE_MS = 5 * 60_000;

/** Never throws: malformed protobuf, truncated payloads and HTML error pages all come back as a DecodeFailure. */
export function decodeFeed(bytes: Uint8Array, opts: DecodeOptions = {}): DecodedFeed | DecodeFailure {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty_payload', error: 'empty payload' };
  let msg: transit_realtime.FeedMessage;
  try {
    msg = pb.FeedMessage.decode(bytes);
  } catch (e) {
    return { ok: false, reason: 'decode_error', error: `protobuf decode failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ts = secondsToMs(msg.header?.timestamp);
  if (ts === null) return { ok: false, reason: 'header_timestamp_missing', error: 'feed header has no timestamp' };
  const maxFuture = opts.maxFutureMs ?? DEFAULT_MAX_FUTURE_MS;
  if (opts.nowMs !== undefined && ts > opts.nowMs + maxFuture) {
    return { ok: false, reason: 'header_timestamp_future', error: `feed header timestamp is ${Math.round((ts - opts.nowMs) / 1000)}s in the future` };
  }
  return {
    ok: true,
    header: {
      timestamp_ms: ts,
      version: msg.header.gtfsRealtimeVersion || null,
      incrementality: msg.header.incrementality === pb.FeedHeader.Incrementality.DIFFERENTIAL ? 'DIFFERENTIAL' : 'FULL_DATASET',
    },
    entities: msg.entity,
  };
}

/** Encodes a plain-object feed (numbers for timestamps, enum names or numbers). For tests, replay tooling and fixtures. */
export function encodeFeed(feed: transit_realtime.IFeedMessage): Uint8Array {
  return pb.FeedMessage.encode(pb.FeedMessage.fromObject(feed)).finish();
}
