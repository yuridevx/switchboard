// Леса blocks-ch: вход — кадр по привязке (entrypoint Blocks) и запрос по ссылке, исход — ответ и таблица поддельного ClickHouse.
// Номер — эталон-источник; без номера — чьё: код.
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blocksEtalon } from "@switchboard/blocks/stand/etalon.ts";
import type { Frame } from "@switchboard/protocol";

const { Blocks: blocks, default: worker } = exports as unknown as { Blocks: { frame(f: Frame): Promise<Frame[]> }; default: { fetch(r: Request): Promise<Response> } };
const one = async (f: Record<string, unknown>) => (await blocks.frame({ id: "x", v: 1, ...f } as Frame))[0] as Frame & { ok: boolean; result?: any; error?: string };
const H = "a".repeat(64);

beforeEach(async () => {
  await env.CH.fetch("http://clickhouse/", { method: "POST", headers: { "X-ClickHouse-User": "sb_test", "X-ClickHouse-Key": "pass0" }, body: "TRUNCATE TABLE blocks" });
});

describe("контракт blocks на ClickHouse", () => {
  blocksEtalon(() => ({
    call: (f) => blocks.frame(f),
    upload: async (url, body) => {
      const r = await worker.fetch(new Request(url, { method: "PUT", body, headers: { "content-length": String(body.length) } }));
      expect(r.status).toBe(200);
    },
    download: async (url) => new Uint8Array(await (await worker.fetch(new Request(url))).arrayBuffer()),
    search: true,
  }));

  it("ссылка ведёт в этот Worker на час; чужой метод, правка подписи и истёкший срок — отказ", async () => {
    const put = (await one({ type: "blocks.links", method: "PUT", hashes: [H] })).result.links[H] as string;
    const u = new URL(put);
    expect(`${u.origin}${u.pathname}`).toBe(`https://blocks.test/b/${H}`);
    expect(Number(u.searchParams.get("e")) - Date.now() / 1000).toBeGreaterThan(3590);
    expect((await worker.fetch(new Request(put))).status).toBe(404);
    const forged = put.replace(/s=./, (m) => (m === "s=A" ? "s=B" : "s=A"));
    expect((await worker.fetch(new Request(forged, { method: "PUT", body: "x", headers: { "content-length": "1" } }))).status).toBe(403);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3601_000);
    const late = await worker.fetch(new Request(put, { method: "PUT", body: "x", headers: { "content-length": "1" } }));
    vi.useRealTimers();
    expect(late.status).toBe(403);
  });

  it("блока нет — GET по ссылке 404", async () => {
    const get = (await one({ type: "blocks.links", method: "GET", hashes: [H] })).result.links[H] as string;
    expect((await worker.fetch(new Request(get))).status).toBe(404);
  });

});
