// Формат выпуска, архив, подпись S3, выкладка и сборка на подменённых npm и node.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bucketOf, parseArgs } from "../cli.ts";
import { pack, packDir, parseSha, presign, sha256hex, shaLine } from "../contract.ts";
import { s3, sign } from "../src/s3.ts";
import type { Fetch } from "../src/s3.ts";
import { entries } from "../src/tar.ts";
import { build, closure, packageFiles } from "../src/build.ts";
import type { Exec } from "../src/build.ts";
import { buildKeeper } from "../src/keeper.ts";
import type { GoExec } from "../src/keeper.ts";
import { dirBucket, s3Bucket, upload } from "../src/publish.ts";

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

describe("подпись S3", () => {
  it("пример AWS «GET Object»: та же подпись", async () => {
    const auth = await sign({
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

  it("клиент: path-style адрес, тело PUT подписано своим хэшем", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const f: Fetch = async (url, init) => {
      seen.push({ url, method: init.method, headers: init.headers });
      return { status: 200, arrayBuffer: async () => new TextEncoder().encode("1.4.1\n").buffer as ArrayBuffer };
    };
    const c = s3({ accessKeyId: "AK", secretAccessKey: "SK", endpoint: "https://acc0.r2.cloudflarestorage.com", bucket: "switchboard-releases" }, f, () => new Date(Date.UTC(2026, 9, 31, 12)));
    const r = await c.get("host/latest");
    expect(r.body.toString()).toBe("1.4.1\n");
    await c.put("host/1.4.1.tgz", Buffer.from("tgz"));
    expect(seen[0].url).toBe("https://acc0.r2.cloudflarestorage.com/switchboard-releases/host/latest");
    expect(seen[0].headers).toMatchObject({ "x-amz-date": "20261031T120000Z", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" });
    expect(seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261031\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(seen[1].headers["x-amz-content-sha256"]).toBe(sha256hex("tgz"));
  });
});

describe("загрузка", () => {
  it("архив, затем хэш в <часть>/<версия>; тот же номер с тем же хэшем — пропуск, с другим — «подними номер», ничего не перезаписано", async () => {
    const d = tmp();
    const b = dirBucket(d);
    const tgz = Buffer.from("архив");
    expect(await upload(b, "keeper", "0.5.0", tgz, sha256hex(tgz))).toBe("uploaded");
    expect(parseSha(readFileSync(join(d, "keeper", "0.5.0.sha256"), "utf8"))).toBe(sha256hex(tgz));
    expect(await upload(b, "keeper", "0.5.0", tgz, sha256hex(tgz))).toBe("same");
    await expect(upload(b, "keeper", "0.5.0", Buffer.from("другой"), sha256hex("другой"))).rejects.toThrow("подними номер keeper");
    expect(readFileSync(join(d, "keeper", "0.5.0.tgz"), "utf8")).toBe("архив");
    expect(existsSync(join(d, "host", "latest"))).toBe(false);
  });

  it("R2: GET хэша 404 — PUT архива, затем хэша; хэш есть — без PUT", async () => {
    const calls: string[] = [];
    let have: string | null = null;
    const f: Fetch = async (url, init) => {
      calls.push(`${init.method} ${url.split("switchboard-releases/")[1]}`);
      const body = init.method === "GET" && have ? Buffer.from(have) : Buffer.alloc(0);
      return { status: init.method === "GET" ? (have ? 200 : 404) : 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer };
    };
    const b = s3Bucket({ accessKeyId: "AK", secretAccessKey: "SK", endpoint: "https://acc0.r2.cloudflarestorage.com", bucket: "switchboard-releases" }, f);
    await upload(b, "host", "1.1.58", Buffer.from("t"), sha256hex("t"));
    expect(calls).toEqual(["GET host/1.1.58.sha256", "PUT host/1.1.58.tgz", "PUT host/1.1.58.sha256"]);
    have = shaLine(sha256hex("t"), "1.1.58");
    calls.length = 0;
    expect(await upload(b, "host", "1.1.58", Buffer.from("t"), sha256hex("t"))).toBe("same");
    expect(calls).toEqual(["GET host/1.1.58.sha256"]);
  });

  it("2077 · аргументы: host с номером, keeper без; --out, --dry-run, --to; незнакомый — отказ; ключ R2 только из окружения", () => {
    expect(parseArgs(["release", "host", "1.4.1", "--dry-run"])).toMatchObject({ part: "host", version: "1.4.1", dryRun: true });
    expect(parseArgs(["release", "keeper", "--to", "x"])).toMatchObject({ part: "keeper", dryRun: false });
    expect(() => parseArgs(["release", "host"])).toThrow("вызов");
    expect(() => parseArgs(["release", "1.4.1"])).toThrow("вызов");
    expect(() => parseArgs(["release", "host", "1.4.1", "--dry-run", "--to", "x"])).toThrow();
    expect(() => parseArgs(["release", "host", "1.4.1", "--zip"])).toThrow("незнакомый аргумент: --zip");
    expect(() => parseArgs(["release", "host", "--dry-run"])).toThrow("вызов");
    expect(bucketOf(parseArgs(["release", "host", "1.4.1", "--dry-run"]), {})).toBeNull();
    expect(() => bucketOf(parseArgs(["release", "keeper"]), {})).toThrow("R2_ACCESS_KEY_ID");
    expect(bucketOf(parseArgs(["release", "keeper"]), { R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_ENDPOINT: "https://x" })?.where).toBe("https://x/switchboard-releases");
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

describe("загрузка: отказ R2", () => {
  it("2078 · R2 отказал на архиве — исключение со статусом, хэш не пишется: версия не готова", async () => {
    const calls: string[] = [];
    const f: Fetch = async (url, init) => {
      calls.push(`${init.method} ${url.split("switchboard-releases/")[1]}`);
      const status = init.method === "GET" ? 404 : 500;
      const body = Buffer.from("InternalError");
      return { status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer };
    };
    const b = s3Bucket({ accessKeyId: "AK", secretAccessKey: "SK", endpoint: "https://acc0.r2.cloudflarestorage.com", bucket: "switchboard-releases" }, f);
    await expect(upload(b, "host", "1.1.60", Buffer.from("t"), sha256hex("t"))).rejects.toThrow("PUT host/1.1.60.tgz: 500 InternalError");
    expect(calls).toEqual(["GET host/1.1.60.sha256", "PUT host/1.1.60.tgz"]);
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
    expect(JSON.parse(readFileSync(join(b.dir, "packages", "host", "release.json"), "utf8"))).toEqual({ version: "1.4.1" });
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
