#!/usr/bin/env node
// Снесено: CLI выпуска пишется заново.
export type Fetch = (url: string, init: { method: string; body: string | Uint8Array; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type Exec = (cmd: "npm" | "node", args: string[], cwd: string) => Promise<{ code: number | null; out: string }>;
export type GoExec = (args: string[], cwd: string, env: Record<string, string>) => Promise<{ code: number | null; out: string }>;
export async function main(_argv: string[], _env: Record<string, string | undefined>, _x?: Exec, _go?: GoExec, _f?: Fetch): Promise<number> {
  throw new Error("снесено");
}
