import { createHash } from 'node:crypto';

import { AppError } from '@/shared/utils.js';

/** Validation helpers shared by the session-control route and service. */
export function invalid(message: string, code = 'INVALID_ARGUMENT', statusCode = 400): never {
  throw new AppError(message, { code, statusCode });
}

/** Reads a nonempty named string; omitted optional values stay absent. */
export function stringField(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    invalid(`${name} must be a nonempty string.`);
  }
  return value;
}

/** Checks enum values without silently falling back for invalid input. */
export function enumField<T extends string>(value: unknown, name: string, values: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !values.includes(value as T)) {
    invalid(`${name} must be one of: ${values.join(', ')}.`);
  }
  return value as T;
}

/** Rejects accidental or misspelled options at the HTTP boundary too. */
export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Expected an object.');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      invalid(`Unknown argument: ${key}`);
    }
  }
  return input;
}

/** Stable digest used to bind idempotency receipts and cursors to normalized input. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Opaque cursor bound to the exact listing filters. */
export function readCursor(value: unknown, scope: string): unknown[] | null {
  if (value === undefined) {
    return null;
  }
  try {
    if (typeof value !== 'string' || value.length > 4096) {
      throw new Error();
    }
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (decoded.scope !== scope || !Array.isArray(decoded.position)) {
      throw new Error();
    }
    return decoded.position;
  }
  catch {
    return invalid('Invalid starting-token for these filters.');
  }
}

/** Encodes a continuation for the CLI's next request. */
export function cursor(scope: string, position: unknown[]): string {
  return Buffer.from(JSON.stringify({ scope, position })).toString('base64url');
}

/** Bounded page size, also accepting URL query strings. */
export function pageSize(value: unknown): number {
  if (value === undefined) {
    return 100;
  }
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500) {
    invalid('maxItems must be an integer from 1 to 500.');
  }
  return n;
}
