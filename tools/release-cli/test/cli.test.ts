// CLI выпуска: аргументы, сборка без загрузки и загрузка через releases.upload на поддельных «Выпусках» и R2.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { pack, parseSha, sha256hex } from "@switchboard/release";
import { coreFiles } from "../src/build.ts";
import type { GoExec } from "../src/keeper.ts";
import { asker, main, parseArgs } from "../cli.ts";
import type { Fetch } from "../cli.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ENV = { SWITCHBOARD_RELEASES: "https://releases.test", SWITCHBOARD_PASS: "client.ci.k1.s3cret" };

const go: GoExec = async (args, _cwd, env) => {
  const out = args[args.indexOf("-o") + 1];
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, `keeper ${env.GOOS}`);
  return { code: 0, out: "" };
};

/** «Выпуски» и R2: POST releases.upload отвечает по тому, что уже лежит; PUT кладёт в объекты. */
function fakeFleet() {
  const objects = new Map<string, Buffer>();
  const posts: Array<Record<string, unknown>> = [];
  const f: Fetch = async (url, init) => {
    if (init.method === "POST") {
      const fr = JSON.parse(String(init.body)) as Record<string, string>;
      posts.push(fr);
      if (fr.type === "releases.fetch" && !objects.has(`${fr.part}/${fr.version}.tgz`)) return { ok: true, status: 200, json: async () => ({ type: "reply", id: fr.id, ok: false, error: "no_release" }) };
      if (fr.type === "releases.fetch") return { ok: true, status: 200, json: async () => ({ type: "reply", id: fr.id, ok: true, result: { version: fr.version, url: `https://r2.test/b/${fr.part}/${fr.version}.tgz` } }) };
      const had = objects.get(`${fr.part}/${fr.version}.sha256`);
      const reply = had
        ? parseSha(had.toString("utf8")) === fr.sha256
          ? { type: "reply", id: fr.id, ok: true, result: { same: true } }
          : { type: "reply", id: fr.id, ok: false, error: "version_exists" }
        : { type: "reply", id: fr.id, ok: true, result: { tgz: `https://r2.test/b/${fr.part}/${fr.version}.tgz`, sha256: `https://r2.test/b/${fr.part}/${fr.version}.sha256` } };
      return { ok: true, status: 200, json: async () => reply };
    }
    const key = new URL(url).pathname.slice("/b/".length);
    if (init.method !== "PUT") {
      const o = objects.get(key);
      return { ok: !!o, status: o ? 200 : 404, json: async () => ({}), arrayBuffer: async () => new Uint8Array(o ?? []).buffer } as never;
    }
    objects.set(key, Buffer.from(init.body as Uint8Array));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { f, objects, posts };
}

const quiet = () => {
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void out.push(String(s)));
  return { out, done: () => log.mockRestore() };
};

describe("CLI выпуска", () => {
  it("2077 · аргументы: core, keeper и modules без номера; --out, --dry-run; незнакомый — отказ; адрес и пропуск — только из окружения", () => {
    expect(parseArgs(["release", "core", "--dry-run"])).toMatchObject({ part: "core", dryRun: true });
    expect(parseArgs(["release", "keeper"])).toMatchObject({ part: "keeper", dryRun: false });
    expect(parseArgs(["release", "modules"])).toMatchObject({ part: "modules" });
    expect(() => parseArgs(["release", "host", "1.4.1"])).toThrow("вызов");
    expect(() => parseArgs(["release", "1.4.1"])).toThrow("вызов");
    expect(() => parseArgs(["release", "core", "--to", "x"])).toThrow("незнакомый аргумент: --to");
    expect(() => asker({})).toThrow("SWITCHBOARD_RELEASES");
    expect(() => asker({ SWITCHBOARD_RELEASES: "https://x" })).toThrow("SWITCHBOARD_PASS");
  });

  it("3179 · сборка без загрузки (--dry-run) — архив собран, «Выпуски» не спрошены, выход 0", async () => {
    // источник: чьё: код (cli.ts — «--dry-run: только собрать, никуда не загружать»)
    const q = quiet();
    const fl = fakeFleet();
    try {
      expect(await main(["release", "keeper", "--dry-run"], {}, undefined, go, fl.f)).toBe(0);
    } finally {
      q.done();
    }
    expect(q.out.some((l) => l.startsWith("собран keeper "))).toBe(true);
    expect(q.out).toContain("--dry-run: никуда не загружено");
    expect(fl.posts).toEqual([]);
  });

  it("3180 · 5142 · keeper: releases.upload пропуском программы с хэшем, архив и .sha256 по ссылкам; тот же номер второй раз — пропуск", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): CI грузит запросом POST releases.upload пропуском программы ci
    const q = quiet();
    const fl = fakeFleet();
    try {
      expect(await main(["release", "keeper"], ENV, undefined, go, fl.f)).toBe(0);
      expect(await main(["release", "keeper"], ENV, undefined, go, fl.f)).toBe(0);
    } finally {
      q.done();
    }
    const v = JSON.parse(readFileSync(join(root, "os", "keeper", "module.json"), "utf8")).version;
    const tgz = fl.objects.get(`keeper/${v}.tgz`)!;
    expect(parseSha(fl.objects.get(`keeper/${v}.sha256`)!.toString("utf8"))).toBe(sha256hex(tgz));
    expect(fl.posts[0]).toMatchObject({ type: "releases.upload", v: 1, part: "keeper", version: v, sha256: sha256hex(tgz), key: ENV.SWITCHBOARD_PASS });
    expect(q.out.some((l) => l.includes(`keeper ${v} уже загружен с тем же хэшем — пропуск`))).toBe(true);
  });

  it("5143 · modules: каждый модуль каталога — своим запросом; отказ одного — выход 1 с его именем, остальные загружены", async () => {
    // источник: чьё: код (cli.ts — остальные модули загружаются и после отказа одного)
    const q = quiet();
    const err: string[] = [];
    const e = vi.spyOn(console, "error").mockImplementation((s: unknown) => void err.push(String(s)));
    const fl = fakeFleet();
    // под нынешним номером protocol лежит другое содержимое
    const pv = (JSON.parse(readFileSync(join(root, "protocol", "module.json"), "utf8")) as { version: string }).version;
    fl.objects.set(`protocol/${pv}.sha256`, Buffer.from(`${"0".repeat(64)}  ${pv}.tgz
`));
    fl.objects.set(`protocol/${pv}.tgz`, pack([{ path: "module.json", data: Buffer.from("{}") }]));
    try {
      const code = await main(["release", "modules"], ENV, undefined, go, fl.f);
      expect(code).toBe(1);
    } finally {
      q.done();
      e.mockRestore();
    }
    expect(err).toEqual([expect.stringMatching(/^protocol \d+\.\d+\.\d+: releases\.upload: version_exists/)]);
    expect(fl.posts.map((p) => p.part)).not.toContain("host");
    expect(fl.posts.map((p) => p.part)).not.toContain("keeper");
    expect([...fl.objects.keys()].some((k) => /^push\/[\d.]+\.tgz$/.test(k))).toBe(true);
    expect(q.out.at(-1)).toMatch(/^каталог: загружено \d+, уже были 0, собрано без загрузки 0, отказов 1$/);
  });

  it("5196 · check: код как в каталоге — выход 0; содержимое под тем же номером другое — выход 1 и «подними номер» с файлом; новый номер — не отказ; ничего не загружает", async () => {
    // источник: слово пользователя 3 нояб. («да» на правку 10): два прогона CI упали только из-за номера, узнавать это до push
    const q = quiet();
    const err: string[] = [];
    const e = vi.spyOn(console, "error").mockImplementation((s: unknown) => void err.push(String(s)));
    const fl = fakeFleet();
    try {
      expect(await main(["release", "modules"], ENV, undefined, go, fl.f)).toBe(0);
      const version = (JSON.parse(readFileSync(join(root, "host", "core", "module.json"), "utf8")) as { version: string }).version;
      // ядро в каталоге — те же файлы и чужой lockfile: его пишет npm, он не сравнивается
      fl.objects.set(`host/${version}.tgz`, pack([...coreFiles(root, version), { path: "package-lock.json", data: Buffer.from("{}") }]));
      const puts = fl.objects.size;
      expect(await main(["release", "check"], ENV, undefined, go, fl.f)).toBe(0);
      expect(q.out.at(-1)).toMatch(/^каталог: как в коде \d+, новых номеров 0, поднять 0$/);
      expect(fl.objects.size).toBe(puts);
      expect(fl.posts.filter((p) => p.type === "releases.upload" && fl.posts.indexOf(p) > 0).length).toBeGreaterThan(0);
      const uploads = fl.posts.filter((p) => p.type === "releases.upload").length;

      const pv = (JSON.parse(readFileSync(join(root, "protocol", "module.json"), "utf8")) as { version: string }).version;
      fl.objects.set(`protocol/${pv}.tgz`, pack([{ path: "module.json", data: Buffer.from("{}") }]));
      fl.objects.set(`host/${version}.tgz`, pack(coreFiles(root, version).map((f) => (f.path === "packages/protocol/contract.ts" ? { ...f, data: Buffer.from("// другое") } : f))));
      fl.objects.delete(`push/${(JSON.parse(readFileSync(join(root, "workers", "push", "module.json"), "utf8")) as { version: string }).version}.tgz`);
      expect(await main(["release", "check"], ENV, undefined, go, fl.f)).toBe(1);
      expect(err.some((x) => x.startsWith(`подними номер: protocol ${pv}: `))).toBe(true);
      expect(err.some((x) => x === `подними номер: host ${version}: packages/protocol/contract.ts`)).toBe(true);
      expect(q.out.at(-1)).toMatch(/^каталог: как в коде \d+, новых номеров 1, поднять 2$/);
      expect(fl.posts.filter((p) => p.type === "releases.upload")).toHaveLength(uploads);
    } finally {
      q.done();
      e.mockRestore();
    }
  });

  it("5197 · check: отказ каталога, кроме «такой версии нет», — исключение словами, а не «всё в порядке»", async () => {
    // источник: устав — ошибка словом; проверка, которая не может упасть, проверкой не считается
    const f: Fetch = async (_u, init) => {
      const fr = JSON.parse(String(init.body)) as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ type: "reply", id: fr.id, ok: false, error: "bad_key" }) };
    };
    await expect(main(["release", "check"], ENV, undefined, go, f)).rejects.toThrow(/releases\.fetch .*: bad_key/);
  });
});
