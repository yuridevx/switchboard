import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

export function make(_o: { home?: string } = {}): Module {
  return {
    requests: {
      "machine.dirs": () => {
        throw refuse("снесено");
      },
    },
  };
}
