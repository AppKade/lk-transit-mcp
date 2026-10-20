import { weekday } from '@lkt/core';

/** Weekday flags are indexed 0 = Sunday ... 6 = Saturday (same as `weekday()` in core). */
export interface CalendarRow {
  service_id: string;
  days: boolean[];
  start: string;
  end: string;
}

export interface ServiceCalendar {
  calendars: CalendarRow[];
  /** date -> service_id -> exception_type (1 add, 2 remove) */
  exceptions: Map<string, Map<string, number>>;
}

/** service_ids running on a "YYYY-MM-DD" service date: calendar rows, then calendar_dates add/remove. */
export function activeServices(cal: ServiceCalendar, date: string): string[] {
  const active = new Set<string>();
  const dow = weekday(date);
  for (const c of cal.calendars) {
    if (c.days[dow] && c.start <= date && date <= c.end) active.add(c.service_id);
  }
  for (const [serviceId, type] of cal.exceptions.get(date) ?? []) {
    if (type === 1) active.add(serviceId);
    else if (type === 2) active.delete(serviceId);
  }
  return [...active];
}
