import type { ApiKeyEntry } from './config.js';

const encoder = new TextEncoder();

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** API keys held as SHA-256 digests; lookups compare digests in constant time and scan every entry. */
export class ApiKeyStore {
  private hashed: Promise<{ entry: ApiKeyEntry; digest: Uint8Array }[]> | null = null;

  constructor(private readonly entries: ApiKeyEntry[]) {}

  get size(): number {
    return this.entries.length;
  }

  private load() {
    this.hashed ??= Promise.all(this.entries.map(async (entry) => ({ entry, digest: await sha256(entry.key) })));
    return this.hashed;
  }

  async lookup(presented: string): Promise<ApiKeyEntry | null> {
    const digest = await sha256(presented);
    let found: ApiKeyEntry | null = null;
    for (const h of await this.load()) {
      if (timingSafeEqual(digest, h.digest)) found = h.entry;
    }
    return found;
  }
}

/** Extracts a presented API key from `Authorization: Bearer ...` or `x-api-key`. */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
  }
  const x = headers.get('x-api-key');
  return x && x.trim() ? x.trim() : null;
}
