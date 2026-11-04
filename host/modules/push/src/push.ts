// Снесено: notify отвечает отказом словом, пока не написан заново.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

export function make(): Module {
  return {
    requests: {
      notify() {
        throw refuse("demolished", "снесено");
      },
    },
    start() {},
    stop() {},
  };
}
