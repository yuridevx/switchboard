#!/usr/bin/env node
// Снесено: вход контракта отвечает отказом словом, новая реализация — следующим коммитом.
export const RELAY = "снесено";

export async function send() {
  return { ok: 0, error: "снесено" };
}

if (process.argv[1]?.endsWith("send.mjs")) {
  console.log("снесено");
  process.exit(1);
}
