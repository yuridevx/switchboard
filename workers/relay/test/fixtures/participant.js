// Поддельный участник рации для тестов relay: имя, контракт и uses — из своих bindings.
// Отвечает на *.ping кадрами в ответе frame; остальное запоминает и возвращает кадры, заданные тестом.
import { WorkerEntrypoint } from "cloudflare:workers";

const got = [];
let mode = "ok";
let ret = [];
let contract = null;

export class Participant extends WorkerEntrypoint {
  hello() {
    if (mode === "hello_fail") throw new Error("hello сломан");
    if (mode === "hello_hang") return new Promise((r) => setTimeout(r, 10_000));
    const h = { contract: contract ?? this.env.CONTRACT };
    if (this.env.USES) h.uses = this.env.USES;
    return h;
  }
  async frame(f) {
    got.push(f);
    if (mode === "frame_fail") throw new Error("frame сломан");
    if (mode === "frame_hang") return new Promise((r) => setTimeout(() => r([]), 10_000));
    if (f.id && f.type.endsWith(".ping")) return [{ type: "reply", id: f.id, to: f.from, ok: true, result: { pong: this.env.NAME } }];
    return ret;
  }
  setContract(c) {
    contract = c;
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
    contract = null;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
