import type { ToolErrorCode } from '@lkt/core';
import { ToolError } from '@lkt/core';

/** Tool error codes plus HTTP-only conditions that never come from the query layer. */
export type ApiErrorCode =
  | ToolErrorCode
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'timeout';

const STATUS: Record<ApiErrorCode, number> = {
  invalid_argument: 400,
  unauthorized: 401,
  forbidden: 403,
  unknown_stop: 404,
  unknown_route: 404,
  unknown_provider: 404,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  provider_unavailable: 503,
  timeout: 504,
};

export function statusFor(code: ApiErrorCode): number {
  return STATUS[code] ?? 500;
}

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

/** An error that is safe to show to clients as-is (message is authored by us). */
export class HttpError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
  get status(): number {
    return statusFor(this.code);
  }
}

export interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}
export interface ZodLikeError {
  issues: ZodLikeIssue[];
}

/** Turns zod issues into a client-safe invalid_argument error. Never echoes the offending values. */
export function invalidArgument(error: ZodLikeError): HttpError {
  const issues = error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
  const message = issues
    .slice(0, 5)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
  return new HttpError('invalid_argument', `Invalid arguments. ${message}`, { issues });
}

/** Removes anything that looks like an upstream URL or a stack frame from a string. */
export function scrubString(s: string): string {
  return s.replace(/\bhttps?:\/\/[^\s"')\]]+/gi, '[url]').replace(/\n\s+at\s.*/g, '');
}

function scrubDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, depth + 1)]));
}

export interface NormalizedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  headers: Record<string, string>;
}

/**
 * Maps anything thrown below the HTTP layer to a client-safe error. Unknown errors become a generic `internal`:
 * their message and stack are never sent (they may contain upstream URLs, SQL or coordinates).
 */
export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details, headers: err.headers };
  }
  if (err instanceof ToolError) {
    return {
      status: statusFor(err.code),
      code: err.code,
      message: scrubString(err.message),
      details: err.details === undefined ? undefined : scrubDeep(err.details),
      headers: {},
    };
  }
  return { status: 500, code: 'internal', message: 'Internal error', headers: {} };
}

export function errorBody(e: Pick<NormalizedError, 'code' | 'message' | 'details'>): ErrorBody {
  return { error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } };
}
