import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

const gone = () => {
  throw refuse("снесено");
};

export function make(_o: { home?: string } = {}): Module {
  return { requests: Object.fromEntries(["session.open", "session.update", "session.call", "session.spec", "session.stop", "session.start", "session.remove"].map((n) => [n, gone])), fields: { model: () => undefined, effort: () => undefined, parent: () => undefined, mode: () => undefined } };
}
