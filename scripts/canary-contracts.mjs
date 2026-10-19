// Credential-free provider contracts shared by the nightly canary and its
// regressions. Query only the app-server hook inventory; never start a thread.
import { spawn } from "node:child_process";

/** Read the provider's own parsed hook definitions, hashes and trust state.
 * The only process controlled here is the child created for this request. */
export async function codexHookList(bin, { cwd, env, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["app-server", "--listen", "stdio://"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let outcome;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("hook inventory timed out")), timeoutMs);
    let killTimer;
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    function finish(error, result) {
      if (finished) return;
      finished = true;
      outcome = { error, result };
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    }
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
    child.stdout.on("data", (chunk) => {
      if (finished) return;
      buffer += chunk;
      if (buffer.length > (1 << 20)) { finish(new Error("hook inventory output exceeded 1 MiB")); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { finish(new Error("hook inventory returned malformed JSON")); return; }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) { finish(new Error(`hook inventory request failed: ${JSON.stringify(message.error)}`)); return; }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
        } else {
          finish(null, message.result);
          return;
        }
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (outcome) outcome.error ? reject(outcome.error) : resolve(outcome.result);
      else reject(new Error(`hook inventory exited before replying (${code}): ${stderr.trim()}`));
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "model-switcher-canary", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
  });
}

/** Compare all ms-owned entries; binary strings alone cannot establish that
 * Codex still recognizes the TOML or computes the hashes we write. */
export function checkCodexHooks(inventory, expected, command, configPath) {
  const rows = inventory?.data;
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]?.hooks)) {
    return [{ name: "Codex parses ms hook inventory", ok: false, detail: "missing one hooks/list result with hook definitions" }];
  }
  const row = rows[0];
  const checks = [{ name: "Codex parses ms hook configuration", ok: Array.isArray(row.errors) && row.errors.length === 0, detail: JSON.stringify(row.errors ?? "missing errors field") }];
  for (const event of expected) {
    const hooks = row.hooks.filter((hook) => hook?.command === command && hook.eventName === event.eventName);
    const hook = hooks[0];
    const ok = hooks.length === 1 && hook.handlerType === "command" && hook.enabled === true && hook.isManaged === false
      && hook.async === false && hook.sourcePath === configPath && hook.key === event.key
      && hook.timeoutSec === event.timeout && hook.currentHash === event.hash && hook.trustStatus === "trusted";
    checks.push({ name: `Codex accepts trusted ${event.eventName} hook`, ok, detail: hooks.length === 1 ? `trust=${hook.trustStatus}, timeout=${hook.timeoutSec}, hash=${hook.currentHash}, key=${hook.key}` : `expected one ms hook, found ${hooks.length}` });
  }
  return checks;
}
