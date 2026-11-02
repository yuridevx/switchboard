// Поддельный участник рации для тестов relay: имя, контракт и uses — из своих bindings.
// Отвечает на *.ping кадрами в ответе frame; остальное запоминает и возвращает кадры, заданные тестом.
import { WorkerEntrypoint } from "cloudflare:workers";

const got = [];
let mode = "ok";
let ret = [];

export class Participant extends WorkerEntrypoint {
  hello() {
    if (mode === "hello_fail") throw new Error("hello сломан");
    const h = { contract: this.env.CONTRACT };
    if (this.env.USES) h.uses = this.env.USES;
    return h;
  }
  async frame(f) {
    got.push(f);
    if (mode === "frame_fail") throw new Error("frame сломан");
    if (f.id && f.type.endsWith(".ping")) return [{ type: "reply", id: f.id, to: f.from, ok: true, result: { pong: this.env.NAME } }];
    return ret;
  }
  setReturn(fs) {
    ret = fs;
  }
  // управление из теста
  setMode(m) {
    mode = m;
  }
  received() {
    return got;
  }
  clear() {
    got.length = 0;
    ret = [];
  }
  send(f) {
    return this.env.RELAY.frame(f);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
