import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

// A `claude setup-token` (one year, inference-scope only; spec §6). This
// module never prints or logs a token, and never puts one in an error
// message — only account names and paths.
const SETUP_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

export function looksLikeSetupToken(s: string): boolean {
  return SETUP_TOKEN_PATTERN.test(s);
}

export function saveLaunchToken(name: string, token: string): void {
  ensureStore();
  const file = p.launchToken(name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The account's launch token, or null when there is not one we can use.
 *
 * ANY read failure is a null, not a throw. The caller's question is "can this
 * account be launched right now", and a file that is unreadable answers it
 * exactly as a file that is absent does — but only one of the two used to say
 * so. Live, `chmod 000` on one token file made this throw EACCES out of the
 * middle of a recovery transaction, into the catch-all, as "recovery failed":
 * the session was left owned by a worker that had already exited, and the other
 * accounts — which were fine — were never even tried. A candidate we cannot
 * read a credential for is a candidate to skip.
 *
 * The note is for the human who has to fix the file, and is printed only under
 * MS_VERBOSE: the path and the errno, never a byte of the file itself. ENOENT
 * is the ordinary case (no token for this account) and says nothing.
 */
export function readLaunchToken(name: string): string | null {
  const file = p.launchToken(name);
  try {
    const contents = readFileSync(file, "utf8").trim();
    return contents.length ? contents : null;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT" && process.env.MS_VERBOSE === "1") {
      process.stderr.write(`ms: cannot read the launch token for '${name}' (${err.code ?? "read failed"}): ${file}\n`);
    }
    return null;
  }
}

export function deleteLaunchToken(name: string): void {
  rmSync(p.launchToken(name), { force: true });
}
