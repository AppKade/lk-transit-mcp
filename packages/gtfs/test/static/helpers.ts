import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import Papa from 'papaparse';

export const FIXTURE_ZIP = fileURLToPath(new URL('../../../../fixtures/lmt/gtfs.zip', import.meta.url));

/** The "today" used throughout: inside the fixture's 2026-01-01..2027-12-31 service window. */
export const TODAY = '2026-10-20';

export type Files = Record<string, string>;
export type Table = Record<string, string>[];

export const fixtureBytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE_ZIP));

/** Text of every file in the real LMT fixture. */
export function fixtureFiles(): Files {
  const out: Files = {};
  for (const [name, data] of Object.entries(unzipSync(fixtureBytes()))) out[name] = strFromU8(data);
  return out;
}

export const zip = (files: Files): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

export function readTable(files: Files, name: string): Table {
  return Papa.parse<Record<string, string>>(files[name]!, { header: true, skipEmptyLines: true }).data;
}

/** Applies `fn` to a table of the fixture; `fn` may mutate in place or return a replacement. */
export function editTable(files: Files, name: string, fn: (rows: Table) => Table | void): Files {
  const rows = readTable(files, name);
  const columns = Papa.parse<string[]>(files[name]!.split('\n', 1)[0]!, {}).data[0]!;
  const next = fn(rows) ?? rows;
  return { ...files, [name]: Papa.unparse({ fields: columns, data: next.map((r) => columns.map((c) => r[c] ?? '')) }, { newline: '\n' }) };
}

/** Fixture zip with the given edits applied to its files. */
export function fixtureWith(...edits: ((f: Files) => Files)[]): Uint8Array {
  return zip(edits.reduce((f, e) => e(f), fixtureFiles()));
}

export const without = (name: string) => (f: Files): Files => {
  const { [name]: _gone, ...rest } = f;
  return rest;
};
