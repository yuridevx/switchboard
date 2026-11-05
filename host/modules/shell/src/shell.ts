import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

type Tool = { name: string; handler: (args: never, extra: { signal?: AbortSignal }) => Promise<unknown> };

const gone = () => {
  throw refuse("снесено");
};

export function make(): { module: Module; tools: (me: string) => Tool[] } {
  return { module: { requests: { "shell.run": gone, "shell.wait": gone, "shell.kill": gone, "shell.info": gone } }, tools: () => [] };
}
