// Поддельный участник рации для тестов relay: имя, контракт и uses — из своих bindings.
// Отвечает на *.ping через свою привязку RELAY; остальное только запоминает.
import { WorkerEntrypoint } from "cloudflare:workers";

const got = [];
let mode = "ok";

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
    if (f.id && f.type.endsWith(".ping")) {
      await this.env.RELAY.frame({ type: "reply", id: f.id, to: f.from, ok: true, result: { pong: this.env.NAME } });
    }
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
  }
  send(f) {
    return this.env.RELAY.frame(f);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
