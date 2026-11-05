import type { Module } from "@switchboard/host";
export const make = (): { module: Module; tools: (me: string) => any[] } => ({ tools: () => [], module: {} });
