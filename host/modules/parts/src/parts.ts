import type { Module } from "@switchboard/host";
export function make() { const module: Module = {}; return { module, tools: (_cwd: string) => [] as Array<{ name: string; description: string; handler(a: never, e: never): Promise<unknown> }> }; }
