/** Types for scripts/codex-wall-mock.mjs — the local stand-in for the ChatGPT
 *  backend that makes a real `codex` hit a real usage wall on demand. */

export declare const HOST: "127.0.0.1";
export declare const DEFAULT_RESETS_IN: number;

/** The 429 body `api_bridge.rs` turns into `CodexErr::UsageLimitReached`. */
export declare function quotaBody(opts?: { resetsAt?: number | null; planType?: string | null }): {
  error: { type: string; message: string; plan_type?: string; resets_at?: number };
};

/** A 429 that is deliberately NOT a wall (`CodexErr::RetryLimit`). */
export declare function genericBody(): { error: { type: string; message: string } };

export type MockWindow = {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
};

/** A healthy Pro-shaped `/wham/usage` body: one 168 h window at 40 %. */
export declare function healthyUsageBody(nowSeconds?: number): {
  plan_type: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: MockWindow | null;
    secondary_window: MockWindow | null;
  };
  additional_rate_limits: null;
  rate_limit_reset_credits: null;
  rate_limit_upsell: null;
  account_id: string;
  user_id: string;
};

/** The smallest SSE stream that reads as a completed turn. */
export declare function successTurnStream(n?: number, text?: string): string;

export declare function formatLog(method: string, path: string, status: number): string;
export declare function isUpgradeRequest(headers: Record<string, unknown> | undefined): boolean;
export declare function isResponsesPath(pathname: string): boolean;
export declare function isUsagePath(pathname: string): boolean;

export type MockOptions = {
  port?: number;
  resetsIn?: number | null;
  usage?: unknown;
  allowTurns?: number;
  generic429?: boolean;
  log?: (line: string) => void;
  now?: () => number;
};

export type MockStats = {
  turnsServed: number;
  wallsServed: number;
  upgradesRefused: number;
  usagePolls: number;
  notFound: number;
};

export type MockHandle = {
  port: number;
  url: string;
  stats: MockStats;
  /** Exactly the values a scratch account's `config.toml` needs. */
  baseUrls: { provider: string; openai: string; chatgpt: string };
  close: () => Promise<void>;
};

export declare function startMock(options?: MockOptions): Promise<MockHandle>;

export declare function parseMockArgs(argv: string[]): {
  port: number;
  resetsIn: number;
  allowTurns: number;
  generic429: boolean;
  usage: unknown;
};
