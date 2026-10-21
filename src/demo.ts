import type { Snapshot } from './core.ts';

/** Original invented fixture, not copied from an operator or a public feed. */
export const demo:Snapshot={
  provider:'demo',
  source:{type:'synthetic',attribution:'AppKade contributors, invented test network',license:'Apache-2.0'},
  stops:[
    {id:'A',name:'Demo Stop A',latitude:6.9271,longitude:79.8612},
    {id:'B',name:'Demo Stop B',latitude:6.9291,longitude:79.8632},
    {id:'C',name:'Demo Stop C',latitude:6.9391,longitude:79.8732},
  ],
  routes:[{id:'D1',name:'Demo Route 1',stop_ids:['A','B','C']}],
  arrivals:[
    {route_id:'D1',stop_id:'A',scheduled_at:'2026-10-21T08:00:00+05:30'},
    {route_id:'D1',stop_id:'B',scheduled_at:'2026-10-21T08:05:00+05:30'},
    {route_id:'D1',stop_id:'A',scheduled_at:'2026-10-21T09:00:00+05:30'},
  ],
};
