// src/accounts-codex.ts
//
// `ms accounts` — the Codex (ChatGPT) half of the account book. Where a Claude
// account carries two credentials in two places, a Codex account carries ONE,
// in one place: the `auth.json` that `codex login` writes into a CODEX_HOME.
// So this tool gives every Codex account its own CODEX_HOME
// (`MS_HOME/codex/<name>`, src/paths.ts), exactly as it gives every Claude
// account its own CLAUDE_CONFIG_DIR, and launching or rotating is then a
// matter of which directory the CLI is pointed at.
//
// And the credential is the ONLY thing that is per account. Since 0.3.6 a
// home is a view of the human's own `~/.codex` (src/codex-share.ts): it keeps
// `auth.json` and its rendered `config.toml`, and every other entry —
// `sessions` first, because a rotation resumes a conversation some OTHER
// account started — is a symlink into the base. That is also why `remove`
// deletes a home as a tree but never follows a link out of it.
//
// Identity is the ChatGPT account id out of the login's own `id_token` — never
// the nickname the human typed — which is why two rows resolving to one
// account are refused at `login`, the same refusal the Claude side makes on
// the organisation id.
//
// Rules kept here, as everywhere in the account book: every child process is
// bounded by a killed timer; a credential travels only in `env` and in an
// HTTP header, never on argv and never into a log, a message or a forwarded
// line.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { mightCarryToken, redact } from "./accounts.ts";
import { isPreLinkBackup, shareCodexState } from "./codex-share.ts";
import { ensureCodexHooks } from "./hooks/codex-install.ts";
import { codexBaseDir, ensureStore, msBinary, p } from "./paths.ts";
import { type Account, findAccount, loadRegistry, saveRegistry } from "./registry.ts";
import { probeCodexUsage, readCodexAuth } from "./providers/codex-probe.ts";

/** A device login waits on the human in another browser, on another machine. */
const LOGIN_TIMEOUT_MS = 600_000;
/** The one usage read that proves a freshly-minted credential. */
const PROBE_TIMEOUT_MS = 20_000;
/** `ls` probes every credentialed row; a slow endpoint must not hang a table. */
const LS_PROBE_TIMEOUT_MS = 10_000;

/** Names no Codex account may take, because `MS_HOME/codex/<name>` would then
 *  BE something else this tool owns. Today there is exactly one: `sessions` is
 *  the store's own path (since 0.3.6 a link to `~/.codex/sessions`), and an
 *  account of that name would have `remove` take the store with it. */
export const CODEX_RESERVED_NAMES = ["sessions"];

const out = (s: string) => process.stdout.write(s);
const warn = (s: string) => process.stderr.write(`ms accounts: ${s}\n`);

/** Load, refusing to go on when the file cannot be read: a write from an
 *  unparsed state would erase every row. The skipped-row warning is the
 *  dispatcher's (src/accounts.ts `load`), which has already run. */
function load(): ReturnType<typeof loadRegistry> {
  const r = loadRegistry();
  if (r.parseError) throw new Error(r.parseError);
  return r;
}

/** Re-read, patch the row, write. Re-read because `login` holds the human for
 *  minutes between the first read and the save. */
function update(name: string, patch: Partial<Account>): void {
  const r = load();
  const a = findAccount(r.registry, name, "codex");
  if (!a) throw new Error(`no such codex account: ${name}`);
  Object.assign(a, patch);
  saveRegistry(r.registry, r);
}

/** The other Codex account already claiming this ChatGPT account, if any.
 *  Identity is the account id, so this is what makes two nicknames for one
 *  subscription an error rather than a silently doubled pool entry. */
function accountClaimedBy(name: string, accountId: string): string | null {
  const other = load().registry.accounts.find(
    (a) => a.provider === "codex" && a.name !== name && a.orgId === accountId,
  );
  return other ? other.name : null;
}

// --- The home ----------------------------------------------------------

/**
 * This account's CODEX_HOME, created if absent (0700), and linked to the
 * human's own `~/.codex` — every entry but the credential and the rendered
 * config (src/codex-share.ts). Idempotent: `login` calls it too, so a home
 * someone deleted is rebuilt rather than reported, and a second call changes
 * nothing and says nothing.
 *
 * What the links changed goes to `say`, one line each; what they could not
 * change goes to `warn`. A real entry is never thrown away to make room for a
 * link: it is merged into the base, or moved there, or kept beside the link
 * as `<name>.pre-link.<ms>` — the share module's rules, not this one's.
 */
export function ensureCodexHome(
  name: string,
  say: (line: string) => void = () => {},
  warnLine: (line: string) => void = () => {},
): string {
  ensureStore(); // creates MS_HOME/codex, 0700
  const dir = p.codexHome(name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is masked by umask; the store's is not a suggestion
  const shared = shareCodexState(dir);
  for (const line of shared.changes) say(line);
  for (const line of shared.problems) warnLine(line);
  return dir;
}

const sayLine = (name: string) => (line: string) => out(`${name}: ${line}\n`);
const warnFor = (name: string) => (line: string) => warn(`warning: ${name}: ${line}`);

// --- The verbs ---------------------------------------------------------

/** Register the row and build the home. The name has already been validated
 *  and found free by the dispatcher (src/accounts.ts `cmdAdd`), which owns
 *  every usage-shaped refusal. */
export function addCodex(name: string, label: string, shared: boolean): number {
  const dir = ensureCodexHome(name, sayLine(name), warnFor(name));
  const r = load();
  r.registry.accounts.push({ name, provider: "codex", label, orgId: null, shared, identityVerified: false });
  saveRegistry(r.registry, r);
  out(`added ${name} (codex), CODEX_HOME ${dir} — next: ms accounts login ${name} --provider codex\n`);
  return 0;
}

/**
 * `ms accounts add <name> --provider codex` for an account that is already
 * registered: re-link its home to `~/.codex`, and nothing else. The row is
 * not rewritten — the dispatcher refuses `--label`/`--shared` here rather
 * than drop them — so running `add` again is how a home made before 0.3.6
 * (or one something has since replaced an entry of) is brought back to a
 * view of the base, and on a home that already is one it changes nothing and
 * prints nothing. Exit 1 when something could not be linked.
 */
export function relinkCodex(name: string): number {
  let problems = 0;
  ensureCodexHome(name, sayLine(name), (line) => {
    problems++;
    warnFor(name)(line);
  });
  return problems ? 1 : 0;
}

/**
 * `codex login`, streamed.
 *
 * Both output streams are piped, because the DEVICE CODE and its URL are the
 * whole point of the flow and a CLI is free to put them on either. The unit of
 * forwarding is a line; a trailing fragment with no newline yet is forwarded
 * at once, because a prompt nobody sees is a hang. stdin stays with the human
 * so an interactive flow still works.
 *
 * Codex prints no token here — the credential goes straight to `auth.json` —
 * but every line goes through the account book's own scrubber anyway: a CLI
 * that starts printing one must not be able to leak it through this process.
 */
async function runCodexLogin(name: string, dir: string, argv: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", argv, {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: dir },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();

    const forward = (s: string) => process.stderr.write(redact(s));
    const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const consume = (which: "stdout" | "stderr", chunk: string) => {
      pending[which] += chunk;
      for (let i = pending[which].indexOf("\n"); i >= 0; i = pending[which].indexOf("\n")) {
        forward(`${pending[which].slice(0, i)}\n`);
        pending[which] = pending[which].slice(i + 1);
      }
      // What is left has no newline yet. A fragment that could be carrying a
      // token — or could become one when the next chunk lands — waits for it,
      // because redaction only works on text it can see whole and a chunk
      // boundary falls wherever the pipe says. Everything else goes out at
      // once: a device-code prompt nobody sees is a hang. Exactly the Claude
      // mint's rule, and the same helper, so neither can drift from the other.
      if (pending[which] && !mightCarryToken(pending[which])) {
        forward(pending[which]);
        pending[which] = "";
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => consume("stdout", c));
    child.stderr?.on("data", (c: string) => consume("stderr", c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run codex: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const which of ["stdout", "stderr"] as const) {
        if (pending[which]) forward(`${pending[which]}\n`);
        pending[which] = "";
      }
      if (timedOut) return reject(new Error(`codex login timed out for ${name}`));
      if (code !== 0) return reject(new Error(`codex login exited ${code ?? "on a signal"} for ${name}`));
      resolve();
    });
  });
}

/** The identity `auth.json` reports, or a failure naming the file. Shared by
 *  `login` and `verify`, and always read BEFORE anything is written. */
function identifyOrRefuse(name: string, dir: string): { accountId: string; email: string | null } {
  const auth = readCodexAuth(dir);
  if (!auth) {
    throw new Error(
      `no readable auth.json in ${dir} for ${name} — run: ms accounts login ${name} --provider codex`,
    );
  }
  if (!auth.accountId) {
    throw new Error(`the credential in ${dir} names no ChatGPT account — run: ms accounts login ${name} --provider codex`);
  }
  const other = accountClaimedBy(name, auth.accountId);
  if (other) {
    throw new Error(`${name}: that ChatGPT account is already registered as ${other}`);
  }
  return { accountId: auth.accountId, email: auth.email };
}

/**
 * Prove the credential with one bounded usage read, and say what it decided.
 *
 * `auth` is fatal: a credential the endpoint refuses is not a credential, and
 * the only fix is a fresh login, so the remedy is in the message. `transient`
 * is a warning and nothing more — an unreachable endpoint says nothing about
 * the account, and failing a login over the human's wifi would be a lie.
 */
async function proveOrRefuse(name: string, dir: string): Promise<void> {
  const probe = await probeCodexUsage(dir, AbortSignal.timeout(PROBE_TIMEOUT_MS));
  if (probe === "auth") {
    throw new Error(
      `the credential for ${name} was refused by the usage endpoint — run: ms accounts login ${name} --provider codex`,
    );
  }
  if (probe === "transient") {
    warn(`warning: could not reach the usage endpoint to prove ${name}'s credential — identity is recorded, the credential is unproven`);
  }
}

function report(name: string, accountId: string, email: string | null): void {
  out(
    `${name}: ChatGPT account ${accountId}${email ? `, ${email}` : ""} — credential in ${p.codexHome(name)}, ` +
      `identity verified (codex-login)\n`,
  );
}

/**
 * Install `ms _hook codex` into this account's home, and say what happened.
 *
 * A refusal is a warning, not a failure: it names the file and the remedy
 * (`ms doctor --fix` reports the same refusal verbatim), and the credential
 * this login just minted is unaffected by it.
 */
function installHooks(name: string, dir: string): void {
  const res = ensureCodexHooks(dir, msBinary());
  if (res.problem) {
    warn(`warning: could not install the codex hooks for ${name}: ${res.problem}`);
    warn(`warning: ${name} will not report its sessions until that is fixed — then run: ms doctor --fix`);
    return;
  }
  if (res.changed) out(`${name}: codex hooks installed in ${p.codexHome(name)}/config.toml${res.backup ? ` (backup ${res.backup})` : ""}\n`);
}

/**
 * Mint the one credential and record whose it is.
 *
 * `--device-auth` is forced whenever stdin is not a TTY, because the browser
 * flow's fallback is a localhost redirect that an unattended or piped
 * invocation can never complete — a device code, printed for the human to
 * carry to any browser, always can.
 */
export async function loginCodex(name: string, opts: { deviceAuth?: boolean } = {}): Promise<number> {
  const dir = ensureCodexHome(name, sayLine(name), warnFor(name));
  const argv = opts.deviceAuth || !process.stdin.isTTY ? ["login", "--device-auth"] : ["login"];
  await runCodexLogin(name, dir, argv);
  // A login that exits 0 without writing the file did not log in. Say which
  // directory is empty; it is the only thing the human can act on.
  if (!readCodexAuth(dir)) throw new Error(`codex login left no auth.json in ${dir}`);
  // The hooks, into the home this login just filled. A Codex home without them
  // launches silently and looks healthy — no SessionStart ever fires, so the
  // row never learns its conversation id, and the first `ms rotate` respawns a
  // plain `codex` over the human's conversation. `ms doctor --fix` installs
  // them too, but nothing sends the human there, so this is where they land.
  // Never fatal: the credential is good, and the remedy for a config.toml this
  // installer will not touch is a person editing that file.
  installHooks(name, dir);
  // Identity (and the duplicate refusal) before anything is written: a refused
  // account keeps its unverified row and its home, and claims nothing.
  const { accountId, email } = identifyOrRefuse(name, dir);
  // `identityVerified` says WHOSE account this is — the login's own id_token
  // proved that, and nothing later can unprove it. Whether the credential still
  // WORKS is the probe's separate answer below, and its refusal exits without
  // taking the identity back.
  update(name, { orgId: accountId, identityVerified: true, identityMethod: "codex-login", email: email ?? undefined });
  await proveOrRefuse(name, dir);
  report(name, accountId, email);
  return 0;
}

/** Re-read the credential, re-check whose it is, re-prove it. No login. */
export async function verifyCodex(name: string): Promise<number> {
  const dir = p.codexHome(name);
  const { accountId, email } = identifyOrRefuse(name, dir);
  update(name, { orgId: accountId, identityVerified: true, identityMethod: "codex-login", email: email ?? undefined });
  await proveOrRefuse(name, dir);
  report(name, accountId, email);
  return 0;
}

/**
 * Drop the row and the account's own home.
 *
 * The home is linked to the base first (src/codex-share.ts), so whatever it
 * still holds of the human's state — a `history.jsonl` a `codex` wrote before
 * the links existed, a real `sessions` directory — is merged into `~/.codex`
 * rather than deleted with the account. Then the home goes as a TREE, and
 * `rmSync` never follows a symlink out of one: every link is unlinked as a
 * link, and the base it points into survives whole.
 *
 * Two refusals, both about transcripts, which are never this tool's to throw
 * away: a home the links could not be made in (its `sessions` might be the
 * one real copy of a conversation), and a home still holding a `sessions` or
 * `archived_sessions` directory — the part of a merged-back store that
 * DIFFERED from the base's copy and so was kept beside the link. The guard on
 * the store's own path is belt and braces: `add` already refuses the name.
 */
export function removeCodex(name: string): number {
  const r = load();
  const i = r.registry.accounts.findIndex((a) => a.name === name && a.provider === "codex");
  if (i < 0) throw new Error(`no such codex account: ${name}`);
  const dir = p.codexHome(name);
  if (path.resolve(dir) === path.resolve(p.codexSessions())) {
    throw new Error(`refusing to remove ${name}: its home is the shared rollout store ${dir}`);
  }
  const real = (f: string): string => {
    try {
      return realpathSync(f);
    } catch {
      return path.resolve(f);
    }
  };
  if (real(dir) === real(codexBaseDir())) {
    throw new Error(`refusing to remove ${name}: its home is the base ${codexBaseDir()} itself`);
  }
  if (existsSync(dir)) {
    const shared = shareCodexState(dir);
    for (const line of shared.changes) out(`${name}: ${line}\n`);
    if (shared.problems.length) {
      throw new Error(`refusing to remove ${name}: its home could not be linked to ${codexBaseDir()} first — ${shared.problems.join("; ")}`);
    }
    const transcripts = readdirSync(dir).filter((n) => {
      const bare = isPreLinkBackup(n) ? n.slice(0, n.indexOf(".pre-link.")) : n;
      if (bare !== "sessions" && bare !== "archived_sessions") return false;
      try {
        return lstatSync(path.join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
    if (transcripts.length) {
      throw new Error(
        `refusing to remove ${name}: ${transcripts.map((n) => path.join(dir, n)).join(", ")} ` +
          `holds transcripts that differ from ${codexBaseDir()}'s — move or delete it yourself first`,
      );
    }
  }
  // The credential first: the row is what NAMES it, so dropping the row before
  // the directory could strand a live `auth.json` nothing points at.
  rmSync(dir, { recursive: true, force: true });
  r.registry.accounts.splice(i, 1);
  saveRegistry(r.registry, r);
  out(`removed ${name} (codex)\n`);
  return 0;
}

/**
 * This row's POLL / TOKEN / VERIFIED cells for `ms accounts ls`.
 *
 * POLL has three answers, not two, for the same reason the Claude TOKEN column
 * does: `no` must mean "this account has no working credential", and a
 * usage endpoint we could not reach has not said that. An account with no
 * `auth.json` answers `no` without a request.
 *
 * TOKEN is `n/a`, permanently: there is no second, launch-shaped credential to
 * mint here — the CLI reads CODEX_HOME.
 */
export async function codexCells(a: Account): Promise<{ poll: string; token: string; verified: string }> {
  const probe = await probeCodexUsage(p.codexHome(a.name), AbortSignal.timeout(LS_PROBE_TIMEOUT_MS));
  return {
    poll: probe === "ok" ? "yes" : probe === "auth" ? "no" : "unknown",
    token: "n/a",
    verified: a.identityVerified ? "yes" : "no",
  };
}
