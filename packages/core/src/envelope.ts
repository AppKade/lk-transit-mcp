import type { Freshness } from './freshness.js';
import { toColomboIso } from './time.js';
import type { LicenseInfo } from './provider.js';

export interface EnvelopeSource {
  type: 'gtfs_static' | 'gtfs_realtime' | 'derived' | 'mixed';
  /** Configured source key (e.g. `lmt.vehicle_positions`), never the raw upstream URL. */
  url_ref: string[];
  feed_version: string | null;
  license: string;
  license_status: string;
  provider_authority: string;
  attribution: string;
}

export interface Envelope<T> {
  provider: string;
  as_of: string;
  freshness: Freshness;
  source: EnvelopeSource;
  data: T;
}

export function makeSource(
  type: EnvelopeSource['type'],
  urlRef: string[],
  feedVersion: string | null,
  license: LicenseInfo,
): EnvelopeSource {
  return {
    type,
    url_ref: urlRef,
    feed_version: feedVersion,
    license: license.declared_license,
    license_status: license.license_status,
    provider_authority: license.provider_authority,
    attribution: license.attribution,
  };
}

export function makeEnvelope<T>(
  provider: string,
  nowMs: number,
  freshness: Freshness,
  source: EnvelopeSource,
  data: T,
): Envelope<T> {
  return { provider, as_of: toColomboIso(nowMs), freshness, source, data };
}
