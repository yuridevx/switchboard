import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";
export const make = (): { module: Module; tools: (me: string) => any[] } => ({ tools: () => [], module: { requests: { "shell.run": () => { throw refuse("снесено"); }, "shell.wait": () => { throw refuse("снесено"); }, "shell.kill": () => { throw refuse("снесено"); }, "shell.info": () => { throw refuse("снесено"); } } } });
