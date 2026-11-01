// Поддельный relay для тестов send: глобальный WebSocket подменяется до запуска send.mjs (node --import).
// Режим — FAKE_RELAY: ok | offline | refuse | silent. Отправленные кадры — строками JSON в файл FAKE_LOG.
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_RELAY ?? "ok";
const log = process.env.FAKE_LOG;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    if (log) appendFileSync(log, JSON.stringify({ url }) + "\n");
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(text) {
    if (log) appendFileSync(log, text + "\n");
    const f = JSON.parse(text);
    const say = (x) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(x) }), 0);
    if (f.type === "hello") {
      if (mode === "refuse") return setTimeout(() => this.onclose?.({ code: 1008, reason: "bad_key" }), 0);
      say({ type: "roster", machines: [], sessions: [], clients: [], workers: [] });
    } else if (f.type === "session.prompt") {
      if (mode === "ok") say({ type: "reply", id: f.id, ok: true });
      if (mode === "offline") say({ type: "reply", id: f.id, ok: false, error: "offline" });
    }
  }
  close(code) {
    if (log) appendFileSync(log, JSON.stringify({ close: code }) + "\n");
  }
}

globalThis.WebSocket = FakeWebSocket;
