#!/usr/bin/env node
// Сообщение в сессию флота от клиента — для служб компьютера, которым надо писать в сессию (тревоги, сторожа).
// Без зависимостей: WebSocket Node 24. Пропуск программы — keys.invite client <имя> <почта>, принят switchboard redeem;
// адрес отправителя — <имя>~<почта>. Соединение — с relay машины сессии: объект /m/<машина>.
//   import { send } from "…/send.mjs";  await send("operator@laptop", "текст", { key }) → { ok: 1, error: "" } | { ok: 0, error }
//   <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]
// Одна попытка: hello → roster → session.prompt → reply. Повторов нет, итог — вызывающему.
import { text as readAll } from "node:stream/consumers";
import { pathToFileURL } from "node:url";

export const RELAY = "wss://relay.pfarm.app";

const USAGE = "вызов: <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]";

const machineAddress = (url, callsign) => `${url.replace(/\/$/, "")}/m/${callsign.slice(callsign.indexOf("@") + 1)}`;

/** Кадр relay; всё, что не JSON-текст, — не кадр. */
function frameOf(data) {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function send(callsign, text, { key, url = RELAY, timeoutMs = 30_000 } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  const id = `send-${Date.now().toString(36)}`;
  const ws = new WebSocket(machineAddress(url, callsign));
  let asked = false;

  // сняв обработчики, итог не повторится: остаётся только таймер, он снят здесь же
  const finish = (result) => {
    clearTimeout(timer);
    ws.onmessage = ws.onclose = null;
    ws.close(1000);
    resolve(result);
  };
  const timer = setTimeout(() => finish({ ok: 0, error: `нет ответа за ${timeoutMs} мс` }), timeoutMs);

  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", key, proto: 1 }));
  ws.onclose = ({ code, reason }) => finish({ ok: 0, error: `связь закрыта: ${code} ${reason}` });
  ws.onmessage = ({ data }) => {
    const frame = frameOf(data);
    // roster — hello принят
    if (frame?.type === "roster" && !asked) {
      asked = true;
      ws.send(JSON.stringify({ type: "session.prompt", v: 1, id, to: callsign, callsign, text }));
    } else if (frame?.type === "reply" && frame.id === id) {
      finish(frame.ok ? { ok: 1, error: "" } : { ok: 0, error: String(frame.error) });
    }
  };
  return promise;
}

/** Первая строка stdin — пропуск, остальное — текст как есть. */
function parseInput(raw) {
  const lineEnd = raw.indexOf("\n");
  return lineEnd < 0 ? { key: raw.trim(), text: "" } : { key: raw.slice(0, lineEnd).trim(), text: raw.slice(lineEnd + 1) };
}

async function main([callsign, flag, url]) {
  if (!callsign || (flag && (flag !== "--url" || !url))) {
    console.error(USAGE);
    return 2;
  }
  const { key, text } = parseInput(await readAll(process.stdin));
  const { ok, error } = await send(callsign, text, { key, ...(url ? { url } : {}) });
  console.log(ok ? "ok" : error);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));
