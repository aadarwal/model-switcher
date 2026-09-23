import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tempHome } from "./helpers.ts";

/**
 * A symlink pointing at a real store `tempHome()` made — the live finding's
 * exact shape: `MS_HOME` set to a symlink of the real store. The symlink
 * lives in its own temp dir so it is never itself a path prefix of `real`.
 */
function symlinkedHome(): { real: string; link: string } {
  const { msHome: real } = tempHome();
  const link = path.join(mkdtempSync(path.join(tmpdir(), "ms-test-link-")), "store");
  symlinkSync(real, link, "dir");
  return { real, link };
}

test("msHome resolves a symlinked MS_HOME to the real store directory", async () => {
  const { real, link } = symlinkedHome();
  process.env.MS_HOME = link;
  const { msHome, p } = await import("../src/paths.ts");
  assert.equal(msHome(), real);
  assert.notEqual(msHome(), link, "the symlink spelling must not leak into a derived path");
  assert.equal(p.registry, path.join(real, "accounts.json"));
});

test("CODEX_HOME is derived from the canonical store, not the MS_HOME symlink", async () => {
  const { real, link } = symlinkedHome();
  process.env.MS_HOME = link;
  const { p } = await import("../src/paths.ts");
  assert.equal(p.codexHome("work"), path.join(real, "codex", "work"));
});

// This is the reported bug, reproduced directly: Codex keys hook trust on the
// config path IT sees, which is the real path. Before this fix, `p.codexHome`
// (and so the trust key `[hooks.state."<config path>:…"]`) echoed back
// whichever spelling of MS_HOME the caller happened to use, so a hook
// installed under one spelling read as untrusted — or not installed at all —
// under the other.
test("the Codex hook's config path (the trust key's own string) is identical whether MS_HOME is given as the symlink or the real directory", async () => {
  const { real, link } = symlinkedHome();
  const { p } = await import("../src/paths.ts");
  const { codexConfigPath } = await import("../src/hooks/codex-install.ts");

  process.env.MS_HOME = link;
  const viaSymlink = codexConfigPath(p.codexHome("work"));

  process.env.MS_HOME = real;
  const viaReal = codexConfigPath(p.codexHome("work"));

  assert.equal(viaSymlink, viaReal, "a hook installed under one spelling of MS_HOME must be trusted under the other");
  assert.equal(viaSymlink, path.join(real, "codex", "work", "config.toml"));
});

test("a non-existent MS_HOME resolves to the literal path, and ensureStore still creates it 0700", async () => {
  const { home } = tempHome();
  const fresh = path.join(home, "not-yet-created", "model-switcher");
  process.env.MS_HOME = fresh;
  const { msHome, ensureStore } = await import("../src/paths.ts");

  assert.equal(msHome(), fresh, "nothing exists yet to resolve — the literal path is used, as today");
  assert.equal(existsSync(fresh), false);

  ensureStore();
  assert.equal(existsSync(fresh), true);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
});

test("the Codex base is ~/.codex, MS_CODEX_BASE_DIR moves it, and the base config follows it unless named itself", async () => {
  const { codexBaseDir, codexBaseConfigPath } = await import("../src/paths.ts");
  const saved = { home: process.env.HOME, dir: process.env.MS_CODEX_BASE_DIR, cfg: process.env.MS_CODEX_BASE_CONFIG };
  try {
    process.env.HOME = "/Users/someone";
    delete process.env.MS_CODEX_BASE_DIR;
    delete process.env.MS_CODEX_BASE_CONFIG;
    assert.equal(codexBaseDir(), "/Users/someone/.codex");
    assert.equal(codexBaseConfigPath(), "/Users/someone/.codex/config.toml");
    // NOT $CODEX_HOME: inside an ms pane that names the account home itself.
    process.env.CODEX_HOME = "/Users/someone/.config/model-switcher/codex/work";
    assert.equal(codexBaseDir(), "/Users/someone/.codex");
    delete process.env.CODEX_HOME;

    process.env.MS_CODEX_BASE_DIR = "/tmp/elsewhere/.codex";
    assert.equal(codexBaseDir(), "/tmp/elsewhere/.codex");
    assert.equal(codexBaseConfigPath(), "/tmp/elsewhere/.codex/config.toml");
    process.env.MS_CODEX_BASE_CONFIG = "/tmp/pinned/config.toml";
    assert.equal(codexBaseConfigPath(), "/tmp/pinned/config.toml");
  } finally {
    const put = (name: string, v: string | undefined) => (v === undefined ? delete process.env[name] : (process.env[name] = v));
    put("HOME", saved.home);
    put("MS_CODEX_BASE_DIR", saved.dir);
    put("MS_CODEX_BASE_CONFIG", saved.cfg);
  }
});

test("ensureStore no longer makes codex/sessions — since 0.3.6 that path is a link, made by the linker", async () => {
  const { msHome } = tempHome();
  process.env.MS_HOME = msHome;
  const { ensureStore } = await import("../src/paths.ts");
  ensureStore();
  assert.equal(existsSync(path.join(msHome, "codex")), true);
  assert.equal(existsSync(path.join(msHome, "codex", "sessions")), false);
});
