// Заглушка сноса: вход отвечает отказом словом.
import { refuse, type Module } from "@switchboard/host";

export function make(): Module {
  return {
    requests: {
      "machine.journal": () => {
        throw refuse("снесено", "host-journal снесён");
      },
    },
  };
}
