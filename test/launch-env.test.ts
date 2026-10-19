import test from "node:test";
import assert from "node:assert/strict";
import { captureLaunchEnvironment, withLaunchEnvironment } from "../src/launch-env.ts";

test("launch capture contains only invocation settings, including empty and absent values", () => {
  const saved = captureLaunchEnvironment({ PATH: "/caller/bin", CLAUDE_CONFIG_DIR: "", CLAUDE_CODE_EFFORT_LEVEL: "medium",
    ANTHROPIC_API_KEY: "secret-key", CLAUDE_CODE_OAUTH_TOKEN: "secret-token", CODEX_HOME: "/credential/home",
    OPENAI_API_KEY: "another-secret", HOMI_AGENT_NAME: "peer", ANU_ACCOUNT: "owner" });
  assert.deepEqual(saved, { PATH: "/caller/bin", CLAUDE_CONFIG_DIR: "", ANTHROPIC_MODEL: null, CLAUDE_CODE_EFFORT_LEVEL: "medium" });
  assert.ok(!JSON.stringify(saved).includes("secret"));
  assert.deepEqual(withLaunchEnvironment({ ANTHROPIC_MODEL: "server-model", FOO: "legacy" }, saved),
    { PATH: "/caller/bin", CLAUDE_CONFIG_DIR: "", CLAUDE_CODE_EFFORT_LEVEL: "medium", FOO: "legacy" });
});

test("an old empty launch environment retains inherited behavior without mutating the parent", () => {
  const inherited = { PATH: "/server/bin", ANTHROPIC_MODEL: "old-default" };
  assert.deepEqual(withLaunchEnvironment(inherited, {}), inherited);
  withLaunchEnvironment(inherited, { PATH: null, ANTHROPIC_MODEL: "" });
  assert.deepEqual(inherited, { PATH: "/server/bin", ANTHROPIC_MODEL: "old-default" });
});
