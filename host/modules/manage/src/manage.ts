import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";
export const make = (_o: { home?: string } = {}): Module => ({ requests: { "session.open": () => { throw refuse("снесено"); }, "session.update": () => { throw refuse("снесено"); }, "session.call": () => { throw refuse("снесено"); }, "session.spec": () => { throw refuse("снесено"); }, "session.stop": () => { throw refuse("снесено"); }, "session.start": () => { throw refuse("снесено"); }, "session.remove": () => { throw refuse("снесено"); } } });
