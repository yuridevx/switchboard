#!/usr/bin/env node
// Сообщение в сессию флота от служб компьютера: hello → roster → session.prompt → reply. Один файл без зависимостей, Node 24: копируется на машину как есть.
// Службы зовут его снаружи репо, поэтому аргументы, слова отказов, выходы и кадры заморожены.
// Пропуск программы — keys.invite client <имя> <почта>, принят switchboard redeem; отправитель — <имя>~<почта>.
//   <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]
// Выход: 0 — ok; 1 — отказ словом в stdout; 2 — неверный вызов, строка вызова в stderr.
// Импорт: await send(callsign, text, { key, url, timeoutMs }) → { ok: 1 | 0, error }.
import { existsSync, realpathSync } from "node:fs";
import { text as read } from "node:stream/consumers";

export const RELAY = "wss://relay.pfarm.app";
const LIMIT_MS = 30_000;

/** Чужие кадры (pong, бинарный, не JSON) — пустой кадр. */
function parsed(data) {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/** Один разговор, один предел, один итог. */
export function send(callsign, text, { key, url, timeoutMs = LIMIT_MS } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${(url || RELAY).replace(/\/$/, "")}/m/${callsign.split("@").pop()}`);
    let id; // есть — запрос ушёл; уникален: клиент флота ключует ожидание по id и отправителю
    const finish = (ok, error) => {
      clearTimeout(limit);
      ws.onclose = ws.onmessage = null;
      ws.close(1000);
      resolve({ ok, error });
    };
    const limit = setTimeout(() => finish(0, `нет ответа за ${timeoutMs} мс`), timeoutMs);
    ws.onclose = ({ code, reason }) => finish(0, `связь закрыта: ${code} ${reason}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", key, proto: 1 }));
    ws.onmessage = ({ data }) => {
      const f = parsed(data);
      if (f.type === "roster" && !id) {
        id = crypto.randomUUID();
        ws.send(JSON.stringify({ type: "session.prompt", v: 1, id, to: callsign, callsign, text }));
      } else if (f.type === "reply" && f.id === id) finish(Number(f.ok), f.error ?? "");
    };
  });
}

/** Выход после записи: на Windows запись в канал асинхронна, а незакрытый stdin сам процесс не отпустит. */
const end = (word, code) => process.stdout.write(`${word}\n`, () => process.exit(code));

async function main() {
  const [callsign, flag, url] = process.argv.slice(2);
  if (!callsign || (flag && (flag !== "--url" || !url))) {
    console.error("вызов: <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]");
    process.exitCode = 2;
    return;
  }
  const limit = setTimeout(() => end(`stdin не закрыт за ${LIMIT_MS} мс`, 1), LIMIT_MS);
  const input = await read(process.stdin);
  clearTimeout(limit);
  const [, line, text] = input.match(/^([^\n]*)\n?(.*)$/s);
  const { ok, error } = await send(callsign, text, { key: line.trim(), url });
  end(ok ? "ok" : error, ok ? 0 : 1);
}

// Не import.meta.main: на Node 24.1 это выход 0 без отправки. Запуск через ссылку: argv[1] — путь ссылки. При импорте из -e argv[1] — не файл.
if (existsSync(process.argv[1]) && realpathSync(process.argv[1]) === import.meta.filename) main();
