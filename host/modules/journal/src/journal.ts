// Снесено: вход контракта отказывает словом.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

export function make(): Module {
  return {
    requests: {
      "machine.journal"() {
        throw refuse("demolished", "снесено");
      },
    },
  };
}
