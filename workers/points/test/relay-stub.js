// Подставной relay для тестов: вход Radio записывает кадры участника, вход Log отдаёт их тесту.
import { WorkerEntrypoint } from "cloudflare:workers";

const frames = [];
let word;

export class Radio extends WorkerEntrypoint {
  async frame(f) {
    frames.push({ name: this.ctx.props?.name, frame: f });
    return word;
  }
}

export class Log extends WorkerEntrypoint {
  /** забрать записанные кадры */
  take() {
    return frames.splice(0);
  }
  /** чем relay ответит на следующие frame: undefined или слово отказа */
  answer(w) {
    word = w ?? undefined;
  }
}

export default { fetch: () => new Response("relay stub") };
