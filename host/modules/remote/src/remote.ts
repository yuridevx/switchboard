import type { Module } from "@switchboard/host";

export function make(_o: { claudeDir?: string } = {}): Module {
  return { fields: { remote: () => undefined } };
}
