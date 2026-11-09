// Эталон 36 «Хранилище — модуль» (слово пользователя): одни и те же запросы контракта blocks дают один исход у каждой реализации.
// Реализация зовёт blocksEtalon из своего теста со своим входом: кадр по привязке, выгрузка и чтение по ссылке. Отличие одно — поиск.
import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import type { Frame } from "@switchboard/protocol";

export type Harness = {
  /** кадр в реализацию, как его шлёт points по привязке */
  call(f: Frame): Promise<Frame[]>;
  /** PUT тела по ссылке, как Host */
  upload(url: string, body: Uint8Array): Promise<void>;
  /** GET по ссылке, как подъём */
  download(url: string): Promise<Uint8Array>;
  /** умеет ли хранилище искать */
  search: boolean;
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const block = (text: string) => {
  const raw = new TextEncoder().encode(text);
  return { hash: sha(raw), raw, packed: new Uint8Array(zstdCompressSync(raw)) };
};
const one = async (h: Harness, f: Record<string, unknown>) => {
  const [r] = await h.call({ id: "b1", v: 1, ...f } as Frame);
  return r as Frame & { ok: boolean; result?: any; error?: string };
};
const links = (h: Harness, method: "PUT" | "GET", hashes: string[]) => one(h, { type: "blocks.links", method, hashes });

export function blocksEtalon(harness: () => Harness) {
  it("36 · выгрузка по ссылке: второй links PUT видит блок в have, ссылка — только на новый", async () => {
    const h = harness();
    const a = block('{"type":"user","n":1}\n');
    const b = block('{"type":"user","n":2}\n');
    const first = await links(h, "PUT", [a.hash, b.hash]);
    expect(first.ok).toBe(true);
    expect(first.result.have).toEqual({});
    expect(Object.keys(first.result.links).sort()).toEqual([a.hash, b.hash].sort());
    await h.upload(first.result.links[a.hash], a.packed);
    const second = await links(h, "PUT", [a.hash, b.hash]);
    expect(Object.keys(second.result.have)).toEqual([a.hash]);
    expect(second.result.have[a.hash]).toBeGreaterThan(0);
    expect(Object.keys(second.result.links)).toEqual([b.hash]);
  });

  it("36 · чтение по ссылке GET: тело zstd, SHA-256 содержимого — имя блока", async () => {
    const h = harness();
    const a = block('{"type":"assistant","text":"Готово"}\n'.repeat(50));
    const put = await links(h, "PUT", [a.hash]);
    await h.upload(put.result.links[a.hash], a.packed);
    const get = await links(h, "GET", [a.hash]);
    const body = await h.download(get.result.links[a.hash]);
    expect(sha(zstdDecompressSync(body))).toBe(a.hash);
  });

  it("36 · drop одним запросом: убранный блок снова просит выгрузку, неизвестный не считается", async () => {
    const h = harness();
    const a = block('{"drop":1}\n');
    const put = await links(h, "PUT", [a.hash]);
    await h.upload(put.result.links[a.hash], a.packed);
    const ghost = block("ghost\n").hash;
    const drop = await one(h, { type: "blocks.drop", hashes: [a.hash, ghost] });
    expect(drop.result.blocks).toBe(1);
    expect(drop.result.bytes).toBeGreaterThan(0);
    expect(Object.keys((await links(h, "PUT", [a.hash])).result.links)).toEqual([a.hash]);
  });

  it("36 · поиск: строка с q без учёта регистра в названных блоках; хранилище без поиска — no_search", async () => {
    const h = harness();
    const a = block('{"text":"перенеси Миграцию D1"}\n{"text":"другое"}\n');
    const b = block('{"text":"миграция тоже тут"}\n');
    for (const x of [a, b]) {
      const put = await links(h, "PUT", [x.hash]);
      await h.upload(put.result.links[x.hash], x.packed);
    }
    const r = await one(h, { type: "blocks.search", q: "миграцию d1", hashes: [a.hash, b.hash], limit: 50 });
    if (!h.search) return void expect(r.error).toBe("no_search");
    expect(r.result).toEqual([{ hash: a.hash, line: '{"text":"перенеси Миграцию D1"}' }]);
    const named = await one(h, { type: "blocks.search", q: "миграц", hashes: [b.hash], limit: 50 });
    expect(named.result.map((x: { hash: string }) => x.hash)).toEqual([b.hash]);
  });

  it("36 · отпечаток не hex SHA-256 — bad_frame", async () => {
    const r = await links(harness(), "PUT", ["../x"]);
    expect(r.error).toBe("bad_frame");
  });
}
