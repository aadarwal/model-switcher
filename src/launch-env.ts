/** Only nonsecret invocation settings cross the tmux-server boundary.
 * A missing variable is recorded as null so a server's stale value is removed;
 * an explicitly empty string remains empty. Credentials are read at _exec. */
export type LaunchEnvironment = Record<string, string | null>;

const SETTINGS = ["PATH", "CLAUDE_CONFIG_DIR", "ANTHROPIC_MODEL", "CLAUDE_CODE_EFFORT_LEVEL"] as const;

export function captureLaunchEnvironment(env: NodeJS.ProcessEnv = process.env): LaunchEnvironment {
  return Object.fromEntries(SETTINGS.map((key) => [key, env[key] ?? null]));
}

/** An empty legacy record preserves the server's inherited environment. */
export function withLaunchEnvironment(base: NodeJS.ProcessEnv, saved: LaunchEnvironment): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [key, value] of Object.entries(saved)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}
