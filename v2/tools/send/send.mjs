#!/usr/bin/env node
// Сообщение в сессию от служб компьютера (тревоги, сторожа): один файл без зависимостей, нужен только Node.
//   echo "<пропуск>" | node send.mjs <адрес флота> <сессия> <текст…>
//   echo "<пропуск>" | node send.mjs <адрес флота> --incident <машина> <вид> <ключ> <текст…>
//   import { send } from "…/send.mjs"; await send("site@laptop", "текст", { key, url }) → { ok: 1, error: "" } | { ok: 0, error }
// Пропуск — первой строкой stdin (не аргументом: аргументы видны в списке процессов); из кода — полем key.
// Выход: 0 — принято; 1 — отказ флота (слово и причина в stderr); 2 — вызван неверно или флот не ответил.
const usage = "send.mjs <адрес флота> <сессия> <текст…> | send.mjs <адрес флота> --incident <машина> <вид> <ключ> <текст…>; пропуск — первой строкой stdin";
/** Адрес флота по умолчанию для вызова из кода: SWITCHBOARD_URL или прод. */
export const RELAY = process.env.SWITCHBOARD_URL || "https://relay.pfarm.app";

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

/** Один запрос POST <адрес>/call с пропуском. Итог — { reply } или { lost: причина }, если флот не ответил. */
async function post(base, key, frame, ms) {
  const id = "s" + Date.now().toString(36);
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/call", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ ...frame, id, trace: "t" + id }),
      signal: AbortSignal.timeout(ms),
    });
    return { reply: await res.json(), trace: "t" + id };
  } catch (e) {
    return { lost: String(e?.message ?? e), trace: "t" + id };
  }
}

const refused = (reply, trace) => `${reply?.error ?? "bad_frame"}${reply?.why ? ": " + reply.why : ""} (номер запроса ${reply?.trace ?? trace})`;

/** Сообщение сессии из кода службы. url — адрес флота; wss://… читается как https://… того же хоста. */
export async function send(to, text, { key, url = RELAY, timeoutMs = 30_000 } = {}) {
  const r = await post(String(url).replace(/^ws(s?):\/\//, "http$1://"), key, { type: "message", to, text }, timeoutMs);
  if (r.lost) return { ok: 0, error: "флот не ответил: " + r.lost };
  return r.reply?.ok ? { ok: 1, error: "" } : { ok: 0, error: refused(r.reply, r.trace) };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("send.mjs")) {
  const made = frameOf(process.argv.slice(2));
  if (!made) {
    console.error(usage);
    process.exit(2);
  }
  const key = await firstLine();
  if (!key) {
    console.error("нет пропуска в stdin");
    process.exit(2);
  }
  const r = await post(made.base, key, made.frame, 120_000);
  if (r.lost) {
    console.error("флот не ответил: " + r.lost);
    process.exit(2);
  }
  if (!r.reply?.ok) {
    console.error(refused(r.reply, r.trace));
    process.exit(1);
  }
  console.log(JSON.stringify(r.reply.result ?? {}));
}
