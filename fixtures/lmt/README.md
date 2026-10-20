Recorded 2026-10-20 from the public LMT feeds at api.transit.seyone.dev (CC-BY-4.0 per registry; authority unconfirmed).
`gtfs.zip` static feed; `*.pb` GTFS-Realtime payloads. Observed facts the code must respect:
- realtime trip ids (`LMT_CM01_0_WP-NE-5208`) do not match static trip ids (`TRIP_CM01_D0_T1`)
- TripUpdate route_id is the route short name (`CM03`); static route_id is a UUID
- TripUpdate stop_ids and static stop_ids match (numeric strings)
- VehiclePositions carry occupancy; the alerts feed was empty at capture time
- the static feed has one daily service calendar (2026-01-01 .. 2027-12-31)
- parsed counts: 7 routes (CM06 has no trips), 220 stops, 56 trips, 1092 stop_times
- VehiclePosition.speed is published in km/h (values up to ~79), not m/s as the GTFS-RT spec says
- entity timestamps can lag the feed header by up to ~30 min
