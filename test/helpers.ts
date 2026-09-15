import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tempHome(): { home: string; msHome: string } {
  const home = mkdtempSync(path.join(tmpdir(), "ms-test-"));
  const msHome = path.join(home, ".config", "model-switcher");
  mkdirSync(msHome, { recursive: true, mode: 0o700 });
  return { home, msHome };
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
