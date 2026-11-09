// Леса blocks-r2: вход — кадр по привязке (entrypoint Blocks), исход — ответ и объекты бакета. Номер — эталон-источник; без номера — чьё: код.
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blocksEtalon } from "@switchboard/blocks/stand/etalon.ts";
import type { Frame } from "@switchboard/protocol";
import { presign } from "@switchboard/release";

const blocks = (exports as unknown as { Blocks: { frame(f: Frame): Promise<Frame[]> } }).Blocks;
const keyOf = (url: string) => new URL(url).pathname.split("/").slice(2).join("/");

beforeEach(async () => {
  const listed = await env.BUCKET.list();
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
});

describe("контракт blocks на R2", () => {
  blocksEtalon(() => ({
    call: (f) => blocks.frame(f),
    // ссылка подписана в R2: в тесте тело кладётся в бакет по ключу ссылки
    upload: async (url, body) => void (await env.BUCKET.put(keyOf(url), body)),
    download: async (url) => new Uint8Array(await (await env.BUCKET.get(keyOf(url)))!.arrayBuffer()),
    search: false,
  }));

  it("ссылка — подпись S3 на час в бакет точек, ключ f/<отпечаток>", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const h = "a".repeat(64);
    const [r] = await blocks.frame({ type: "blocks.links", id: "x", v: 1, method: "GET", hashes: [h] });
    const want = await presign({ accessKeyId: "kid0", secretAccessKey: "ksec0" }, { method: "GET", host: "acc0.r2.cloudflarestorage.com", path: `/switchboard-points/f/${h}`, now: new Date() });
    vi.useRealTimers();
    expect((r.result as { links: Record<string, string> }).links[h]).toBe(want);
  });
});
