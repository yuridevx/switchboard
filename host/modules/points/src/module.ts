// Снесено: входы контракта отказывают словом, новое письмо — следующим коммитом.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

const gone = () => {
  throw refuse("снесено");
};

export const make = (): Module => ({ requests: { "points.save": gone, "points.raise": gone, "session.r2": gone } });
