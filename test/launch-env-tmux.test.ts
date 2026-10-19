import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { tempHome, run } from "./helpers.ts";

const tmuxProbe = spawnSync("tmux", ["-V"], { encoding: "utf8" });

test("an existing tmux server preserves caller CLI/settings across a real fake-CLI handoff", { skip: tmuxProbe.status !== 0 }, async (t) => {
  const { home, msHome } = tempHome();
  const socket = path.join(home, "isolated.sock"), selected = path.join(home, "selected"), stale = path.join(home, "stale");
  mkdirSync(selected); mkdirSync(stale);
  const bin = path.resolve("bin/ms"), nodeDir = path.dirname(process.execPath);
  const serverPath = `${stale}:${nodeDir}:${process.env.PATH}`;
  const callerPath = `${selected}:${nodeDir}:${process.env.PATH}`;
  const env = { ...process.env, HOME: home, MS_HOME: msHome, MS_BIN: bin, MS_ENTRY: "src", NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
    PATH: serverPath, CLAUDE_CONFIG_DIR: "/stale/server-config", ANTHROPIC_MODEL: "server-model", CLAUDE_CODE_EFFORT_LEVEL: "low",
    ANU_ACCOUNT: "legacy", ANU_PROVIDER: "claude", ANU_LAUNCH_NONCE: "legacy", ANU_PANE: "%99", HOMI_AGENT_NAME: "keep-peer",
    MS_POLL_MS: "20", MS_READY_MS: "10000", MS_SETTLE_MS: "100", MS_REBALANCE: "0" };
  const tmux = (args: string[]) => spawnSync("tmux", ["-f", "/dev/null", "-S", socket, ...args], { env, encoding: "utf8", timeout: 10_000 });
  t.after(() => { tmux(["kill-server"]); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(path.join(stale, "claude"), "#!/bin/sh\necho WRONG_SERVER_CLI\nsleep 30\n"); chmodSync(path.join(stale, "claude"), 0o755);
  writeFileSync(path.join(selected, "claude"), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import {DatabaseSync} from 'node:sqlite';
if(process.argv.includes('--version')){console.log('2.1.303');process.exit(0);}
if(process.argv.includes('--help')){console.log(' --effort <level>');process.exit(0);}
const e=process.env,g=Number(e.MS_GENERATION),id=e.MS_SESSION,db=new DatabaseSync(path.join(e.MS_HOME,'state.sqlite'));
const row=db.prepare('SELECT cliSessionId FROM sessions WHERE id=?').get(id),cli=row.cliSessionId;
const transcript=path.join(e.MS_HOME,'fake-transcript-'+id+'.jsonl');
fs.writeFileSync(transcript,JSON.stringify({type:'assistant',sessionId:cli,message:{model:'sonnet'},effort:'medium'})+'\\n');
db.prepare("UPDATE sessions SET state='running',transcriptPath=? WHERE id=?").run(transcript,id);db.close();
const dir=path.join(e.MS_HOME,'sessions',id);fs.mkdirSync(dir,{recursive:true});
fs.appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify({t:Math.floor(Date.now()/1000),kind:g===1?'started':'resumed',session:id,generation:g,cliSessionId:cli})+'\\n');
fs.appendFileSync(path.join(e.MS_HOME,'observed.jsonl'),JSON.stringify({generation:g,binary:process.argv[1],config:e.CLAUDE_CONFIG_DIR,model:e.ANTHROPIC_MODEL,effort:e.CLAUDE_CODE_EFFORT_LEVEL,legacy:['ANU_ACCOUNT','ANU_PROVIDER','ANU_LAUNCH_NONCE','ANU_PANE'].some(k=>k in e),homi:e.HOMI_AGENT_NAME})+'\\n');
console.log('❯ ');process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on('data',b=>{if(b.toString().includes('/exit'))process.exit(0);});
`); chmodSync(path.join(selected, "claude"), 0o755);
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  const token = "sk-ant-oat01-envtest012345678901234567890";
  for (const name of ["first", "second"]) saveLaunchToken(name, token);
  writeFileSync(path.join(msHome, "accounts.json"), JSON.stringify({ version: 1, accounts: ["first", "second"].map(name => ({ name, provider: "claude", label: name, shared: false })) }));
  const now = Date.now();
  writeFileSync(path.join(msHome, "snapshot.json"), JSON.stringify({ takenAt: now, backoff: {}, accounts: ["first", "second"].map(name => ({ name, provider: "claude", shared: false,
    usage: { session: { usedPercent: 1, resetsAt: new Date(now + 3600000).toISOString() }, weeklyAll: { usedPercent: 1, resetsAt: new Date(now + 86400000).toISOString() }, weeklyFable: null },
    error: null, errorKind: null, stale: false, observedAt: now })) }));
  assert.equal(tmux(["new-session", "-d", "-s", "isolated", "-c", home, "sleep", "300"]).status, 0);
  const pane = tmux(["list-panes", "-t", "isolated", "-F", "#{pane_id}"]).stdout.trim();
  const caller = { ...env, PATH: callerPath, CLAUDE_CONFIG_DIR: path.join(home, "caller-config"), ANTHROPIC_MODEL: "sonnet", CLAUDE_CODE_EFFORT_LEVEL: "medium",
    TMUX: `${socket},1,0`, TMUX_PANE: pane, ANTHROPIC_API_KEY: "fake-secret-must-not-be-persisted" };
  assert.equal(run(["claude", "--as", "first"], caller).code, 0);
  const records = () => existsSync(path.join(msHome, "observed.jsonl")) ? readFileSync(path.join(msHome, "observed.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
  const wait = async (count: number) => { const end = Date.now() + 10000; while (records().length < count && Date.now() < end) await sleep(30); assert.equal(records().length, count, tmux(["capture-pane", "-p", "-t", pane]).stdout); };
  await wait(1);
  const { openState } = await import("../src/state.ts"); let st = openState(); const session = st.listSessions()[0]!; st.close();
  const switched = run(["switch", session.id, "--to", "second"], { ...env, TMUX: "", TMUX_PANE: "" });
  assert.equal(switched.code, 0, switched.stderr); await wait(2);
  for (const result of records()) assert.deepEqual(result, { generation: result.generation, binary: path.join(selected, "claude"), config: caller.CLAUDE_CONFIG_DIR, model: "sonnet", effort: "medium", legacy: false, homi: "keep-peer" });
  st = openState();
  try {
    assert.equal(st.getSession(session.id)?.generation, 2);
    assert.deepEqual(st.latestLaunch(session.id, 1)?.env, st.latestLaunch(session.id, 2)?.env);
    const saved = JSON.stringify(st.latestLaunch(session.id, 2)?.env);
    assert.ok(!saved.includes(token)); assert.ok(!saved.includes("fake-secret"));
  } finally { st.close(); }
});
