// Сообщение в сессию от служб компьютера. Один файл без зависимостей; службы зовут его снаружи репо,
// поэтому аргументы, слова отказов, выходы 0, 1, 2 и кадры заморожены.
import { text as readAll } from "node:stream/consumers";

export const RELAY = "wss://relay.pfarm.app";
const LIMIT_MS = 30_000;
const USAGE = "вызов: <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]";

const parse = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return null; // pong и бинарные кадры — не наши
  }
};

/** Один разговор с relay машины сессии: hello, после roster один session.prompt. Итог — { ok: 1 | 0, error: слово }. */
export function send(callsign, text, { key, url = RELAY, timeoutMs = LIMIT_MS } = {}) {
  const machine = callsign.slice(callsign.indexOf("@") + 1);
  const ws = new WebSocket(`${url.replace(/\/$/, "")}/m/${machine}`);
  const id = crypto.randomUUID();
  let asked = false;
  return new Promise((resolve) => {
    const finish = (ok, error) => {
      clearTimeout(limit);
      ws.onclose = ws.onmessage = null;
      ws.close(1000);
      resolve({ ok, error });
    };
    const limit = setTimeout(() => finish(0, `нет ответа за ${timeoutMs} мс`), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", key, proto: 1 }));
    ws.onclose = ({ code, reason }) => finish(0, `связь закрыта: ${code} ${reason}`);
    ws.onmessage = ({ data }) => {
      const f = parse(data);
      if (f?.type === "roster" && !asked) {
        asked = true;
        ws.send(JSON.stringify({ type: "session.prompt", v: 1, id, to: callsign, callsign, text }));
      } else if (f?.type === "reply" && f.id === id) {
        finish(f.ok ? 1 : 0, f.ok ? "" : String(f.error));
      }
    };
  });
}

/** Выход только после записи слова: в трубе на Windows запись не мгновенна, а сокет ждать незачем. */
const leave = (stream, word, code) => stream.write(`${word}\n`, () => process.exit(code));

async function main([callsign, flag, url]) {
  if (!callsign || (flag !== undefined && (flag !== "--url" || !url))) return leave(process.stderr, USAGE, 2);
  const limit = setTimeout(() => leave(process.stdout, `stdin не закрыт за ${LIMIT_MS} мс`, 1), LIMIT_MS);
  const [first, ...rest] = (await readAll(process.stdin)).split("\n");
  clearTimeout(limit);
  const { ok, error } = await send(callsign, rest.join("\n"), { key: first.trim(), url });
  leave(process.stdout, ok ? "ok" : error, ok ? 0 : 1);
}

if (import.meta.main) await main(process.argv.slice(2));
