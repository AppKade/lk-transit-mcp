import { getArrivals } from './arrivals.js';
import { getServiceAlerts } from './alerts.js';
import { QueryEnv } from './env.js';
import { findStopsNearby } from './nearby.js';
import { planTrip } from './plan.js';
import { getRoute, searchRoutes } from './routes.js';
import { getFeedStatus, listProviders } from './status.js';
import type { QueryContext, TransitQueries } from './types.js';
import { getVehiclePositions } from './vehicles.js';

export function createTransitQueries(ctx: QueryContext): TransitQueries {
  const env = new QueryEnv(ctx);
  return {
    listProviders: async () => listProviders(env),
    findStopsNearby: (input) => findStopsNearby(env, input),
    getArrivals: (input) => getArrivals(env, input),
    getVehiclePositions: (input) => getVehiclePositions(env, input),
    searchRoutes: (input) => searchRoutes(env, input),
    getRoute: (input) => getRoute(env, input),
    getServiceAlerts: (input) => getServiceAlerts(env, input),
    getFeedStatus: (input) => getFeedStatus(env, input),
    planTrip: (input) => planTrip(env, input),
  };
}
