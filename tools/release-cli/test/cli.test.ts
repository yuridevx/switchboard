// CLI выпуска: аргументы, сборка без загрузки и загрузка через releases.upload на поддельных «Выпусках» и R2.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseSha, sha256hex } from "@switchboard/release";
import type { GoExec } from "@switchboard/release";
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
      const had = objects.get(`${fr.part}/${fr.version}.sha256`);
      const reply = had
        ? parseSha(had.toString("utf8")) === fr.sha256
          ? { type: "reply", id: fr.id, ok: true, result: { same: true } }
          : { type: "reply", id: fr.id, ok: false, error: "version_exists" }
        : { type: "reply", id: fr.id, ok: true, result: { tgz: `https://r2.test/b/${fr.part}/${fr.version}.tgz`, sha256: `https://r2.test/b/${fr.part}/${fr.version}.sha256` } };
      return { ok: true, status: 200, json: async () => reply };
    }
    objects.set(new URL(url).pathname.slice("/b/".length), Buffer.from(init.body as Uint8Array));
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
    fl.objects.set("protocol/1.0.0.sha256", Buffer.from(`${"0".repeat(64)}  1.0.0.tgz\n`));
    try {
      expect(await main(["release", "modules"], ENV, undefined, go, fl.f)).toBe(1);
    } finally {
      q.done();
      e.mockRestore();
    }
    expect(err).toEqual([expect.stringMatching(/^protocol 1\.0\.0: releases\.upload: version_exists/)]);
    expect(fl.posts.map((p) => p.part)).not.toContain("host");
    expect(fl.posts.map((p) => p.part)).not.toContain("keeper");
    expect(fl.objects.has("push/1.0.0.tgz")).toBe(true);
    expect(q.out.at(-1)).toMatch(/^каталог: загружено \d+, уже были 0, собрано без загрузки 0, отказов 1$/);
  });
});
