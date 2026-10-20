export interface SourceConfig {
  /** Stable key exposed to clients instead of the raw URL. */
  key: string;
  kind: 'gtfs_static' | 'gtfs_realtime';
  /** Realtime feed type; absent for static. */
  feed?: 'vehicle_positions' | 'trip_updates' | 'alerts';
  url: string;
}

export interface LicenseInfo {
  declared_license: string;
  license_status: string;
  provider_authority: string;
  attribution: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  timezone: string;
  sources: SourceConfig[];
  license: LicenseInfo;
  pollIntervalSeconds: number;
  /** Static feed re-check interval. */
  staticCheckIntervalSeconds: number;
}

export const LMT: ProviderConfig = {
  id: 'lmt',
  name: 'Lanka Metro Transit',
  timezone: 'Asia/Colombo',
  pollIntervalSeconds: 15,
  staticCheckIntervalSeconds: 3600,
  sources: [
    { key: 'lmt.gtfs', kind: 'gtfs_static', url: 'https://api.transit.seyone.dev/api/v1/gtfs/download?agency=LMT' },
    {
      key: 'lmt.vehicle_positions',
      kind: 'gtfs_realtime',
      feed: 'vehicle_positions',
      url: 'https://api.transit.seyone.dev/api/v1/realtime/vehicle-positions?agency=LMT',
    },
    {
      key: 'lmt.trip_updates',
      kind: 'gtfs_realtime',
      feed: 'trip_updates',
      url: 'https://api.transit.seyone.dev/api/v1/realtime/trip-updates?agency=LMT',
    },
    {
      key: 'lmt.alerts',
      kind: 'gtfs_realtime',
      feed: 'alerts',
      url: 'https://api.transit.seyone.dev/api/v1/realtime/alerts?agency=LMT',
    },
  ],
  license: {
    declared_license: 'CC-BY-4.0',
    license_status: 'registry_declared_pending_provider_confirmation',
    provider_authority: 'unconfirmed',
    attribution: 'Lanka Metro Transit GTFS data via api.transit.seyone.dev (community feed), CC-BY-4.0',
  },
};

export const PROVIDERS: Record<string, ProviderConfig> = { [LMT.id]: LMT };
