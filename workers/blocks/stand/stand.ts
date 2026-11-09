// Стенд хранилища блоков для тестов соседей: Worker текстом для miniflare под именем службы, блоки — в памяти.
// put(hash, size, lines?) — блок «выгружен по ссылке»; searchable(false) — хранилище без поиска; got() — запросы, что пришли.

const script = `
import { WorkerEntrypoint } from "cloudflare:workers";

const blocks = new Map();
const got = [];
let search = true;
const ok = (id, result) => [{ type: "reply", id, ok: true, result }];
const fail = (id, error) => [{ type: "reply", id, ok: false, error }];
const link = (method, h) => "https://blocks.test/b/" + h + "?m=" + method;

export class Blocks extends WorkerEntrypoint {
  frame(f) {
    got.push(f);
    const hashes = f.hashes ?? [];
    if (f.type === "blocks.links") {
      if (f.method === "GET") return ok(f.id, { links: Object.fromEntries(hashes.map((h) => [h, link("GET", h)])) });
      const have = Object.fromEntries(hashes.filter((h) => blocks.has(h)).map((h) => [h, blocks.get(h).size]));
      return ok(f.id, { have, links: Object.fromEntries(hashes.filter((h) => !blocks.has(h)).map((h) => [h, link("PUT", h)])) });
    }
    if (f.type === "blocks.drop") {
      const gone = hashes.filter((h) => blocks.has(h));
      const bytes = gone.reduce((n, h) => n + blocks.get(h).size, 0);
      for (const h of gone) blocks.delete(h);
      return ok(f.id, { blocks: gone.length, bytes });
    }
    if (f.type === "blocks.search") {
      if (!search) return fail(f.id, "no_search");
      const q = String(f.q).toLowerCase();
      const out = [];
      for (const h of hashes) {
        const line = (blocks.get(h)?.lines ?? []).find((l) => l.toLowerCase().includes(q));
        if (line !== undefined) out.push({ hash: h, line });
      }
      return ok(f.id, out.slice(0, f.limit));
    }
    return fail(f.id, "unknown_request");
  }
  put(hash, size, lines = []) {
    blocks.set(hash, { size, lines });
  }
  has(hash) {
    return blocks.has(hash);
  }
  searchable(on) {
    search = on;
  }
  got() {
    return got;
  }
  clear() {
    blocks.clear();
    got.length = 0;
    search = true;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
`;

/** Имя службы и вход — как в контракте: switchboard-blocks, Blocks. */
export const blocksStand = () => ({ name: "switchboard-blocks", modules: true, compatibilityDate: "2026-08-01", script });

/** Что тест соседа зовёт у стенда по привязке STORE. */
export type BlocksStand = {
  put(hash: string, size: number, lines?: string[]): Promise<void>;
  has(hash: string): Promise<boolean>;
  searchable(on: boolean): Promise<void>;
  got(): Promise<Array<Record<string, unknown>>>;
  clear(): Promise<void>;
};
