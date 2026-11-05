// Снесено: модуль точек Host отвечает отказом словом «снесено» до реализации.
import { refuse, type Module } from "@switchboard/host";

const gone = () => {
  throw refuse("снесено");
};

export function make(): Module {
  return { requests: { "points.save": gone, "points.raise": gone, "session.r2": gone } };
}
