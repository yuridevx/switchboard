// Формат выпуска, архив, ссылки, загрузка по ссылкам «Выпусков» и сборка на подменённых npm и node.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { manifestOf, pack, packDir, parseSha, presign, sha256hex, shaLine, upload } from "../contract.ts";
import type { Put, UploadReply } from "../contract.ts";
import { entries } from "../src/tar.ts";
import { build, closure, packageFiles } from "../src/build.ts";
import type { Exec } from "../src/build.ts";
import { buildKeeper } from "../src/keeper.ts";
import { packModule } from "../src/module.ts";
import type { GoExec } from "../src/keeper.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const tmp = () => mkdtempSync(join(tmpdir(), "switchboard-release-"));

describe("архив выпуска", () => {
  it("tgz туда и обратно: файлы, вложенные папки, режим входа host, длинный путь", () => {
    const long = "packages/" + "a".repeat(60) + "/" + "b".repeat(60) + "/file.ts";
    const tgz = pack([
      { path: "host", data: Buffer.from("import './x'"), mode: 0o755 },
      { path: "packages/host/release.json", data: Buffer.from('{"version":"1.4.1"}') },
      { path: long, data: Buffer.alloc(1300, 7) },
    ]);
    const files = new Map(entries(tgz).filter((e) => e.data).map((e) => [e.path, e.data!]));
    expect(files.size).toBe(3);
    expect(files.get("packages/host/release.json")!.toString()).toBe('{"version":"1.4.1"}');
    expect(files.get(long)).toEqual(Buffer.alloc(1300, 7));
    expect(entries(tgz).find((e) => e.path === "host")?.mode).toBe(0o755);
    // одно и то же содержимое — один и тот же архив: хэш выпуска воспроизводим
    expect(sha256hex(pack([{ path: "a", data: Buffer.from("x") }]))).toBe(sha256hex(pack([{ path: "a", data: Buffer.from("x") }])));
  });

  it("путь вне папки в архиве — исключение", () => {
    const tgz = pack([{ path: "../evil", data: Buffer.from("x") }]);
    expect(() => entries(tgz)).toThrow("путь вне архива");
  });

  it("строка .sha256 как у sha256sum; не того вида — null", () => {
    const h = sha256hex("x");
    expect(shaLine(h, "1.4.1")).toBe(`${h}  1.4.1.tgz\n`);
    expect(parseSha(shaLine(h, "1.4.1"))).toBe(h);
    expect(parseSha("nope")).toBeNull();
  });
});

describe("упаковка папки и ссылки", () => {
  it("packDir: все файлы папки с путями от неё, тот же набор — тот же архив", () => {
    const d = tmp();
    mkdirSync(join(d, "lib"));
    writeFileSync(join(d, "app.json"), '{"run":["node","main.js"]}');
    writeFileSync(join(d, "lib", "x.js"), "1");
    const a = packDir(d);
    expect(entries(a).filter((e) => e.data).map((e) => e.path)).toEqual(["app.json", "lib/x.js"]);
    expect(sha256hex(packDir(d))).toBe(sha256hex(a));
  });

  it("presign — пример AWS: GET test.txt на сутки", async () => {
    const url = await presign(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      { method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", now: new Date("2013-05-24T00:00:00Z"), expires: 86400 },
    );
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});

/** «Выпуски» и R2 на подделках: ответ releases.upload и записанные PUT. */
function fakeReleases(reply: UploadReply) {
  const asked: string[] = [];
  const puts: Array<[string, string]> = [];
  const ask = async (sha256: string) => {
    asked.push(sha256);
    return reply;
  };
  const put: Put = async (url, init) => {
    puts.push([new URL(url).pathname, Buffer.from(init.body).toString("utf8")]);
    return { ok: true, status: 200 };
  };
  return { ask, put, asked, puts };
}
const LINKS: UploadReply = { ok: true, result: { tgz: "https://acc0.r2.cloudflarestorage.com/switchboard-releases/keeper/0.5.0.tgz?X-Amz-Signature=a", sha256: "https://acc0.r2.cloudflarestorage.com/switchboard-releases/keeper/0.5.0.sha256?X-Amz-Signature=b" } };

describe("загрузка по ссылкам «Выпусков»", () => {
  it("5141 · хэш архива — в запрос; ссылки — PUT архива, затем .sha256; тот же хэш лежит — пропуск без PUT; отказ — словом «Выпусков»", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): загрузка по ссылкам «Выпусков» — одна функция
    const tgz = Buffer.from("архив");
    const a = fakeReleases(LINKS);
    expect(await upload(a.ask, "0.5.0", tgz, a.put)).toEqual({ done: "uploaded", sha256: sha256hex(tgz) });
    expect(a.asked).toEqual([sha256hex(tgz)]);
    expect(a.puts).toEqual([
      ["/switchboard-releases/keeper/0.5.0.tgz", "архив"],
      ["/switchboard-releases/keeper/0.5.0.sha256", shaLine(sha256hex(tgz), "0.5.0")],
    ]);
    const same = fakeReleases({ ok: true, result: { same: true } });
    expect((await upload(same.ask, "0.5.0", tgz, same.put)).done).toBe("same");
    expect(same.puts).toEqual([]);
    const no = fakeReleases({ ok: false, error: "version_exists" });
    await expect(upload(no.ask, "0.5.0", tgz, no.put)).rejects.toThrow("releases.upload: version_exists");
    expect(no.puts).toEqual([]);
  });

  it("2078 · R2 отказал на архиве — исключение со статусом и путём, хэш не пишется: версия не готова", async () => {
    const a = fakeReleases(LINKS);
    const puts: string[] = [];
    const put: Put = async (url) => (puts.push(new URL(url).pathname), { ok: false, status: 500 });
    await expect(upload(a.ask, "0.5.0", Buffer.from("t"), put)).rejects.toThrow("upload_failed: R2 ответил 500 на /switchboard-releases/keeper/0.5.0.tgz");
    expect(puts).toEqual(["/switchboard-releases/keeper/0.5.0.tgz"]);
  });

  it("архив keeper: два файла по ОС, режим исполнения, тот же вывод go — тот же хэш; go не собрал — исключение", async () => {
    const seen: string[][] = [];
    const go: GoExec = async (args, _cwd, env) => {
      seen.push(args);
      const out = args[args.indexOf("-o") + 1];
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, `keeper ${env.GOOS}/${env.GOARCH}`);
      return { code: 0, out: "" };
    };
    const a = await buildKeeper(root, go);
    expect(a.version).toBe(JSON.parse(readFileSync(join(root, "os", "keeper", "module.json"), "utf8")).version);
    expect(entries(a.tgz).filter((e) => e.data).map((e) => [e.path, e.data!.toString(), e.mode])).toEqual([
      ["linux-amd64/keeper", "keeper linux/amd64", 0o755],
      ["windows-amd64/keeper.exe", "keeper windows/amd64", 0o755],
    ]);
    expect((await buildKeeper(root, go)).sha).toBe(a.sha);
    // без сведений git: иначе ревизия коммита в файле меняет хэш при неизменном коде
    expect(seen.every((x) => x.includes("-buildvcs=false") && x.includes("-trimpath"))).toBe(true);
    await expect(buildKeeper(root, async () => ({ code: 1, out: "syntax error" }))).rejects.toThrow("go build windows/amd64: syntax error");
  });
});

describe("сборка выпуска", () => {
  it("пакеты ядра: ядро, то, что оно импортирует, и пакеты @switchboard из его зависимостей; модулей, тестов и настроек нет", () => {
    const names = closure(root).map((p) => p.name);
    expect(names[0]).toBe("@switchboard/host");
    expect(names).toEqual(expect.arrayContaining(["@switchboard/protocol", "@switchboard/relay", "@switchboard/manifest-gate", "@switchboard/release"]));
    expect(names.some((n) => n.startsWith("@switchboard/host-"))).toBe(false);
    const core = closure(root)[0].dir;
    const files = packageFiles(core);
    expect(files).toContain("main.ts");
    expect(files).toContain("stand/host.ts"); // стенд — часть контракта ядра
    expect(files.some((f) => f.startsWith("test/") || f.includes(".test."))).toBe(false);
  });

  it("папка ядра: module.json первым, вход host, workspaces; npm и host --check по порядку; архив без node_modules", async () => {
    const out = tmp();
    const ran: string[] = [];
    const exec: Exec = async (cmd, args, cwd) => {
      ran.push(`${cmd} ${args[0]} ${args[1] ?? ""}`.trim());
      if (cmd === "npm" && args[0] === "install") writeFileSync(join(cwd, "package-lock.json"), "{}");
      if (cmd === "npm" && args[0] === "ci") mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
      if (cmd === "node") return { code: 0, out: 'шум\n{ "ok": true, "version": "1.4.1", "sdk": "0.3.311", "proto": 1 }\n' };
      return { code: 0, out: "" };
    };
    const b = await build({ root, version: "1.4.1", out, exec });
    expect(ran).toEqual(["npm install --package-lock-only", "npm ci --omit=dev", "node host --check"]);
    expect(b.check).toEqual({ ok: true, version: "1.4.1", sdk: "0.3.311", proto: 1 });
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
    const paths = entries(b.tgz).map((e) => e.path);
    expect(paths[0]).toBe("module.json");
    expect(await manifestOf(b.tgz)).toMatchObject({ name: "host", type: "sdk-core" });
    expect(paths).toEqual(expect.arrayContaining(["host", "package.json", "package-lock.json", "packages/host/main.ts", "packages/protocol/contract.ts", "packages/release/contract.ts"]));
    expect(paths.some((p) => p.includes("node_modules") || p.includes(".test."))).toBe(false);
    const rootPj = JSON.parse(readFileSync(join(b.dir, "package.json"), "utf8"));
    expect(rootPj).toMatchObject({ type: "module", workspaces: ["packages/*"], version: "1.4.1" });
    const corePj = JSON.parse(readFileSync(join(b.dir, "packages", "host", "package.json"), "utf8"));
    expect(corePj.dependencies).toEqual({ "@anthropic-ai/claude-agent-sdk": "0.3.311", zod: "4.4.3" });
    expect(corePj.scripts).toBeUndefined();
    // Host — часть машины, как приложение: keeper ставит его по app.json
    expect(JSON.parse(readFileSync(join(b.dir, "app.json"), "utf8"))).toEqual({ run: ["node", "host"], setup: ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], detach_children: true });
    expect(paths).toContain("app.json");
    expect(readFileSync(join(out, "1.4.1.sha256"), "utf8")).toBe(shaLine(sha256hex(b.tgz), "1.4.1"));
  });

  it("2076 · npm или host --check не прошли, версия не та — исключение с причиной, архива нет", async () => {
    const out = tmp();
    const npmFails = (step: string): Exec => async (cmd, args) => ({ code: cmd === "npm" && args[0] === step ? 1 : 0, out: cmd === "npm" && args[0] === step ? `npm ${step} упал` : "" });
    await expect(build({ root, version: "1.4.2", out, exec: npmFails("install") })).rejects.toThrow("npm install --package-lock-only: npm install упал");
    await expect(build({ root, version: "1.4.2", out, exec: npmFails("ci") })).rejects.toThrow("npm ci: npm ci упал");
    const exec = (check: string): Exec => async (cmd) => ({ code: cmd === "node" ? 1 : 0, out: cmd === "node" ? check : "" });
    await expect(build({ root, version: "1.4.2", out, exec: exec('{ "ok": false, "why": "session.cost: два владельца — cost и dup" }') })).rejects.toThrow("два владельца");
    await expect(build({ root, version: "1.4.2", out, exec: exec('{ "ok": true, "version": "1.4.0" }') })).rejects.toThrow("версия 1.4.0");
    await expect(build({ root, version: "v1", out, exec: exec("") })).rejects.toThrow("не вида");
    expect(existsSync(join(out, "1.4.2.tgz"))).toBe(false);
  });
});

describe("каталог модулей", () => {
  it("5113 · архив модуля: module.json первой записью и читается по началу архива; у Worker'а — только module.json с именами по флотам из wrangler", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): имён Worker'ов в манифестах, написанных руками, 0
    const d = tmp();
    writeFileSync(join(d, "module.json"), JSON.stringify({ name: "hello-worker", type: "worker", version: "0.1.0", provides: {}, uses: {}, config: {} }));
    writeFileSync(join(d, "wrangler.jsonc"), `// Worker\n{ "name": "hello", /* тест */ "main": "src/index.ts", "env": { "prod": { "routes": ["https://x//y"], }, "eu": { "name": "hello-eu" } } }`);
    const w = packModule(d);
    expect(entries(w.tgz).map((e) => e.path)).toEqual(["module.json"]);
    expect(await manifestOf(w.tgz)).toMatchObject({ name: "hello-worker", version: "0.1.0", workers: { test: "hello", prod: "hello-prod", eu: "hello-eu" } });

    const h = tmp();
    mkdirSync(join(h, "src"));
    writeFileSync(join(h, "contract.ts"), "export {};\n");
    writeFileSync(join(h, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(h, "module.json"), JSON.stringify({ name: "hello-host", type: "sdk", version: "0.1.0", into: ["host"] }));
    const m = packModule(h);
    expect(entries(m.tgz).map((e) => e.path)).toEqual(["module.json", "contract.ts", "src/", "src/a.ts"]);
    expect(await manifestOf(m.tgz)).toMatchObject({ name: "hello-host", into: ["host"] });
    expect(await manifestOf(pack([{ path: "app.json", data: Buffer.from("{}") }]))).toBeNull();
    expect(packModule(h).sha).toBe(m.sha);
  });
});
