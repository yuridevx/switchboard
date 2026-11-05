// Заглушка сноса: вход отвечает отказом словом.
import { refuse, type Module } from "@switchboard/host";

export function make(): Module {
  return {
    requests: {
      "incident.pending": () => {
        throw refuse("снесено", "host-incidents снесён");
      },
    },
  };
}
