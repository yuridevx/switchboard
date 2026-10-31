// Эталоны upgrade на стенде Host: поддельные SDK, relay, keeper и часы; points и R2 — поддельные:
// ключ — ответ на points.creds в поддельном relay, выпуски — в памяти. npm ci и host --check — подменены. Номер эталона — номер теста.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Manifest, Module } from "@switchboard/host";
import { pack, sha256hex, shaLine } from "@switchboard/release";
import type { Fetch } from "@switchboard/release";
import { upgrade } from "../src/upgrade.ts";
import type { UpgradeOptions } from "../src/upgrade.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "module.json"), "utf8")) as Manifest;
const stands: stand.Stand[] = [];
const keepers: stand.FakeKeeper[] = [];
afterEach(async () => {
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
});

const CREDS = { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", endpoint: "https://acc0.r2.cloudflarestorage.com", bucket: "switchboard-releases", exp: 0 };

/** Поддельный R2: объекты в памяти; gets — что читали; hold — ключ, чтение которого ждёт release. */
class R2 {
  objs = new Map<string, Buffer>();
  gets: string[] = [];
  hold: { key: string; release: () => void; wait: Promise<void> } | null = null;
  fetch: Fetch = async (url, init) => {
    const key = url.split("/switchboard-releases/")[1];
    this.gets.push(`${init.method} ${key}`);
    expect(init.headers["x-amz-security-token"]).toBe("ST");
    if (this.hold?.key === key) {
      const h = this.hold;
      await new Promise<void>((res, rej) => {
        void h.wait.then(res);
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      });
    }
    const b = this.objs.get(key);
    return { status: b ? 200 : 404, arrayBuffer: async () => (b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.length) : new ArrayBuffer(0)) as ArrayBuffer };
  };
  holdKey(key: string): void {
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    this.hold = { key, release, wait };
  }
  /** Положить выпуск, как switchboard release: архив, хэш, latest. */
  put(v: string, o: { latest?: boolean; badSha?: boolean } = {}): void {
    const tgz = pack([
      { path: "host", data: Buffer.from('import "./packages/host/main.ts";\n'), mode: 0o755 },
      { path: "package.json", data: Buffer.from(JSON.stringify({ name: "switchboard-host-release", version: v, workspaces: ["packages/*"] })) },
      { path: "packages/host/release.json", data: Buffer.from(JSON.stringify({ version: v })) },
    ]);
    this.objs.set(`host/${v}.tgz`, tgz);
    this.objs.set(`host/${v}.sha256`, Buffer.from(shaLine(o.badSha ? sha256hex("другой") : sha256hex(tgz), v)));
    if (o.latest) this.objs.set("host/latest", Buffer.from(v + "\n"));
  }
}

type Fakes = { r2: R2; npm: string[]; checks: string[]; checkOut: Record<string, object>; creds: number };

function fakes(): Fakes {
  return { r2: new R2(), npm: [], checks: [], checkOut: {}, creds: 0 };
}

function options(f: Fakes, home: string, running: string): Partial<UpgradeOptions> {
  return {
    home,
    fetch: f.r2.fetch,
    running,
    npm: async (args, cwd) => {
      f.npm.push(`${args[0]} ${cwd}`);
      const d = join(cwd, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "claude.exe"), "бинарник");
      return { code: 0, out: "added 118 packages" };
    },
    node: async (args, cwd) => {
      f.checks.push(`${args.join(" ")} ${cwd}`);
      const v = JSON.parse(readFileSync(join(cwd, "packages", "host", "release.json"), "utf8")).version;
      return { code: 0, out: JSON.stringify(f.checkOut[v] ?? { ok: true, version: v, sdk: "0.3.311", proto: 1 }) + "\n" };
    },
  };
}

/** Поддельный points в relay: на points.creds — ключ на чтение выпусков. */
function points(st: stand.Stand, f: Fakes): void {
  const relay = st.relay as unknown as { receive: (ws: unknown, text: string) => void };
  const orig = relay.receive.bind(relay);
  relay.receive = (ws, text) => {
    orig(ws, text);
    if (text === "ping") return;
    const fr = JSON.parse(text);
    if (fr.type === "points.creds") {
      f.creds++;
      expect(fr.to).toBe("points");
      queueMicrotask(() => st.relay.deliver({ type: "reply", id: fr.id, ok: true, result: { creds: CREDS }, from: "points" } as never));
    }
  };
}

type HostOpts = { home: string; version: string; f: Fakes; running?: string; keeper?: stand.FakeKeeper; sdk?: string; modules?: ReturnType<typeof stand.module>[]; releases?: Record<string, ReturnType<typeof stand.release>> };
async function host(o: HostOpts) {
  const up = { manifest, module: upgrade(options(o.f, o.home, o.running ?? o.version)) };
  const st = await stand.standHost({ home: o.home, version: o.version, keeper: o.keeper, sdkVersion: o.sdk, modules: [up, ...(o.modules ?? [])], releases: o.releases });
  stands.push(st);
  points(st, o.f);
  return { st, up };
}

const ask = (st: stand.Stand, f: Record<string, unknown>) => st.relay.request({ type: "machine.upgrade", v: 1, machine: "laptop", ...f } as never);
const dirOf = (home: string, v: string) => join(home, "host", v);
const refusals = (st: stand.Stand) => st.journal().filter((l) => l.kind === "refuse" && l.ev === "request");
const mkhome = () => mkdtempSync(join(tmpdir(), "switchboard-upgrade-"));

/** Модуль profiles для дорожки «только модули»: хук PostToolUse отвечает своей версией. */
function profiles(v: string) {
  const m: Module = { session: () => ({ hooks: { PostToolUse: [{ hooks: [async () => ({ systemMessage: `profiles ${v}` })] }] } }) };
  return stand.module("host-profiles", m, { version: v, provides: { profile: 1 } });
}

describe("эталоны upgrade", () => {
  it("92 · ядро другое, SDK тот же: points.creds, .sha256 и .tgz, core_changed, один --check; ответ до остановки; keeper — одна просьба; новый Host — attach, ход дошёл до конца, restart нет", async () => {
    const home = mkhome();
    const k = await new stand.FakeKeeper().listen();
    keepers.push(k);
    const f = fakes();
    f.r2.put("1.4.1");
    const { st, up } = await host({ home, version: "1.4.0", f, keeper: k, releases: { [dirOf(home, "1.4.1")]: stand.release("1.4.1", [], { core: "1.1.0" }) } });
    await st.open("site@laptop");
    const p = k.procs.get("site@laptop")!;
    p.send(stand.msg.state("running"));
    const r = await ask(st, { version: "1.4.1" });
    expect(r).toMatchObject({ ok: true, result: { from: "1.4.0", to: "1.4.1", sdk: { from: "0.3.311", to: "0.3.311" }, restart: true } });
    expect(f.creds).toBe(1);
    expect(f.r2.gets).toEqual(["GET host/1.4.1.sha256", "GET host/1.4.1.tgz"]);
    expect(f.checks).toEqual([`host --check ${dirOf(home, "1.4.1")}`]);
    expect(st.journal().find((l) => l.ev === "reload")?.word).toBe("core_changed");
    await stand.until(() => k.upgrades.length === 1);
    expect(k.upgrades).toEqual(["1.4.1"]);
    await stand.until(() => st.relay.frames("ledger.add").length === 1);
    expect(st.relay.frames("ledger.add")[0]).toMatchObject({ to: "ledger", ev: "machine.upgraded", by: "panel-desk", machine: "laptop", text: "laptop: Host 1.4.0 → 1.4.1" });
    // keeper останавливает Host штатно и запускает 1.4.1
    k.stop("upgrade");
    await stand.until(() => st.exits.length === 1);
    expect(p.alive).toBe(true);
    const st2 = await stand.standHost({ home, version: "1.4.1", keeper: k, modules: [up] });
    stands.push(st2);
    const s2 = st2.session("host-upgrade", "site@laptop")!;
    expect(s2.info.start).toBe("attach");
    p.send(stand.msg.result());
    p.send(stand.msg.state("idle"));
    await stand.until(() => s2.state === "idle");
    expect(k.procs.get("site@laptop")!.pid).toBe(p.pid);
    expect(st2.sdk.of("site@laptop")).toHaveLength(1);
    expect(k.readies.at(-1)).toBe("1.4.1");
  });

  it("93 · в 1.4.1 SDK 0.3.312: после attach profiles — сразу, site — после result, wiki — после ответа и конца хода; тот же session_id; sdk 0.3.312", async () => {
    const home = mkhome();
    const k = await new stand.FakeKeeper().listen();
    keepers.push(k);
    const f = fakes();
    f.r2.put("1.4.1");
    f.checkOut["1.4.1"] = { ok: true, version: "1.4.1", sdk: "0.3.312", proto: 1 };
    let answer!: (r: unknown) => void;
    const questions = (wait: boolean) =>
      stand.module("host-questions", { decide: { AskUserQuestion: (_s, input) => (wait ? new Promise((r) => (answer = () => r({ behavior: "allow", updatedInput: { ...input, answers: { "Цвет?": "Синий" } } }))) : new Promise(() => {})) } });
    const { st, up } = await host({ home, version: "1.4.0", f, keeper: k, modules: [questions(false)], releases: { [dirOf(home, "1.4.1")]: stand.release("1.4.1", [], { sdk: "0.3.312" }) } });
    const sids: Record<string, string> = {};
    for (const cs of ["site@laptop", "profiles@laptop", "wiki@laptop"]) sids[cs] = (await st.open(cs)).info.session_id;
    const site = k.procs.get("site@laptop")!;
    const wiki = k.procs.get("wiki@laptop")!;
    site.send(stand.msg.state("running"));
    wiki.send(stand.msg.state("running"));
    const asked = wiki.ask("AskUserQuestion", { questions: [{ question: "Цвет?", options: [{ label: "Синий" }, { label: "Красный" }] }] });
    wiki.send(stand.msg.state("requires_action"));
    await stand.until(() => st.kernel.sessions.get("wiki@laptop")!.state === "waiting" && st.kernel.sessions.get("site@laptop")!.state === "busy");
    expect(await ask(st, { version: "1.4.1" })).toMatchObject({ ok: true, result: { sdk: { from: "0.3.311", to: "0.3.312" }, restart: true } });
    await stand.until(() => k.upgrades.length === 1);
    k.stop("upgrade");
    await stand.until(() => st.exits.length === 1);
    const st2 = await stand.standHost({ home, version: "1.4.1", keeper: k, sdkVersion: "0.3.312", modules: [up, questions(true)] });
    stands.push(st2);
    const sess = (cs: string) => st2.kernel.sessions.get(cs)!;
    await stand.until(() => st2.sdk.of("profiles@laptop").length === 2 && sess("profiles@laptop").state === "idle");
    expect(st2.sdk.of("site@laptop")).toHaveLength(1);
    expect(st2.sdk.of("wiki@laptop")).toHaveLength(1);
    site.send(stand.msg.result());
    site.send(stand.msg.state("idle"));
    await stand.until(() => st2.sdk.of("site@laptop").length === 2 && sess("site@laptop").state === "idle");
    expect(st2.sdk.of("wiki@laptop")).toHaveLength(1);
    await stand.until(() => typeof answer === "function");
    answer(null);
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Цвет?": "Синий" } } });
    wiki.send(stand.msg.state("running"));
    wiki.send(stand.msg.result());
    wiki.send(stand.msg.state("idle"));
    await stand.until(() => st2.sdk.of("wiki@laptop").length === 2 && sess("wiki@laptop").state === "idle");
    for (const cs of Object.keys(sids)) {
      expect(sess(cs).rec.session_id).toBe(sids[cs]);
      expect(sess(cs).record().sdk).toBe("0.3.312");
    }
    expect(site.interrupts + wiki.interrupts).toBe(0);
  });

  it("94 · в 1.4.2 два владельца session.cost: check_failed; причина в журнале; keeper не тронут; Host и сессии на месте; папки 1.4.2 нет", async () => {
    const home = mkhome();
    const f = fakes();
    f.r2.put("1.4.2");
    const cost = stand.module("host-cost", { requests: { "session.cost": () => 0 } });
    const dup = stand.module("host-dup", { requests: { "session.cost": () => 1 } });
    const { st } = await host({ home, version: "1.4.0", f, releases: { [dirOf(home, "1.4.2")]: stand.release("1.4.2", [cost, dup]) } });
    const s = await st.open("site@laptop");
    expect(await ask(st, { version: "1.4.2" })).toMatchObject({ ok: false, error: "check_failed" });
    expect(st.journal().some((l) => l.ev === "reload" && String(l.why).startsWith("1.4.2: session.cost: два владельца — host-cost и host-dup"))).toBe(true);
    expect(st.keeper.upgrades).toEqual([]);
    expect(f.checks).toEqual([]);
    expect(st.kernel.version).toBe("1.4.0");
    expect(s.state).toBe("idle");
    expect(existsSync(dirOf(home, "1.4.2"))).toBe(false);
  });

  it("95 · работает 1.4.1: «1.4.1» — already_current без скачивания; «1.4.3» во время скачивания 1.4.2 — upgrade_running; keeper — одна просьба; две строки refuse", async () => {
    const home = mkhome();
    const f = fakes();
    f.r2.put("1.4.2");
    const { st } = await host({ home, version: "1.4.1", f, releases: { [dirOf(home, "1.4.2")]: stand.release("1.4.2", [], { core: "1.1.0" }) } });
    expect(await ask(st, { version: "1.4.1" })).toMatchObject({ ok: false, error: "already_current" });
    expect(f.r2.gets).toEqual([]);
    expect(f.creds).toBe(0);
    f.r2.holdKey("host/1.4.2.tgz");
    const second = ask(st, { version: "1.4.2" });
    await stand.until(() => f.r2.gets.includes("GET host/1.4.2.tgz"));
    expect(await ask(st, { version: "1.4.3" })).toMatchObject({ ok: false, error: "upgrade_running" });
    f.r2.hold!.release();
    expect(await second).toMatchObject({ ok: true, result: { to: "1.4.2", restart: true } });
    await stand.until(() => st.keeper.upgrades.length === 1);
    expect(st.keeper.upgrades).toEqual(["1.4.2"]);
    const lines = refusals(st).filter((l) => l.word !== "unknown_request");
    expect(lines.map((l) => [l.word, l.why])).toEqual([
      ["already_current", "machine.upgrade 1.4.1: уже работает"],
      ["upgrade_running", "machine.upgrade 1.4.3: идёт обновление до 1.4.2"],
    ]);
  });

  it("248 · ядро и SDK те же, host-profiles 1.0.1: один host.reload, без --check и upgrade; ready 1.4.1; restart false, modules; процессы те же; хук — 1.0.1; папка 1.4.0 на месте", async () => {
    const home = mkhome();
    mkdirSync(dirOf(home, "1.4.0"), { recursive: true });
    const f = fakes();
    f.r2.put("1.4.1");
    const p100 = profiles("1.0.0");
    const st0 = await host({ home, version: "1.4.0", f, modules: [p100] });
    const { st, up } = st0;
    st.kernel.deps.loadRelease = async (dir) => {
      reloads.push(dir);
      return stand.release("1.4.1", [up, profiles("1.0.1")]);
    };
    const reloads: string[] = [];
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    const pid = p.pid;
    p.send(stand.msg.state("running"));
    const r = await ask(st, { version: "1.4.1" });
    expect(r).toEqual(expect.objectContaining({ ok: true, result: { from: "1.4.0", to: "1.4.1", sdk: { from: "0.3.311", to: "0.3.311" }, restart: false, modules: ["host-profiles"] } }));
    expect(reloads).toEqual([dirOf(home, "1.4.1")]);
    expect(f.checks).toEqual([]);
    expect(st.keeper.upgrades).toEqual([]);
    expect(st.keeper.readies).toEqual(["1.4.0", "1.4.1"]);
    expect(await p.hook("PostToolUse", { tool_name: "Bash" })).toEqual([{ systemMessage: "profiles 1.0.1" }]);
    p.send(stand.msg.result());
    p.send(stand.msg.state("idle"));
    await stand.until(() => st.kernel.sessions.get("site@laptop")!.state === "idle");
    expect(st.proc("site@laptop").pid).toBe(pid);
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(existsSync(dirOf(home, "1.4.0"))).toBe(true);
    expect(st.relay.frames("ledger.add")).toEqual([expect.objectContaining({ ev: "machine.upgraded", text: "laptop: Host 1.4.0 → 1.4.1" })]);
  });

  it("258 · dryRun latest: { from 1.4.0, to 1.4.1 } — один points.creds, прочитаны latest и .sha256, архива нет, ядро и keeper не звались; dryRun 1.4.0 — to 1.4.0, не already_current", async () => {
    const home = mkhome();
    const f = fakes();
    f.r2.put("1.4.0");
    f.r2.put("1.4.1", { latest: true });
    const { st } = await host({ home, version: "1.4.0", f });
    const ops = st.keeper.ops.length;
    expect(await ask(st, { version: "latest", dryRun: true })).toMatchObject({ ok: true, result: { from: "1.4.0", to: "1.4.1" } });
    expect(f.creds).toBe(1);
    expect(f.r2.gets).toEqual(["GET host/latest", "GET host/1.4.1.sha256"]);
    expect(existsSync(dirOf(home, "1.4.1"))).toBe(false);
    expect(st.journal().filter((l) => l.ev === "reload")).toEqual([]);
    expect(st.keeper.ops.length).toBe(ops);
    expect(await ask(st, { version: "1.4.0", dryRun: true })).toMatchObject({ ok: true, result: { from: "1.4.0", to: "1.4.0" } });
  });

  it("249 · latest 1.4.1 с чужим хэшем — download_failed, оба хэша в журнале, папки нет; 1.4.9 — no_release без архива; верный хэш — ok", async () => {
    const home = mkhome();
    const f = fakes();
    f.r2.put("1.4.1", { latest: true, badSha: true });
    const { st, up } = await host({ home, version: "1.4.0", f, releases: { [dirOf(home, "1.4.1")]: stand.release("1.4.1", []) } });
    void up;
    expect(await ask(st, { version: "latest" })).toMatchObject({ ok: false, error: "download_failed" });
    const why = refusals(st).find((l) => l.word === "download_failed")!.why as string;
    expect(why).toContain(sha256hex(f.r2.objs.get("host/1.4.1.tgz")!));
    expect(why).toContain(sha256hex("другой"));
    expect(existsSync(dirOf(home, "1.4.1"))).toBe(false);
    expect(st.keeper.upgrades).toEqual([]);
    f.r2.gets.length = 0;
    expect(await ask(st, { version: "1.4.9" })).toMatchObject({ ok: false, error: "no_release" });
    expect(f.r2.gets).toEqual(["GET host/1.4.9.sha256"]);
    f.r2.put("1.4.1", { latest: true });
    expect(await ask(st, { version: "latest" })).toMatchObject({ ok: true, result: { to: "1.4.1" } });
  });
});

describe("upgrade", () => {
  it("bad_frame: нет версии или не того вида", async () => {
    const { st } = await host({ home: mkhome(), version: "1.4.0", f: fakes() });
    expect(await ask(st, {})).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await ask(st, { version: "v1.5" })).toMatchObject({ ok: false, error: "bad_frame" });
  });

  it("распаковка и npm ci в папку версии; метка архива; повтор той же версии — без скачивания", async () => {
    const home = mkhome();
    const f = fakes();
    f.r2.put("1.4.1");
    const { st } = await host({ home, version: "1.4.0", f, releases: { [dirOf(home, "1.4.1")]: stand.release("1.4.1", [], { core: "1.1.0" }) } });
    f.checkOut["1.4.1"] = { ok: false, why: "нет" };
    expect(await ask(st, { version: "1.4.1" })).toMatchObject({ ok: false, error: "check_failed" });
    expect(existsSync(dirOf(home, "1.4.1"))).toBe(false);
    f.checkOut["1.4.1"] = { ok: true, version: "1.4.1", sdk: "0.3.311" };
    expect(await ask(st, { version: "1.4.1" })).toMatchObject({ ok: true });
    expect(readFileSync(join(dirOf(home, "1.4.1"), "packages", "host", "release.json"), "utf8")).toBe('{"version":"1.4.1"}');
    expect(f.npm).toEqual([`ci ${dirOf(home, "1.4.1")}`, `ci ${dirOf(home, "1.4.1")}`]);
  });

  it("Host останавливается во время скачивания: shutting_down, папки нет, keeper не тронут", async () => {
    const home = mkhome();
    const f = fakes();
    f.r2.put("1.4.1");
    const { st } = await host({ home, version: "1.4.0", f });
    f.r2.holdKey("host/1.4.1.tgz");
    const r = ask(st, { version: "1.4.1" });
    await stand.until(() => f.r2.gets.includes("GET host/1.4.1.tgz"));
    const down = st.kernel.shutdown("upgrade");
    expect(await r).toMatchObject({ ok: false, error: "shutting_down" });
    await down;
    expect(existsSync(dirOf(home, "1.4.1"))).toBe(false);
    expect(st.keeper.upgrades).toEqual([]);
  });

  it("points не выдал ключ — download_failed, модуль работает", async () => {
    const home = mkhome();
    const f = fakes();
    const st = await stand.standHost({ home, modules: [{ manifest, module: upgrade(options(f, home, "1.4.0")) }] });
    stands.push(st);
    const relay = st.relay as unknown as { receive: (ws: unknown, text: string) => void };
    const orig = relay.receive.bind(relay);
    relay.receive = (ws, text) => {
      orig(ws, text);
      const fr = text === "ping" ? {} : JSON.parse(text);
      if (fr.type === "points.creds") queueMicrotask(() => st.relay.deliver({ type: "reply", id: fr.id, ok: false, error: "r2_failed" } as never));
    };
    expect(await ask(st, { version: "latest" })).toMatchObject({ ok: false, error: "download_failed" });
    expect(await ask(st, { version: "bad" })).toMatchObject({ ok: false, error: "bad_frame" });
  });

  it("уборка на старте: папки других версий удалены, бинарник claude — первым; текущая и та, откуда работает ядро, — на месте", async () => {
    const home = mkhome();
    for (const v of ["1.3.9", "1.4.0", "1.4.1"]) {
      const d = join(dirOf(home, v), "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "claude"), "x");
    }
    mkdirSync(join(home, "host", "notes"));
    const { st } = await host({ home, version: "1.4.1", f: fakes(), running: "1.4.0" });
    expect(existsSync(dirOf(home, "1.3.9"))).toBe(false);
    expect(existsSync(dirOf(home, "1.4.0"))).toBe(true);
    expect(existsSync(dirOf(home, "1.4.1"))).toBe(true);
    expect(existsSync(join(home, "host", "notes"))).toBe(true);
    expect(st.journal().filter((l) => l.ev === "cleanup").map((l) => l.why)).toEqual(["папка 1.3.9 удалена"]);
  });
});
