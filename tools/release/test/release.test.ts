// Формат выпуска, архив, подпись S3, выкладка и сборка на подменённых npm и node.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bucketOf, parseArgs } from "../cli.ts";
import { entries, pack, parseSha, s3, sha256hex, shaLine, sign, unpack } from "../contract.ts";
import type { Fetch } from "../contract.ts";
import { build, closure, packageFiles } from "../src/build.ts";
import type { Exec } from "../src/build.ts";
import { dirBucket, publish, s3Bucket } from "../src/publish.ts";

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
    const d = tmp();
    expect(unpack(tgz, d)).toBe(3);
    expect(readFileSync(join(d, "packages", "host", "release.json"), "utf8")).toBe('{"version":"1.4.1"}');
    expect(readFileSync(join(d, ...long.split("/")))).toEqual(Buffer.alloc(1300, 7));
    expect(entries(tgz).find((e) => e.path === "host")?.mode).toBe(0o755);
    // одно и то же содержимое — один и тот же архив: хэш выпуска воспроизводим
    expect(sha256hex(pack([{ path: "a", data: Buffer.from("x") }]))).toBe(sha256hex(pack([{ path: "a", data: Buffer.from("x") }])));
  });

  it("путь вне папки в архиве — исключение, ничего не записано вне папки", () => {
    const tgz = pack([{ path: "../evil", data: Buffer.from("x") }]);
    expect(() => unpack(tgz, tmp())).toThrow("путь вне архива");
  });

  it("строка .sha256 как у sha256sum; не того вида — null", () => {
    const h = sha256hex("x");
    expect(shaLine(h, "1.4.1")).toBe(`${h}  1.4.1.tgz\n`);
    expect(parseSha(shaLine(h, "1.4.1"))).toBe(h);
    expect(parseSha("nope")).toBeNull();
  });
});

describe("подпись S3", () => {
  it("пример AWS «GET Object»: та же подпись", () => {
    const auth = sign({
      method: "GET",
      path: "/test.txt",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("клиент: path-style адрес, временный ключ заголовком, тело PUT подписано своим хэшем", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const f: Fetch = async (url, init) => {
      seen.push({ url, method: init.method, headers: init.headers });
      return { status: 200, arrayBuffer: async () => new TextEncoder().encode("1.4.1\n").buffer as ArrayBuffer };
    };
    const c = s3({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", endpoint: "https://acc0.r2.cloudflarestorage.com", bucket: "switchboard-releases" }, f, () => new Date(Date.UTC(2026, 9, 31, 12)));
    const r = await c.get("host/latest");
    expect(r.body.toString()).toBe("1.4.1\n");
    await c.put("host/1.4.1.tgz", Buffer.from("tgz"));
    expect(seen[0].url).toBe("https://acc0.r2.cloudflarestorage.com/switchboard-releases/host/latest");
    expect(seen[0].headers).toMatchObject({ "x-amz-date": "20261031T120000Z", "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-security-token": "ST" });
    expect(seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261031\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(seen[1].headers["x-amz-content-sha256"]).toBe(sha256hex("tgz"));
  });
});

describe("выкладка", () => {
  it("архив, хэш, последним latest; та же версия второй раз — отказ, ничего не перезаписано", async () => {
    const d = tmp();
    const b = dirBucket(d);
    const tgz = Buffer.from("архив");
    expect(await publish(b, "1.4.1", tgz, sha256hex(tgz))).toEqual(["host/1.4.1.tgz", "host/1.4.1.sha256", "host/latest"]);
    expect(readFileSync(join(d, "host", "latest"), "utf8")).toBe("1.4.1\n");
    expect(parseSha(readFileSync(join(d, "host", "1.4.1.sha256"), "utf8"))).toBe(sha256hex(tgz));
    await expect(publish(b, "1.4.1", Buffer.from("другой"), "0".repeat(64))).rejects.toThrow("версия выпускается один раз");
    expect(readFileSync(join(d, "host", "1.4.1.tgz"), "utf8")).toBe("архив");
  });

  it("R2: HEAD 404 — можно, PUT по порядку; HEAD 200 — отказ до PUT", async () => {
    const calls: string[] = [];
    let have = false;
    const f: Fetch = async (url, init) => {
      calls.push(`${init.method} ${url.split("switchboard-releases/")[1]}`);
      return { status: init.method === "HEAD" ? (have ? 200 : 404) : 200, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const b = s3Bucket({ accessKeyId: "AK", secretAccessKey: "SK", endpoint: "https://acc0.r2.cloudflarestorage.com", bucket: "switchboard-releases" }, f);
    await publish(b, "1.4.1", Buffer.from("t"), sha256hex("t"));
    expect(calls).toEqual(["HEAD host/1.4.1.sha256", "PUT host/1.4.1.tgz", "PUT host/1.4.1.sha256", "PUT host/latest"]);
    have = true;
    calls.length = 0;
    await expect(publish(b, "1.4.1", Buffer.from("t"), sha256hex("t"))).rejects.toThrow("уже есть");
    expect(calls).toEqual(["HEAD host/1.4.1.sha256"]);
  });

  it("аргументы: версия, --out, --dry-run, --to; ключ R2 только из окружения", () => {
    expect(parseArgs(["release", "1.4.1", "--dry-run"])).toMatchObject({ version: "1.4.1", dryRun: true });
    expect(() => parseArgs(["release"])).toThrow("вызов");
    expect(() => parseArgs(["release", "1.4.1", "--dry-run", "--to", "x"])).toThrow();
    expect(bucketOf(parseArgs(["release", "1.4.1", "--dry-run"]), {})).toBeNull();
    expect(() => bucketOf(parseArgs(["release", "1.4.1"]), {})).toThrow("R2_ACCESS_KEY_ID");
    expect(bucketOf(parseArgs(["release", "1.4.1"]), { R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_ENDPOINT: "https://x" })?.where).toBe("https://x/switchboard-releases");
  });
});

describe("сборка выпуска", () => {
  it("пакеты выпуска: ядро, модули списка и то, что они импортируют; тестов и настроек нет", () => {
    const names = closure(root).map((p) => p.name);
    expect(names[0]).toBe("@switchboard/host");
    expect(names).toEqual(expect.arrayContaining(["@switchboard/protocol", "@switchboard/relay", "@switchboard/manifest-gate"]));
    const core = closure(root)[0].dir;
    const files = packageFiles(core);
    expect(files).toContain("main.ts");
    expect(files).toContain("stand/host.ts"); // стенд — часть контракта ядра
    expect(files.some((f) => f.startsWith("test/") || f.includes(".test."))).toBe(false);
  });

  it("папка версии: вход host, workspaces, release.json; npm и host --check по порядку; архив без node_modules", async () => {
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
    expect(paths).toEqual(expect.arrayContaining(["host", "package.json", "package-lock.json", "packages/host/main.ts", "packages/host/release.json", "packages/protocol/contract.ts"]));
    expect(paths.some((p) => p.includes("node_modules") || p.includes(".test."))).toBe(false);
    const rootPj = JSON.parse(readFileSync(join(b.dir, "package.json"), "utf8"));
    expect(rootPj).toMatchObject({ type: "module", workspaces: ["packages/*"], version: "1.4.1" });
    const corePj = JSON.parse(readFileSync(join(b.dir, "packages", "host", "package.json"), "utf8"));
    expect(corePj.dependencies).toEqual({ "@anthropic-ai/claude-agent-sdk": "0.3.311" });
    expect(corePj.scripts).toBeUndefined();
    expect(JSON.parse(readFileSync(join(b.dir, "packages", "host", "release.json"), "utf8"))).toEqual({ version: "1.4.1", core: expect.stringMatching(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/), modules: expect.any(Object) });
    // отпечатки модулей: перезагрузка на ходу сравнивает их, а не номера версий (живой прогон 31 окт.)
    const rel = JSON.parse(readFileSync(join(b.dir, "packages", "host", "release.json"), "utf8")) as { modules: Record<string, string> };
    for (const v of Object.values(rel.modules)) expect(v).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(readFileSync(join(out, "1.4.1.sha256"), "utf8")).toBe(shaLine(sha256hex(b.tgz), "1.4.1"));
  });

  it("host --check не прошёл или версия не та — исключение с причиной, архива нет", async () => {
    const out = tmp();
    const exec = (check: string): Exec => async (cmd) => ({ code: cmd === "node" ? 1 : 0, out: cmd === "node" ? check : "" });
    await expect(build({ root, version: "1.4.2", out, exec: exec('{ "ok": false, "why": "session.cost: два владельца — cost и dup" }') })).rejects.toThrow("два владельца");
    await expect(build({ root, version: "1.4.2", out, exec: exec('{ "ok": true, "version": "1.4.0" }') })).rejects.toThrow("версия 1.4.0");
    await expect(build({ root, version: "v1", out, exec: exec("") })).rejects.toThrow("не вида");
    expect(existsSync(join(out, "1.4.2.tgz"))).toBe(false);
  });
});
