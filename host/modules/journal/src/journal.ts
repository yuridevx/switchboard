// Снесено: вход отвечает отказом словом.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

export const make = (): Module => ({
  requests: {
    "machine.journal"() {
      throw refuse("снесено", "machine.journal снесён");
    },
  },
});
