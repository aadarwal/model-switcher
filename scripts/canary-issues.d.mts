export type CanaryResult = { name: string; ok: boolean; detail: string };
export type CanaryReport = { tool: string; version: string | null; results: CanaryResult[]; notes?: string[] };
export declare const NAMES: { codex: string; claude: string };
export declare function markdown(report: CanaryReport): string;
export declare function issuesFor(reports: unknown, runUrl: string): { title: string; body: string }[];
