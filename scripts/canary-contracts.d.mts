export type ContractResult = { name: string; ok: boolean; detail: string };
export type ExpectedHook = { eventName: string; key: string; timeout: number; hash: string };
export declare function codexHookList(bin: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<unknown>;
export declare function checkCodexHooks(inventory: unknown, expected: ExpectedHook[], command: string, configPath: string): ContractResult[];
