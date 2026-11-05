// Поддельный relay для тестов send: глобальный WebSocket подменяется до запуска send.mjs (node --import).
// Режим — FAKE_RELAY: ok | offline | wordless | refuse | drop | noise | silent | mute | deaf. Что ушло к relay — строками JSON в файл FAKE_LOG.
// silent — запрос принят, ответа нет; mute — после hello нет roster; deaf — соединение не открывается.
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_RELAY ?? "ok";
const log = process.env.FAKE_LOG;
const note = (line) => {
  if (log) appendFileSync(log, line + "\n");
};
const ROSTER = JSON.stringify({ type: "roster", machines: [], sessions: [], clients: [], workers: [] });

class FakeWebSocket {
  #open = false;
  constructor(url) {
    note(JSON.stringify({ url }));
    if (mode === "deaf") return;
    setTimeout(() => {
      this.#open = true;
      this.onopen?.({});
    }, 0);
  }
  /** Сначала порядок кадров, как их шлёт настоящий relay: по одному за оборот. */
  #say(...frames) {
    frames.forEach((data, i) => setTimeout(() => this.onmessage?.({ data }), i));
  }
  #lost(code, reason) {
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
  send(text) {
    // Как настоящий сокет: до открытия слать нельзя.
    if (!this.#open) throw new Error("InvalidStateError: сокет ещё не открыт");
    note(text);
    const f = JSON.parse(text);
    const reply = (x) => JSON.stringify({ type: "reply", id: f.id, ...x });
    if (f.type === "hello") {
      if (mode === "refuse") return this.#lost(1008, "bad_key");
      if (mode === "mute") return;
      if (mode === "noise") return this.#say("pong", new ArrayBuffer(1), "{не JSON", ROSTER, ROSTER);
      this.#say(ROSTER);
    } else if (f.type === "session.prompt") {
      if (mode === "drop") return this.#lost(1006, "");
      if (mode === "noise") return this.#say(JSON.stringify({ type: "reply", id: "чужой", ok: false, error: "чужой ответ" }), reply({ ok: true }));
      if (mode === "ok") this.#say(reply({ ok: true }));
      if (mode === "offline") this.#say(reply({ ok: false, error: "offline" }));
      if (mode === "wordless") this.#say(reply({ ok: false }));
    }
  }
  /** Как настоящий сокет: после close приходит событие закрытия. */
  close(code) {
    note(JSON.stringify({ close: code }));
    this.#lost(code, "");
  }
}

globalThis.WebSocket = FakeWebSocket;

// FAKE_FAST: сроки процесса идут в сто раз быстрее, слова о сроке те же
if (process.env.FAKE_FAST) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...rest) => real(f, ms / 100, ...rest);
}
