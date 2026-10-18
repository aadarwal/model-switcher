// The last real turn is newer than launch flags. Read only bounded transcript
// metadata; never put message contents (or arbitrary config) on a command line.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Provider } from "./registry.ts";

export type LiveSettings = { model: string | null; effort: string | null };
const TAIL_BYTES = 8 * 1024 * 1024;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function effortName(value: unknown): string | null {
  return typeof value === "string" && EFFORTS.has(value) ? value : null;
}

function modelName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !value.startsWith("-") && !value.startsWith("<") && !/[\s\x00-\x1f\x7f]/.test(value) ? value : null;
}

/** Claude's assistant records and Codex's turn_context records are local CLI
 * formats, not APIs. Ignore partial/unknown records, synthetic turns, subagent
 * turns, and any Claude record explicitly belonging to another conversation. */
export function settingsFromRecords(provider: Provider, records: string[], sessionId: string | null): LiveSettings {
  for (let i = records.length - 1; i >= 0; i--) {
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(records[i]!)); } catch { continue; }
    if (provider === "claude") {
      if (row.type !== "assistant" || row.isSidechain === true) continue;
      if ([row.sessionId, row.session_id].some((id) => typeof id === "string" && sessionId && id !== sessionId)) continue;
      const model = modelName(object(row.message).model);
      if (!model) continue;
      const effort = effortName(row.effort) ?? effortName(row.perTurnEffort);
      return { model, effort };
    }
    if (row.type !== "turn_context") continue;
    const payload = object(row.payload);
    const model = modelName(payload.model);
    if (!model) continue;
    return { model, effort: effortName(payload.effort) };
  }
  return { model: null, effort: null };
}

/** A huge transcript or tool result must not make a handoff read unbounded
 * data. If the last usable turn is outside the tail, retain the launch flags
 * and report the fallback. Do not block on a FIFO or read a directory. */
export function readLiveSettings(provider: Provider, transcript: string | null, sessionId: string | null): LiveSettings {
  if (!transcript) return { model: null, effort: null };
  let fd: number | undefined;
  try {
    // O_NONBLOCK also keeps an accidentally supplied FIFO from hanging open.
    fd = openSync(transcript, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { model: null, effort: null };
    const from = Math.max(0, stat.size - TAIL_BYTES);
    const data = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const got = readSync(fd, data, 0, data.length, from);
    const records = data.subarray(0, got).toString("utf8").split("\n");
    if (from > 0) records.shift(); // the tail may begin inside a JSON record
    return settingsFromRecords(provider, records, sessionId);
  } catch {
    return { model: null, effort: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Replace only settings we actually observed. Other launch flags retain
 * their order and values, including Codex config overrides unrelated to model
 * selection. TOML strings are encoded as JSON strings (valid basic strings). */
export function flagsWithLiveSettings(provider: Provider, flags: string[], live: LiveSettings, claudeEffort: boolean): string[] {
  const useEffort = live.effort !== null && (provider === "codex" || claudeEffort);
  if (!live.model && !useEffort) return flags;
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i]!;
    if (live.model && (a === "--model" || (provider === "codex" && a === "-m"))) { i++; continue; }
    if (live.model && (a.startsWith("--model=") || (provider === "codex" && a.startsWith("-m") && !a.startsWith("--")))) continue;
    if (provider === "claude" && useEffort && a === "--effort") { i++; continue; }
    if (provider === "claude" && useEffort && a.startsWith("--effort=")) continue;
    if (provider === "codex") {
      const separate = a === "-c" || a === "--config";
      const config = separate ? flags[i + 1] : a.startsWith("--config=") ? a.slice(9) : a.startsWith("-c") && !a.startsWith("--") ? a.slice(2).replace(/^=/, "") : undefined;
      if (config && ((live.model && /^\s*model\s*=/.test(config)) || (useEffort && /^\s*model_reasoning_effort\s*=/.test(config)))) {
        if (separate) i++;
        continue;
      }
    }
    out.push(a);
  }
  if (live.model) out.push("--model", live.model);
  if (useEffort) out.push(...(provider === "claude" ? ["--effort", live.effort!] : ["-c", `model_reasoning_effort=${JSON.stringify(live.effort)}`]));
  return out;
}
