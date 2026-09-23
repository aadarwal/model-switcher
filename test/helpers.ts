import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `src/paths.ts`'s `msHome()` now canonicalises `MS_HOME` with `realpathSync`
 * once the directory exists (fixing a symlinked store, e.g. one made with
 * `ln -s`, losing its Codex hook trust — see that file). On macOS `os.tmpdir()`
 * is itself `/tmp`, a symlink to `/private/tmp`, so every temp dir this helper
 * hands out is exactly that scenario: without resolving here too, a test that
 * sets `MS_HOME` to this literal path and then compares it against a value the
 * tool derived internally (e.g. `CODEX_HOME`) would see them diverge — not a
 * real bug, just this helper handing out an unresolved alias of the same
 * directory the tool itself resolves. Resolving both `home` and `msHome` here
 * keeps every such comparison exact.
 */
export function tempHome(): { home: string; msHome: string } {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ms-test-")));
  const msHome = path.join(home, ".config", "model-switcher");
  mkdirSync(msHome, { recursive: true, mode: 0o700 });
  // This home's own `~/.codex` is the base every codex home links into
  // (src/codex-share.ts), so a test that makes a home gets a base of its own
  // too — not the per-process one test/setup-env.mjs pins as the floor, which
  // every test in a file would otherwise share. `run()` spreads process.env,
  // so a child `ms` sees the same base; a test that wants another sets it.
  process.env.MS_CODEX_BASE_DIR = path.join(home, ".codex");
  return { home, msHome: realpathSync(msHome) };
}

/** A directory of fake executables; `stub(name, script)` writes a bash script. */
export function stubDir(): { dir: string; stub: (name: string, body: string) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ms-stubs-"));
  return {
    dir,
    stub(name, body) {
      const p = path.join(dir, name);
      writeFileSync(p, `#!/bin/bash\n${body}\n`);
      chmodSync(p, 0o755);
    },
  };
}

export function run(args: string[], env: Record<string, string> = {}, input = ""): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("bin/ms"), ...args], {
    input,
    encoding: "utf8",
    // Child processes do not inherit the test runner's --disable-warning flag; without this,
    // every `ms` verb that opens node:sqlite on Node 22 prints an ExperimentalWarning to stderr
    // and one-line-stderr assertions break.
    env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning", ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
