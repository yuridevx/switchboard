// Снесено: вход контракта отказывает словом до новой реализации.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

const gone = () => {
  throw refuse("demolished", "снесено");
};

export default { requests: Object.fromEntries(["session.prompt","session.history","session.files"].map((n) => [n, gone])), start() {}, stop() {} } as Module;
