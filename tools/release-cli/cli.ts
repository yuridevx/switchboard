export type Fetch = (url: string, init: { method: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer> }>;
type Exec = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; out: string }>;
type Go = (args: string[], cwd: string, env: Record<string, string>) => Promise<{ code: number; out: string }>;
export async function main(_a: string[], _e: Record<string, string | undefined>, _x?: Exec, _g?: Go, _f?: Fetch): Promise<number> { throw new Error("снесено"); }
