import type { ProviderConfig, RealtimeFeedKey } from '@lkt/core';

/** What one fetch of one feed returns during a replay. */
export type ReplayItem =
  /** HTTP 200 with these bytes. */
  | Uint8Array
  | { status: number; body?: Uint8Array | string; etag?: string }
  /** The fetch rejects (network error). */
  | { error: string }
  /** The fetch never answers until aborted (exercises the timeout). */
  | { hang: true };

/** One step of a recorded sequence; a feed left out repeats whatever it served last. */
export type ReplayFrame = Partial<Record<RealtimeFeedKey, ReplayItem>>;

export interface ReplaySource {
  /** Drop-in for `RealtimeHubOptions.fetchImpl`. */
  fetch: typeof fetch;
  /** Every request made, in order. */
  calls: { feed: RealtimeFeedKey; url: string; headers: Record<string, string> }[];
  /** How many times each feed has been fetched. */
  fetched(feed: RealtimeFeedKey): number;
}

/**
 * Deterministic fake upstream: the n-th fetch of a feed gets frames[n][feed]. Past the last frame the last frame's
 * behaviour repeats; a feed that was never given anything answers 404.
 */
export function createReplaySource(provider: ProviderConfig, frames: ReplayFrame[]): ReplaySource {
  const byUrl = new Map<string, RealtimeFeedKey>();
  for (const s of provider.sources) if (s.kind === 'gtfs_realtime' && s.feed) byUrl.set(s.url, s.feed);
  const counts: Record<RealtimeFeedKey, number> = { vehicle_positions: 0, trip_updates: 0, alerts: 0 };
  const last: Partial<Record<RealtimeFeedKey, ReplayItem>> = {};
  const calls: ReplaySource['calls'] = [];

  const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const feed = byUrl.get(url);
    if (!feed) return new Response('unknown replay url', { status: 404 });
    calls.push({ feed, url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const n = counts[feed]++;
    const frame = frames[Math.min(n, frames.length - 1)];
    const item = frame?.[feed] ?? last[feed];
    if (frame?.[feed]) last[feed] = frame[feed];
    if (!item) return new Response('nothing recorded', { status: 404 });

    if (item instanceof Uint8Array) return new Response(item, { status: 200 });
    if ('error' in item) throw new TypeError(item.error);
    if ('hang' in item) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const headers: Record<string, string> = item.etag ? { etag: item.etag } : {};
    const body = item.status === 304 ? null : item.body ?? null;
    return new Response(body, { status: item.status, headers });
  };

  return {
    fetch: impl as typeof fetch,
    calls,
    fetched: (feed) => counts[feed],
  };
}

