// src/dashboard/api.ts
//
// The dashboard's JSON API over the existing store and the manual verbs
// (Plan 4, Task 1). `ms dashboard` (Task 2) serves a local page that polls
// this; this module owns none of that transport — `handle()` is a pure
// `(request) => response` function so a server, and the tests, can call it
// directly with no HTTP in between.
//
// The API never returns anything token-shaped: `statusJson()` (src/status.ts)
// already carries only percentages, names and states, and the manual verbs
// (src/manual.ts) never print a token either — `captureVerb` below only
// relays whatever ONE line a verb wrote to its own stderr.

import type { Verb } from "../cli.ts";
import { rotateVerb, stopVerb, switchAll, switchVerb } from "../manual.ts";
import { statusJson } from "../status.ts";

// The CLI's own `--timeout` default (`ALL_TIMEOUT_SECONDS` in src/manual.ts,
// 600 s) for a request that never names one — the same 10-minute budget for
// STARTING handoffs, whether the fleet move comes from `ms switch --all` or
// from here.
const DEFAULT_SWITCH_ALL_TIMEOUT_MS = 600_000;

export type ApiRequest = { method: string; path: string; body?: unknown };
export type ApiResponse = { status: number; json: unknown };

// --- captureVerb ------------------------------------------------------

/**
 * Run a verb function with an argv array, and hand back its exit code and
 * the one line it wrote to stderr, instead of letting that line reach the
 * process's real stderr.
 *
 * `process.stderr.write` is one global function, so two requests racing each
 * other through this module must never interleave their captures — every
 * call is serialised through the `chain` queue below, one at a time. The
 * swap is undone in a `finally`, on the throw path exactly as much as the
 * return path, so a verb that throws never leaves the process's stderr
 * permanently replaced, and the queue always advances past it — a verb
 * exception must not wedge every request behind it forever.
 */
let chain: Promise<unknown> = Promise.resolve();

export function captureVerb(fn: Verb, argv: string[]): Promise<{ code: number; message: string }> {
  const task = chain.then(async () => {
    // Not bound: nothing here ever calls `original` (the captured line never
    // reaches the real stderr), so the exact reference that was there before
    // is what must come back — a bound copy would leave `process.stderr.write`
    // one layer deeper than it started, verb after verb.
    const original = process.stderr.write;
    let out = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await fn(argv);
      return { code, message: out.trimEnd() };
    } finally {
      process.stderr.write = original;
    }
  });
  chain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

// --- Body validation ----------------------------------------------------
//
// Each parser accepts only what its route needs and rejects everything
// else outright — a body that is not an object, that is missing a required
// field, or that has a field of the wrong type, all read the same way: the
// human forgot something, not a value worth guessing at.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

type RotateBody = { session: string; force: boolean };
type SwitchBody = { session: string; to: string; continue: boolean; force: boolean };
type StopBody = { session: string };
type SwitchAllBody = { to: string; force: boolean; timeoutMs: number };

function parseRotateBody(body: unknown): RotateBody | null {
  if (!isRecord(body) || typeof body.session !== "string") return null;
  if (body.force !== undefined && !isBool(body.force)) return null;
  return { session: body.session, force: body.force === true };
}
function parseSwitchBody(body: unknown): SwitchBody | null {
  if (!isRecord(body) || typeof body.session !== "string" || typeof body.to !== "string") return null;
  if (body.continue !== undefined && !isBool(body.continue)) return null;
  if (body.force !== undefined && !isBool(body.force)) return null;
  return { session: body.session, to: body.to, continue: body.continue === true, force: body.force === true };
}
function parseStopBody(body: unknown): StopBody | null {
  if (!isRecord(body) || typeof body.session !== "string") return null;
  return { session: body.session };
}
function parseSwitchAllBody(body: unknown): SwitchAllBody | null {
  if (!isRecord(body) || typeof body.to !== "string") return null;
  if (body.force !== undefined && !isBool(body.force)) return null;
  if (body.timeoutMs !== undefined && !isPositiveNumber(body.timeoutMs)) return null;
  return { to: body.to, force: body.force === true, timeoutMs: (body.timeoutMs as number | undefined) ?? DEFAULT_SWITCH_ALL_TIMEOUT_MS };
}

function badBody(expected: string): ApiResponse {
  return { status: 400, json: { error: `malformed body: expected ${expected}` } };
}

// --- Routes ---------------------------------------------------------------

/** A verb's own refusal (exit 1) or usage error (exit 2) is an ordinary,
 *  well-formed answer — only a verb that THROWS is a server error. */
async function runVerb(fn: Verb, argv: string[]): Promise<ApiResponse> {
  try {
    const { code, message } = await captureVerb(fn, argv);
    return { status: 200, json: { code, message } };
  } catch (e) {
    return { status: 500, json: { error: (e as Error).message } };
  }
}

export async function handle(req: ApiRequest): Promise<ApiResponse> {
  const { method, path, body } = req;

  if (method === "GET" && path === "/api/state") {
    try {
      // Same snapshot freshness `ms status` itself asks for (20 s) —
      // statusJson() fixes that internally, so the dashboard never costs a
      // second poll when a launch or a recovery already took one recently.
      return { status: 200, json: await statusJson() };
    } catch (e) {
      return { status: 500, json: { error: (e as Error).message } };
    }
  }

  if (method === "POST" && path === "/api/rotate") {
    const parsed = parseRotateBody(body);
    if (!parsed) return badBody("{ session: string, force?: boolean }");
    const argv = [parsed.session, ...(parsed.force ? ["--force"] : [])];
    return runVerb(rotateVerb, argv);
  }

  if (method === "POST" && path === "/api/switch") {
    const parsed = parseSwitchBody(body);
    if (!parsed) return badBody("{ session: string, to: string, continue?: boolean, force?: boolean }");
    const argv = [
      parsed.session,
      "--to",
      parsed.to,
      ...(parsed.continue ? ["--continue"] : []),
      ...(parsed.force ? ["--force"] : []),
    ];
    return runVerb(switchVerb, argv);
  }

  if (method === "POST" && path === "/api/stop") {
    const parsed = parseStopBody(body);
    if (!parsed) return badBody("{ session: string }");
    return runVerb(stopVerb, [parsed.session]);
  }

  if (method === "POST" && path === "/api/switch-all") {
    const parsed = parseSwitchAllBody(body);
    if (!parsed) return badBody("{ to: string, force?: boolean, timeoutMs?: number }");
    // `switchAll` (src/manual.ts, Task 3) IS the fleet move — this route calls
    // it in-process, the same way every other route here calls a verb
    // function directly rather than shelling out. `continueAfter: "auto"`
    // matches the CLI's own default (`ms switch --all`, no `--continue`):
    // a walled screen carries its unfinished work over on its own; an idle
    // one does not. `message` is non-null only when `to` itself had no
    // answer (unreadable registry, unregistered, or an account name two
    // providers both claim) — nothing was started, and `results` is empty.
    try {
      const { results, code, message } = await switchAll(parsed.to, {
        force: parsed.force,
        continueAfter: "auto",
        timeoutMs: parsed.timeoutMs,
      });
      return { status: 200, json: { code, message, results } };
    } catch (e) {
      return { status: 500, json: { error: (e as Error).message } };
    }
  }

  return { status: 404, json: { error: `no such route: ${method} ${path}` } };
}
