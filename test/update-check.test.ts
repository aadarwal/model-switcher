import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import {
  CHECK_EVERY_MS,
  RELEASES_URL,
  readUpdateCache,
  refreshDue,
  startRefresh,
  updateCheck,
  updateCheckEnabled,
  updateNotice,
} from "../src/update-check.ts";

// The release check (src/update-check.ts). The suite runs with it OFF
// (test/setup-env.mjs); these tests drive its parts directly, and the one that
// starts the real detached child points it at a local server, never GitHub.

test("the check asks GitHub's public releases API for this repository", () => {
  assert.equal(RELEASES_URL, "https://api.github.com/repos/aadarwal/model-switcher/releases/latest");
});

test("updateCheckEnabled: on by default; off with MS_NO_UPDATE_CHECK, under CI, and under node:test", () => {
  assert.equal(updateCheckEnabled({}), true);
  assert.equal(updateCheckEnabled({ MS_NO_UPDATE_CHECK: "1" }), false);
  assert.equal(updateCheckEnabled({ MS_NO_UPDATE_CHECK: "yes" }), false);
  assert.equal(updateCheckEnabled({ MS_NO_UPDATE_CHECK: "0" }), true);
  assert.equal(updateCheckEnabled({ MS_NO_UPDATE_CHECK: "" }), true);
  assert.equal(updateCheckEnabled({ CI: "true" }), false);
  assert.equal(updateCheckEnabled({ CI: "false" }), true);
  assert.equal(updateCheckEnabled({ NODE_TEST_CONTEXT: "child-v8" }), false);
  assert.equal(updateCheckEnabled(process.env), false, "the suite itself runs with the check off");
});

test("refreshDue: once a day, counting a failed attempt like a successful one", () => {
  const now = 10 * CHECK_EVERY_MS;
  assert.equal(refreshDue({}, now), true);
  assert.equal(refreshDue({ checkedAt: now - 1000 }, now), false);
  assert.equal(refreshDue({ attemptedAt: now - 1000, checkedAt: now - 3 * CHECK_EVERY_MS }, now), false);
  assert.equal(refreshDue({ attemptedAt: now - CHECK_EVERY_MS }, now), true);
  assert.equal(refreshDue({ attemptedAt: now + CHECK_EVERY_MS }, now), true, "a clock that went backwards retries");
});

test("updateNotice: only for a release newer than this one", () => {
  assert.equal(updateNotice({ latest: "0.3.11" }, "0.3.10", "brew upgrade model-switcher"), "ms 0.3.11 is available (you have 0.3.10) — brew upgrade model-switcher");
  assert.equal(updateNotice({ latest: "0.3.10" }, "0.3.10", "H"), null);
  assert.equal(updateNotice({ latest: "0.3.9" }, "0.3.10", "H"), null);
  assert.equal(updateNotice({}, "0.3.10", "H"), null);
  assert.equal(updateNotice({ latest: "garbage" }, "0.3.10", "H"), null);
});

test("updateCheck: disabled means no notice and no file — nothing is even read", (t) => {
  const { msHome } = tempHome();
  const saved = process.env.MS_HOME;
  process.env.MS_HOME = msHome;
  t.after(() => { process.env.MS_HOME = saved; });
  assert.equal(updateCheck({ MS_NO_UPDATE_CHECK: "1" }), null);
  assert.equal(existsSync(path.join(msHome, "update-check.json")), false);
});

type Seen = { headers: IncomingHttpHeaders; url: string };

async function server(t: TestContext, status: number, body: unknown): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const srv = createServer((req, res) => {
    seen.push({ headers: req.headers, url: req.url ?? "" });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/releases/latest`, seen };
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("startRefresh: a detached child fetches the latest release and writes it to the cache (0600)", async (t) => {
  const { msHome } = tempHome();
  const file = path.join(msHome, "update-check.json");
  const { url, seen } = await server(t, 200, { tag_name: "v9.8.7", name: "ignored" });
  assert.equal(startRefresh({ url, file, now: 1234, version: "0.3.10" }), true);
  // The stamp is written before the child starts, so a second verb a moment
  // later does not start a second child.
  assert.ok(existsSync(file));
  await waitFor(() => readUpdateCache(file).latest === "9.8.7");
  const cache = readUpdateCache(file);
  assert.ok(cache.checkedAt && cache.checkedAt > 1234);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.headers["user-agent"], "model-switcher/0.3.10");
  assert.equal(seen[0]!.headers.authorization, undefined, "unauthenticated");
});

test("startRefresh: a failed fetch leaves only the stamp, so the next try is a day away", async (t) => {
  const { msHome } = tempHome();
  const file = path.join(msHome, "update-check.json");
  const { url, seen } = await server(t, 403, { message: "rate limited" });
  assert.equal(startRefresh({ url, file, now: 1234, version: "0.3.10" }), true);
  await waitFor(() => seen.length === 1);
  await new Promise((r) => setTimeout(r, 300)); // the child has answered and exited
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { attemptedAt: 1234 });
});

test("startRefresh: no store yet means nowhere to write the answer — no child at all", () => {
  assert.equal(startRefresh({ url: "http://127.0.0.1:9/", file: "/nonexistent-ms-home/update-check.json" }), false);
});
