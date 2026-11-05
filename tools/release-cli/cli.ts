#!/usr/bin/env node
// Снесено: CLI выпуска пишется заново.
export type Fetch = (url: string, init: { method: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Done = { code: number | null; out: string };
export async function main(_argv: string[], _env: Record<string, string | undefined>, _exec?: (cmd: string, args: string[], cwd: string) => Promise<Done>, _go?: (args: string[], cwd: string, env: Record<string, string>) => Promise<Done>, _fetch?: Fetch): Promise<number> {
  throw new Error("снесено");
}
