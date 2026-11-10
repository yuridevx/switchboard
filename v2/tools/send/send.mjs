#!/usr/bin/env node
// Сообщение в сессию от служб компьютера (тревоги, сторожа): один файл без зависимостей, нужен только Node.
//   echo "<пропуск>" | node send.mjs <адрес флота> <сессия> <текст…>
//   echo "<пропуск>" | node send.mjs <адрес флота> --incident <машина> <вид> <ключ> <текст…>
// Пропуск — первой строкой stdin (не аргументом: аргументы видны в списке процессов).
// Выход: 0 — принято; 1 — отказ флота (слово и причина в stderr); 2 — вызван неверно или флот не ответил.
const args = process.argv.slice(2);
const usage = "send.mjs <адрес флота> <сессия> <текст…> | send.mjs <адрес флота> --incident <машина> <вид> <ключ> <текст…>; пропуск — первой строкой stdin";

async function firstLine() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes("\n")) break;
  }
  return text.split("\n")[0].trim();
}

export function frameOf(a) {
  const [base, ...rest] = a;
  if (!base || !/^https?:\/\//.test(base)) return null;
  if (rest[0] === "--incident") {
    const [, machine, kind, key, ...words] = rest;
    if (!machine || !kind || !key || !words.length) return null;
    return { base, frame: { type: "incident.raise", to: "@" + machine.replace(/^@/, ""), kind, key, text: words.join(" ") } };
  }
  const [to, ...words] = rest;
  if (!to || !to.includes("@") || !words.length) return null;
  return { base, frame: { type: "message", to, text: words.join(" ") } };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("send.mjs")) {
  const made = frameOf(args);
  if (!made) {
    console.error(usage);
    process.exit(2);
  }
  const key = await firstLine();
  if (!key) {
    console.error("нет пропуска в stdin");
    process.exit(2);
  }
  const id = "s" + Date.now().toString(36);
  let reply;
  try {
    const res = await fetch(made.base.replace(/\/+$/, "") + "/call", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ ...made.frame, id, trace: "t" + id }),
      signal: AbortSignal.timeout(120_000),
    });
    reply = await res.json();
  } catch (e) {
    console.error("флот не ответил: " + (e?.message ?? e));
    process.exit(2);
  }
  if (!reply?.ok) {
    console.error(`${reply?.error ?? "bad_frame"}${reply?.why ? ": " + reply.why : ""} (номер запроса ${reply?.trace ?? "t" + id})`);
    process.exit(1);
  }
  console.log(JSON.stringify(reply.result ?? {}));
}
