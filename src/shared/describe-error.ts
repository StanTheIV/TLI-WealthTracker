/**
 * describeError — the one formatter for a caught value (`catch (err)`,
 * `.catch(err => …)`, `'error'` listeners). Every main and worker catch site
 * formats through it.
 *
 * A `catch` binding is `unknown`: anything can be thrown, and formatting it
 * with `${err}` / `String(err)` can itself throw (a null-prototype object, a
 * Symbol, a throwing `toString` / `Symbol.toPrimitive`, a revoked Proxy) —
 * turning a logged failure into a second, unlogged one. This never throws for
 * ANY input and never coerces an unknown value with `${}` / `String()`:
 *
 * - Error (incl. subclasses) → its `stack` (V8: `Name: message` + frames);
 *   without a usable stack → `name: message` (or just the name). A `cause`
 *   chain is appended as `Caused by: …` lines, at most MAX_CAUSE_DEPTH deep,
 *   a cycle printed as `[circular cause]`.
 * - string → as is; Symbol → `.toString()`; number / boolean / undefined →
 *   their primitive spelling; BigInt → digits + `n`; null → `null`.
 * - anything else (plain object, array, function, Proxy) → its JSON when that
 *   is informative, else `Object.prototype.toString` (`[object Object]`).
 *   A user-defined `toString` is never called.
 * - Each Error property is read through its own guard, so a throwing `stack`
 *   getter still yields `name: message`; if everything fails (a revoked
 *   Proxy) the result is `'[unprintable error]'`.
 *
 * Length cap: the result is cut to MAX_ERROR_LENGTH characters (plus a
 * `… [truncated N chars]` marker). A normal stack with a cause or two is
 * 1–4 KB; 8 KB keeps every real diagnostic whole while a pathological value
 * (a multi-megabyte thrown string or JSON blob) can't flood the log file or
 * an IPC reply. The cap applies to the formatted output only — computing it
 * is bounded by the input (JSON.stringify of a huge object still runs).
 *
 * Pure, imports nothing — usable from main, worker and renderer.
 */

export const MAX_ERROR_LENGTH = 8_192;
export const MAX_CAUSE_DEPTH  = 5;
export const UNPRINTABLE_ERROR = '[unprintable error]';

export function describeError(err: unknown): string {
  try {
    return capLength(describeValue(err, [], 0));
  } catch {
    return UNPRINTABLE_ERROR;
  }
}

/**
 * The first line of `describeError` — for an Error `Name: message`, without
 * frames or causes. For a short user-facing string (an IPC reply the renderer
 * shows), never for the log: the log gets the full `describeError`.
 */
export function describeErrorBrief(err: unknown): string {
  const full = describeError(err);
  const eol  = full.indexOf('\n');
  return eol === -1 ? full : full.slice(0, eol);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `seen` holds the Errors already on the current cause chain (cycle guard). */
function describeValue(value: unknown, seen: object[], depth: number): string {
  switch (typeof value) {
    case 'string':    return value;
    case 'symbol':    return value.toString();
    case 'number':
    case 'boolean':
    case 'undefined': return String(value);
    case 'bigint':    return `${value.toString()}n`;
    default:          break;
  }
  if (value === null) return 'null';
  // typeof 'object' | 'function' from here.
  const obj = value as object;
  if (obj instanceof Error) return describeErrorObject(obj, seen, depth);
  return describeOther(obj);
}

function describeErrorObject(error: Error, seen: object[], depth: number): string {
  seen.push(error);
  let text = errorHead(error);
  // `cause` is ES2022; the project lib is older, so read it untyped.
  const cause = guard(() => (error as {cause?: unknown}).cause);
  if (cause !== undefined) {
    let causeText: string;
    if (typeof cause === 'object' && cause !== null && seen.includes(cause)) causeText = '[circular cause]';
    else if (depth + 1 >= MAX_CAUSE_DEPTH) causeText = '[cause chain truncated]';
    else causeText = guard(() => describeValue(cause, seen, depth + 1)) ?? UNPRINTABLE_ERROR;
    text += `\nCaused by: ${causeText}`;
  }
  return text;
}

/** The stack when usable, else `name: message`. */
function errorHead(error: Error): string {
  const stack = guard(() => error.stack);
  if (typeof stack === 'string' && stack.length > 0) return stack;
  const rawName = guard(() => error.name);
  const name    = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Error';
  const message = guard(() => error.message);
  return typeof message === 'string' && message.length > 0 ? `${name}: ${message}` : name;
}

/** A non-Error object: informative JSON, else its `[object Tag]`. */
function describeOther(obj: object): string {
  const json = guard(() => JSON.stringify(obj));
  if (typeof json === 'string' && json !== '{}') return json;
  const tag = guard(() => Object.prototype.toString.call(obj));
  return typeof tag === 'string' ? tag : UNPRINTABLE_ERROR;
}

function guard<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function capLength(text: string): string {
  if (text.length <= MAX_ERROR_LENGTH) return text;
  let cut = MAX_ERROR_LENGTH;
  // Don't split a surrogate pair.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}… [truncated ${text.length - cut} chars]`;
}
