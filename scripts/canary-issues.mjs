// scripts/canary-issues.mjs
//
// The canary's one write to GitHub, kept apart from the canary itself
// (.github/workflows/canary.yml). scripts/canary.mjs runs in a job that has
// just `npm install -g`'d the newest Codex and Claude Code — their install
// scripts and binaries are code nobody here has read yet — so that job holds a
// read-only token and no persisted git credential. This script runs in a
// second job, only after a scheduled or manual canary failed, with the one
// permission it needs (`issues: write`), and reads nothing but the JSON report
// the canary uploaded: no `npm ci`, no CLI, nothing of `ms`.
//
//   node scripts/canary-issues.mjs <canary-report.json>
//
// For each CLI with a failing check it opens — or comments on, if one is
// already open — ONE issue titled "Canary: <tool> <version> breaks ms", through
// `gh` and GH_TOKEN. A report that is missing or unreadable files nothing and
// exits 1: the run is red either way, and an issue built from a report nobody
// could read would say nothing true.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NAMES = { codex: "Codex", claude: "Claude Code" };

/** One report as Markdown — the same rendering scripts/canary.mjs prints. */
export function markdown(r) {
  const lines = [`### ${NAMES[r.tool]} ${r.version ?? "(version unknown)"}`, ""];
  for (const x of r.results) lines.push(`- ${x.ok ? "✓" : "✗"} ${x.name} — ${x.detail}`);
  if (r.notes?.length) lines.push("", ...r.notes.map((n) => `- note: ${n}`));
  return lines.join("\n");
}

/**
 * The issues a report calls for: one `{ title, body }` per CLI with a failing
 * check. Only a known tool and a plain MAJOR.MINOR.PATCH make it into a title,
 * so the dedupe below (an exact title match) cannot be steered by whatever a
 * `--version` printed.
 */
export function issuesFor(reports, runUrl) {
  const out = [];
  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r || !Object.hasOwn(NAMES, r.tool) || !Array.isArray(r.results)) continue;
    const failed = r.results.filter((x) => !x.ok);
    if (!failed.length) continue;
    const version = typeof r.version === "string" && /^\d+\.\d+\.\d+$/.test(r.version) ? r.version : null;
    const title = `Canary: ${NAMES[r.tool]} ${version ?? "(version unknown)"} breaks ms`;
    const body =
      `The nightly canary found checks failing against ${NAMES[r.tool]} ${version ?? ""}.\n\nRun: ${runUrl}\n\n` +
      `**Failing**\n\n${failed.map((x) => `- ✗ ${x.name} — ${x.detail}`).join("\n")}\n\n` +
      `<details><summary>Full report</summary>\n\n${markdown(r)}\n\n</details>\n`;
    out.push({ title, body });
  }
  return out;
}

function gh(argv) {
  const r = spawnSync("gh", argv, { encoding: "utf8", timeout: 60_000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}

function main() {
  const file = process.argv[2];
  let reports;
  try {
    reports = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    process.stderr.write(`canary-issues: no readable report at ${file}: ${e?.message ?? e}\n`);
    return 1;
  }
  const env = process.env;
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "(local run)";
  const scratch = mkdtempSync(path.join(tmpdir(), "ms-canary-issues-"));
  let code = 0;
  try {
    for (const { title, body } of issuesFor(reports, runUrl)) {
      const list = gh(["issue", "list", "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title", "--limit", "20"]);
      let existing = null;
      try {
        existing = JSON.parse(list.stdout).find((i) => i.title === title) ?? null;
      } catch {
        /* treat as none */
      }
      const bodyFile = path.join(scratch, "issue.md");
      writeFileSync(bodyFile, body);
      const res = existing
        ? gh(["issue", "comment", String(existing.number), "--body-file", bodyFile])
        : gh(["issue", "create", "--title", title, "--body-file", bodyFile]);
      if (!res.ok) code = 1;
      process.stdout.write(`${existing ? `commented on #${existing.number}` : "opened an issue"}: ${res.ok ? res.stdout.trim() : `FAILED: ${res.stderr.trim()}`}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return code;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main());
