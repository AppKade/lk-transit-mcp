export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
}

/** GET `url` into memory with a hard timeout (covering the body) and a size cap. Works on Workers and Node. */
export async function fetchBytes(fetchImpl: typeof fetch, url: string, opts: FetchOptions): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { accept: 'application/zip, application/octet-stream, */*' },
    });
    if (!res.ok) throw new Error(`upstream responded HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opts.maxBytes) throw new Error(`download exceeds ${opts.maxBytes} bytes`);
    if (!res.body) {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.byteLength > opts.maxBytes) throw new Error(`download exceeds ${opts.maxBytes} bytes`);
      return all;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`download exceeds ${opts.maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`download timed out after ${opts.timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
