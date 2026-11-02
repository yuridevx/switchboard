#!/usr/bin/env node
// Сообщение в сессию флота от клиента — для служб компьютера, которым надо писать в сессию (тревоги, сторожа).
// Без зависимостей: WebSocket Node 24. Пропуск программы — keys.invite client <имя> <почта>, принят switchboard redeem;
// адрес отправителя — <имя>~<почта>. Соединение — с relay машины сессии: объект /m/<машина>.
//   import { send } from "…/send.mjs";  await send("operator@laptop", "текст", { key }) → { ok: 1, error: "" } | { ok: 0, error }
//   <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]
// Одна попытка: hello → roster → session.prompt → reply. Повторов нет, итог — вызывающему.
import { pathToFileURL } from "node:url";

export const RELAY = "wss://relay.pfarm.app";

export function send(callsign, text, { key, url = RELAY, timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const id = `send-${Date.now().toString(36)}`;
    let asked = false;
    let over = false;
    const ws = new WebSocket(`${url.replace(/\/$/, "")}/m/${callsign.slice(callsign.indexOf("@") + 1)}`);
    const end = (r) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {
        // сокет уже закрыт
      }
      done(r);
    };
    const timer = setTimeout(() => end({ ok: 0, error: `нет ответа за ${timeoutMs} мс` }), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", key, proto: 1 }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let f;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      // roster — hello принят
      if (f.type === "roster" && !asked) {
        asked = true;
        ws.send(JSON.stringify({ type: "session.prompt", v: 1, id, to: callsign, callsign, text }));
      } else if (f.type === "reply" && f.id === id) end(f.ok ? { ok: 1, error: "" } : { ok: 0, error: String(f.error) });
    };
    ws.onclose = (ev) => end({ ok: 0, error: `связь закрыта: ${ev.code} ${ev.reason}` });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [callsign, flag, url] = process.argv.slice(2);
  if (!callsign || (flag && (flag !== "--url" || !url))) {
    console.error("вызов: <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]");
    process.exit(2);
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const i = raw.indexOf("\n");
  const r = await send(callsign, i < 0 ? "" : raw.slice(i + 1), { key: (i < 0 ? raw : raw.slice(0, i)).trim(), ...(url ? { url } : {}) });
  console.log(r.ok ? "ok" : r.error);
  process.exit(r.ok ? 0 : 1);
}
