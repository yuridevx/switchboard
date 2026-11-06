// Леса границы «вход и профиль сессии», сторона Host, профиль. Снаружи: поддельные SDK, relay, keeper и часы;
// git — поддельный, пишет свои вызовы с окружением, в эталонах слияния — настоящий; github и настройки флота — поддельные участники рации. Номер эталона — номер теста.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import { FLEET_PREFIX, PROFILE_REPOS, settings } from "@switchboard/records";
import manifest from "../module.json" with { type: "json" };
import { make } from "../contract.ts";
import type { Git } from "../contract.ts";
import { realGit } from "../src/sync.ts";

/** Кусочки сводятся раз в минуту. */
const SYNC_MS = 60_000;
const KEY = `${FLEET_PREFIX}.${PROFILE_REPOS}`;
const REPO = "team/profiles";

const { module, standHost, until } = stand;
type Stand = stand.Stand;
type Answer = { ok: true; result: unknown } | { ok: false; error: string };

let st: Stand | null = null;
let home = "";
const saved = { ...process.env };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-profiles-"));
  process.env.SWITCHBOARD_HOME = home;
  fleet = { repos: null, down: null };
});
afterEach(async () => {
  chosen.clear();
  await st?.close();
  st = null;
  vi.useRealTimers();
  process.env = { ...saved };
});

const clone = (repo = REPO) => join(home, "profiles", repo.replace("/", "__"));
const OPS = `${REPO}/ops`;
const WRITER = `${REPO}/writer`;

/** Файлы кусочка: путь от папки кусочка → текст. */
function piece(id: string, files: Record<string, string> = {}) {
  const [owner, name, folder] = id.split("/");
  const dir = join(clone(`${owner}/${name}`), folder);
  mkdirSync(join(clone(`${owner}/${name}`), ".git"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const skill = (name: string) => ({ [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Скил.\n---\n` });
const plugin = (o: unknown) => ({ ".claude-plugin/plugin.json": JSON.stringify(o) });

/** Клон team/profiles на машине: ops и writer. */
function repo(ops = "Ты ведёшь эксплуатацию.") {
  piece(OPS, { "CLAUDE.md": ops, "settings.json": JSON.stringify({ model: "opus", effortLevel: "high" }), "memory/MEMORY.md": "- индекс ops" });
  piece(WRITER, { "CLAUDE.md": "Ты пишешь тексты.", "memory/MEMORY.md": "- индекс writer" });
}

type GitCall = { args: string[]; env: Record<string, string>; cwd: string };

/** Поддельный git: ответы по команде, все вызовы с окружением. clone создаёт папку клона. */
function fakeGit() {
  const calls: GitCall[] = [];
  const o = { dirty: true, pull: { code: 0, out: "Already up to date." }, push: { code: 0, out: "" }, conflict: ["ops/memory/testing.md"] };
  const git: Git = async (args, x) => {
    calls.push({ args, env: x.env, cwd: x.cwd });
    const a = args.filter((v, i) => !(v === "-c" || args[i - 1] === "-c"));
    if (a[0] === "clone") mkdirSync(join(a[2], ".git"), { recursive: true });
    if (a[0] === "diff" && a[1] === "--cached") return { code: o.dirty ? 1 : 0, out: "" };
    if (a[0] === "diff" && a[1] === "--name-only") return { code: 0, out: o.conflict.join("\n") };
    if (a[0] === "pull") return o.pull;
    if (a[0] === "push") return o.push;
    return { code: 0, out: "" };
  };
  const cmds = () => calls.map((c) => c.args.filter((v, i) => !(v === "-c" || c.args[i - 1] === "-c")).join(" "));
  return { git, calls, o, cmds };
}

/** Поддельный git с ручками: fail — команда и её ответ, hold — команда ждёт release(). */
function gitWith(o: { fail?: Record<string, { code: number; out: string } | "throw">; hold?: string } = {}) {
  const g = fakeGit();
  g.o.dirty = false;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const git: Git = async (args, x) => {
    const a = args.filter((v, i) => !(v === "-c" || args[i - 1] === "-c"));
    const f = o.fail?.[a[0]];
    if (f === "throw") throw new Error(`git ${a[0]} упал`);
    if (f) {
      g.calls.push({ args, env: x.env, cwd: x.cwd });
      return f;
    }
    if (o.hold === a[0]) {
      g.calls.push({ args, env: x.env, cwd: x.cwd });
      await held;
      return { code: 0, out: "" };
    }
    return g.git(args, x);
  };
  return { ...g, git, release, opts: o };
}

const TOKEN: Answer = { ok: true, result: { token: "ghs_SECRET123", expires: "2030" } };
/** Настройки флота стенда: repos null — ключа нет; down — слово отказа вместо ответа. */
let fleet: { repos: string[] | null; down: string | null };

/** Поддельные участники: github отвечает на токен, настройки флота — на чтение ключа. */
function services(s: Stand, token: () => Answer = () => TOKEN) {
  const seen: Frame[] = [];
  const prefs = (f: Frame) =>
    queueMicrotask(() =>
      s.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ...(fleet.down ? { ok: false, error: fleet.down } : { ok: true, result: { values: fleet.repos ? { [KEY]: fleet.repos } : {} } }) } as Frame),
    );
  for (const f of s.relay.frames("prefs.get")) prefs(f as Frame);
  const recv = s.relay.receive.bind(s.relay);
  s.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const f = JSON.parse(text) as Frame;
    if (f.type === "prefs.get") prefs(f);
    if (f.type !== "github.token") return;
    seen.push(f);
    queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "github", ...token() } as Frame));
  };
  return seen;
}

async function bench(o: { git: Git; manage?: Module; extra?: Array<{ manifest: Manifest; module: Module }>; token?: () => Answer }) {
  const mod = make({ git: o.git });
  st = await standHost({
    home,
    modules: [{ manifest: manifest as Manifest, module: mod }, ...(o.extra ?? []), module("host-manage", o.manage ?? {}, { uses: { "session.profile@host-profiles": 2 } })],
  });
  const open = st.open.bind(st);
  st.open = (cs, oo = {}) => open(cs, { ...oo, ...(chosen.has(cs) ? { opening: { profile: chosen.get(cs) } } : {}) });
  const seen = services(st, o.token);
  return { st, mod, seen };
}

/** Список следующего открытия этой сессии: st.open стенда передаст его запросом открытия. */
const chosen = new Map<string, string[]>();
const pick = (callsign: string, ...list: string[]) => chosen.set(callsign, list);

const ask = async (f: Record<string, unknown>) => (await st!.relay.request({ v: 2, machine: "laptop", ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string; why?: string };
const last = (cs: string) => st!.states(cs).at(-1)!;
const options = (cs: string) => st!.query(cs).options as Record<string, any>;
const sync = () => ask({ type: "machine.profiles", sync: true });
/** Репозитории в списке флота и уже сведены; вызовы git этого сведения стёрты. */
async function known(g: { calls: unknown[] }, ...repos: string[]) {
  fleet.repos = repos.length ? repos : [REPO];
  await sync();
  g.calls.length = 0;
}
const restarted = (cs: string, n = 2) => until(() => st!.holders.spawns.filter((x) => x.id === cs).length === n && st!.holders.procs.get(cs)?.initializes === 1);

describe("эталоны profiles", () => {
  it("172 · кусочек ops: инструкции дополнительной папкой, настройки из settings.json и своя папка памяти; модель клиента — опцией manage", async () => {
    repo();
    await bench({ git: fakeGit().git, manage: { session: (s) => (s.info.callsign === "two@laptop" ? { model: "sonnet" } : undefined) } });
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    const o = options("site@laptop");
    expect(o.systemPrompt.append).toBeUndefined();
    expect(o.additionalDirectories).toEqual([join(clone(), "ops")]);
    expect(o.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(o.settings).toEqual({ model: "opus", effortLevel: "high", autoMemoryDirectory: join(clone(), "ops", "memory") });
    expect(o.model).toBeUndefined();
    expect(Object.keys(o.hooks)).toEqual(["PostToolUse"]);
    pick("two@laptop", OPS);
    await st!.open("two@laptop");
    const o2 = options("two@laptop");
    expect(o2.model).toBe("sonnet");
    expect(o2.settings).toEqual(o.settings);
  });

  it("173 · две сессии в одной папке с разными профилями — разные пути памяти, не в ~/.claude/projects", async () => {
    repo();
    await bench({ git: fakeGit().git });
    const cwd = join(home, "Projects", "site");
    pick("site@laptop", OPS);
    pick("review@laptop", WRITER);
    await st!.open("site@laptop", { cwd });
    await st!.open("review@laptop", { cwd });
    const a = options("site@laptop").settings.autoMemoryDirectory;
    const b = options("review@laptop").settings.autoMemoryDirectory;
    expect(a).toBe(join(clone(), "ops", "memory"));
    expect(b).toBe(join(clone(), "writer", "memory"));
    for (const p of [a, b]) expect(p).not.toContain(join(".claude", "projects"));
  });

  it("174 · запись в клон: хук отвечает {} сразу; add всего клона, commit, один github.token, pull, push — токен в окружении; по часам — без commit", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    repo();
    const g = fakeGit();
    const { seen } = await bench({ git: g.git });
    await known(g);
    seen.length = 0;
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    const out = await st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(clone(), "ops", "memory", "testing.md") } });
    expect(out).toEqual([{}]);
    await until(() => g.cmds().includes("push"));
    expect(g.cmds()).toEqual(["add -A", "diff --cached --quiet", expect.stringMatching(/^commit -m сведение: laptop \d\d:\d\d$/), "pull --no-rebase --no-edit", "push"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ to: ".github", repo: REPO });
    for (const c of g.calls) {
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.args.slice(0, 2)).toEqual(["-c", "credential.interactive=never"]);
      expect(c.args.join(" ")).not.toContain("ghs_SECRET123");
    }
    const header = `Authorization: basic ${Buffer.from("x-access-token:ghs_SECRET123").toString("base64")}`;
    for (const c of g.calls.filter((c) => c.args.includes("pull") || c.args.includes("push"))) {
      expect(c.env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader", GIT_CONFIG_VALUE_0: header });
    }
    expect(g.calls.filter((c) => c.args.includes("add") || c.args.includes("commit")).every((c) => !c.env.GIT_CONFIG_VALUE_0)).toBe(true);
    expect((await ask({ type: "machine.profiles" })).result.repos[REPO].state).toBe("ok");
    // по часам: нового нет — те же вызовы без commit
    g.calls.length = 0;
    g.o.dirty = false;
    vi.advanceTimersByTime(SYNC_MS);
    await until(() => g.cmds().includes("push"));
    expect(g.cmds()).toEqual(["add -A", "diff --cached --quiet", "pull --no-rebase --no-edit", "push"]);
    expect(JSON.stringify(st!.journal())).not.toContain("ghs_SECRET123");
  });

  it("176 · кусочек читается на каждом старте: новая настройка — со следующего старта, до него query() не пересобран", async () => {
    repo();
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS);
    const s = await st!.open("site@laptop");
    writeFileSync(join(clone(), "ops", "settings.json"), JSON.stringify({ model: "sonnet" }));
    fleet.repos = [REPO];
    await sync();
    expect(st!.sdk.of("site@laptop")).toHaveLength(1);
    await s.restart();
    expect(st!.sdk.of("site@laptop")).toHaveLength(2);
    expect(options("site@laptop").settings.model).toBe("sonnet");
  });

  it("8001 · два кусочка со скилами — два плагина в запуске", async () => {
    piece(OPS, skill("deploy"));
    piece(WRITER, skill("edit"));
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS, WRITER);
    await st!.open("site@laptop");
    await st!.open("wiki@laptop");
    expect(options("site@laptop").plugins).toEqual([
      { type: "local", path: join(clone(), "ops") },
      { type: "local", path: join(clone(), "writer") },
    ]);
    expect(options("wiki@laptop").plugins).toBeUndefined();
  });

  it("8002 · две папки ops из разных репозиториев; name манифеста, равный имени другой папки — bad_profile, процесс не стартовал", async () => {
    piece(OPS);
    piece("beta/p/ops");
    piece(WRITER, plugin({ name: "ops" }));
    await bench({ git: fakeGit().git });
    pick("a@laptop", OPS, "beta/p/ops");
    await expect(st!.open("a@laptop")).rejects.toMatchObject({ word: "bad_profile" });
    pick("b@laptop", OPS, WRITER);
    await expect(st!.open("b@laptop")).rejects.toMatchObject({ word: "bad_profile" });
    expect(st!.sdk.of("a@laptop")).toHaveLength(0);
    expect(st!.sdk.of("b@laptop")).toHaveLength(0);
  });

  it("8003 · инструкции и правила двух кусочков — дополнительными папками с чтением CLAUDE.md; кусочек без них папкой не идёт", async () => {
    piece(OPS, { "CLAUDE.md": "ops" });
    piece(WRITER, { ".claude/rules/style.md": "правило" });
    piece(`${REPO}/tools`, skill("x"));
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS, WRITER, `${REPO}/tools`);
    await st!.open("site@laptop");
    const o = options("site@laptop");
    expect(o.additionalDirectories).toEqual([join(clone(), "ops"), join(clone(), "writer")]);
    expect(o.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(o.systemPrompt.append).toBeUndefined();
    pick("bare@laptop", `${REPO}/tools`);
    await st!.open("bare@laptop");
    expect(options("bare@laptop").additionalDirectories).toBeUndefined();
    expect(options("bare@laptop").env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeUndefined();
  });

  it("8004 · одна настройка и переменная в двух кусочках — значение нижнего", async () => {
    piece(OPS, { "settings.json": JSON.stringify({ model: "opus", env: { MY: "верхний" } }) });
    piece(WRITER, { "settings.json": JSON.stringify({ model: "haiku", env: { MY: "нижний" } }) });
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS, WRITER);
    await st!.open("site@laptop");
    expect(options("site@laptop").settings.model).toBe("haiku");
    expect(options("site@laptop").env.MY).toBe("нижний");
  });

  it("8005 · манифест: description — подпись в списке машины, name — имя плагина; без name — bad_profile; кусочек — любая папка", async () => {
    const ops = piece(OPS, { ...plugin({ name: "beta-ops", description: "серверы команды" }), ...skill("restart") });
    piece(WRITER, plugin({ description: "без имени" }));
    piece(`${REPO}/empty`);
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g);
    const r = await ask({ type: "machine.profiles" });
    expect(r.result.profiles[OPS]).toEqual({ about: "серверы команды", kind: "piece", names: [{ kind: "skill", name: "restart", path: "skills/restart/SKILL.md" }] });
    expect(r.result.profiles[`${REPO}/empty`]).toEqual({ kind: "piece", names: [] });
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    expect(options("site@laptop").plugins).toEqual([{ type: "local", path: ops }]);
    pick("bad@laptop", WRITER);
    await expect(st!.open("bad@laptop")).rejects.toMatchObject({ word: "bad_profile" });
  });

  it("8006 · три кусочка, у двух память: домашняя — нижняя; индекс второй с её путём в промпте, в пределах Claude", async () => {
    const long = Array.from({ length: 300 }, (_, i) => `строка ${i}`).join("\n");
    piece(OPS, { "memory/MEMORY.md": long });
    piece(WRITER, { "memory/MEMORY.md": "- домашний индекс" });
    piece(`${REPO}/tools`, skill("x"));
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS, WRITER, `${REPO}/tools`);
    await st!.open("site@laptop");
    const o = options("site@laptop");
    expect(o.settings.autoMemoryDirectory).toBe(join(clone(), "writer", "memory"));
    const append = o.systemPrompt.append as string;
    expect(append).toContain(join(clone(), "ops", "memory"));
    expect(append).toContain("строка 199");
    expect(append).not.toContain("строка 200");
    expect(append).not.toContain("домашний индекс");
  });

  it("8007 · запись в память не домашнего кусочка из другого репозитория — сведение у его репозитория", async () => {
    piece(OPS, { "memory/MEMORY.md": "- a" });
    piece("beta/p/lib", { "memory/MEMORY.md": "- b" });
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g, REPO, "beta/p");
    pick("site@laptop", "beta/p/lib", OPS);
    await st!.open("site@laptop");
    await st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: join(clone("beta/p"), "lib", "memory", "x.md") } });
    await until(() => g.cmds().includes("push"));
    expect(new Set(g.calls.map((c) => c.cwd))).toEqual(new Set([clone("beta/p")]));
  });

  it("8008 · кусочек с провайдером: отказ на открытии; появился в git — сессия поднята без кусочков, state error, список заменяется без перезапуска системы, другая сессия работает", async () => {
    for (const bad of [{ env: { ANTHROPIC_BASE_URL: "https://x" } }, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, { apiKeyHelper: "cat k" }, { autoMemoryDirectory: "/tmp" }, { env: { CLAUDE_CONFIG_DIR: "/tmp" } }]) {
      const id = `${REPO}/bad${JSON.stringify(bad).length}`;
      piece(id, { "settings.json": JSON.stringify(bad) });
      if (!st) await bench({ git: fakeGit().git });
      pick("no@laptop", id);
      await expect(st!.open("no@laptop")).rejects.toMatchObject({ word: "bad_profile" });
    }
    repo();
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    pick("other@laptop", WRITER);
    await st!.open("other@laptop");
    writeFileSync(join(clone(), "ops", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x" } }));
    await st!.close();
    st = null;
    await bench({ git: fakeGit().git });
    await until(() => st!.kernel.sessions.get("site@laptop")?.state === "idle");
    expect(options("site@laptop").plugins).toBeUndefined();
    expect(options("other@laptop").plugins).toEqual([{ type: "local", path: join(clone(), "writer") }]);
    expect(st!.journal().some((l) => l.ev === "profile" && l.kind === "stop" && l.word === "bad_profile" && String(l.why).includes("сессия без кусочков"))).toBe(true);
    st!.proc("site@laptop").send(stand.msg.state("idle"));
    await until(() => JSON.stringify(last("site@laptop").profile) === JSON.stringify([{ id: OPS, state: "error" }]));
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: [WRITER] })).result).toEqual({ restart: true });
    await restarted("site@laptop");
    expect(options("site@laptop").plugins).toEqual([{ type: "local", path: join(clone(), "writer") }]);
  });

  const account = (name: string, env: Record<string, string>, settings: Record<string, unknown>) => ({ manifest: { name, type: "sdk", version: "1.0.0", provides: {}, uses: { "host.module@host": 1 }, config: {}, into: ["host"] } as Manifest, module: { session: () => ({ defaults: { tier: "account" as const, env, settings } }) } });

  it("8009 · env и настройка совпали у модуля, ключа флота и кусочка: сильнее модуль, затем ключ; данные системы не роняют, отброшенное в журнале; два модуля с одним ключом не дают старта", async () => {
    piece(OPS, { "settings.json": JSON.stringify({ a: "кусочек", b: "кусочек", c: "кусочек", env: { X: "кусочек", Y: "кусочек" } }) });
    const own = module("host-own", { session: () => ({ env: { X: "модуль" }, settings: { a: "модуль" } }) });
    await bench({ git: fakeGit().git, extra: [own, account("host-key", { X: "ключ", Y: "ключ" }, { a: "ключ", b: "ключ" })] });
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    const o = options("site@laptop");
    expect(o.env.X).toBe("модуль");
    expect(o.env.Y).toBe("ключ");
    expect(o.settings).toMatchObject({ a: "модуль", b: "ключ", c: "кусочек" });
    const line = st!.journal().find((l) => l.ev === "session.defaults");
    expect(line?.why).toContain("env X: значение host-key уступило host-own");
    expect(line?.why).toContain("settings b: значение host-profiles уступило host-key");
    await st!.close();
    st = null;
    await bench({ git: fakeGit().git, extra: [own, account("host-key", { X: "ключ", Y: "ключ" }, { a: "ключ", b: "ключ" })] });
    await until(() => st!.kernel.sessions.get("site@laptop")?.state === "idle");
    expect(options("site@laptop").env.Y).toBe("ключ");
    await st!.close();
    st = null;
    home = mkdtempSync(join(tmpdir(), "sb-profiles-"));
    process.env.SWITCHBOARD_HOME = home;
    chosen.clear();
    await bench({ git: fakeGit().git, extra: [module("host-a", { session: () => ({ env: { Z: "a" } }) }), module("host-b", { session: () => ({ env: { Z: "b" } }) })] });
    await expect(st!.open("site@laptop")).rejects.toThrow("env Z: два владельца");
  });

  it("8013 · штатная остановка во время сведения двух репозиториев — дождалась обоих, вышла", async () => {
    piece(OPS);
    piece("beta/p/lib");
    const g = gitWith();
    await bench({ git: g.git });
    await known(g, REPO, "beta/p");
    g.opts.hold = "push";
    void sync();
    await until(() => g.cmds().filter((c) => c === "push").length === 2);
    const s = st!;
    st = null;
    let closed = false;
    const c = s.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(false);
    g.release();
    await c;
    expect(closed).toBe(true);
  });

  it("8014 · набор с вложенным набором и повтором — плоский список, первые вхождения, набор после своего состава; правка в git — новый состав на старте; кольцо — bad_profile", async () => {
    const [a, b, c, inner, outer] = ["a", "b", "c", "inner", "outer"].map((n) => `${REPO}/${n}`);
    for (const id of [a, b, c]) piece(id);
    piece(inner, plugin({ name: "inner", metadata: { use: [a, b] } }));
    const outerDir = piece(outer, plugin({ name: "outer", metadata: { use: [inner, a, c] } }));
    await bench({ git: fakeGit().git });
    pick("site@laptop", outer, b);
    const s = await st!.open("site@laptop");
    const paths = () => options("site@laptop").plugins.map((p: { path: string }) => p.path.slice(clone().length + 1));
    expect(paths()).toEqual(["a", "b", "inner", "c", "outer"]);
    expect(last("site@laptop").profile).toEqual([{ id: outer, state: "ok" }, { id: b, state: "ok" }]);
    writeFileSync(join(outerDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "outer", metadata: { use: [c] } }));
    await s.restart();
    expect(paths()).toEqual(["c", "outer", "b"]);
    const [x, y] = [`${REPO}/x`, `${REPO}/y`];
    piece(x, plugin({ name: "x", metadata: { use: [y] } }));
    piece(y, plugin({ name: "y", metadata: { use: [x] } }));
    pick("ring@laptop", x);
    await expect(st!.open("ring@laptop")).rejects.toMatchObject({ word: "bad_profile" });
  });

  it("8015 · набор с metadata.use и скилом — сам тоже плагин; в списке машины kind set и состав", async () => {
    piece(OPS);
    const set = `${REPO}/dev`;
    const dir = piece(set, { ...plugin({ name: "dev", description: "моя работа", metadata: { use: [OPS] } }), ...skill("own") });
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g);
    pick("site@laptop", set);
    await st!.open("site@laptop");
    expect(options("site@laptop").plugins).toEqual([{ type: "local", path: join(clone(), "ops") }, { type: "local", path: dir }]);
    const p = (await ask({ type: "machine.profiles" })).result.profiles[set];
    expect(p).toMatchObject({ kind: "set", use: [OPS], about: "моя работа" });
  });

  it("8016 · репозиторий добавлен в список, сведение по кнопке — клон на машине, его кусочки в списке машины", async () => {
    const g = fakeGit();
    await bench({ git: g.git });
    expect((await sync()).result).toEqual({ profiles: {}, repos: {} });
    fleet.repos = [REPO];
    const r = await sync();
    expect(g.cmds()).toEqual([`clone https://github.com/${REPO}.git ${clone()}`]);
    expect(g.calls[0].env.GIT_CONFIG_VALUE_0).toContain("basic ");
    expect(r.result.repos[REPO]).toMatchObject({ state: "ok", dir: clone() });
    expect(r.result.repos[REPO].at).toEqual(expect.any(Number));
    piece(OPS);
    expect((await ask({ type: "machine.profiles" })).result.profiles[OPS]).toEqual({ kind: "piece", names: [] });
  });

  it("8017 · репозиторий убран из списка: правка отправлена, клон удалён; push отвергнут — клон остаётся, state error с причиной", async () => {
    repo();
    piece("beta/p/lib");
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g, REPO, "beta/p");
    fleet.repos = ["beta/p"];
    g.o.push = { code: 1, out: "rejected" };
    let r = await sync();
    expect(existsSync(clone())).toBe(true);
    expect(r.result.repos[REPO]).toBeUndefined();
    expect(st!.journal().some((l) => l.ev === "sync" && l.word === "error" && String(l.why).includes("rejected"))).toBe(true);
    g.o.push = { code: 0, out: "" };
    g.calls.length = 0;
    r = await sync();
    expect(g.calls.filter((c) => c.cwd === clone()).map((c) => c.args.at(-1))).toContain("push");
    expect(existsSync(clone())).toBe(false);
    expect(existsSync(clone("beta/p"))).toBe(true);
    expect(Object.keys(r.result.repos)).toEqual(["beta/p"]);
    expect(st!.journal().some((l) => l.ev === "sync" && l.why === `${REPO}: убран из списка — клон удалён`)).toBe(true);
  });

  it("8018 · репозиторий не доступен приложению GitHub: сетевого git нет, state error со словом приложения, ссылки установки в ответе нет; токен выдан — ok", async () => {
    repo();
    const g = fakeGit();
    let answer: Answer = { ok: false, error: "not_installed" };
    await bench({ git: g.git, token: () => answer });
    fleet.repos = [REPO];
    const r = await sync();
    expect(r.result.repos[REPO]).toMatchObject({ state: "error", op: "github.token", error: "not_installed" });
    expect(JSON.stringify(r.result)).not.toContain("install_url");
    expect(g.cmds().filter((c) => /^(pull|push|clone)/.test(c))).toEqual([]);
    answer = TOKEN;
    const ok = await sync();
    expect(ok.result.repos[REPO].state).toBe("ok");
    expect(g.cmds()).toContain("push");
  });

  it("8019 · настройки флота не ответили на сведении — пропущено с причиной, ни один клон не удалён", async () => {
    repo();
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g);
    fleet.down = "offline";
    await sync();
    expect(g.calls).toEqual([]);
    expect(existsSync(clone())).toBe(true);
    expect(st!.journal().some((l) => l.ev === "sync" && l.word === "offline" && String(l.why).includes("настройки флота не ответили"))).toBe(true);
  });

  it("8020 · конфликт при сведении, три сессии с кусочками: state conflict, files и dir в ответе; заданий о конфликте в запросах сессий нет", async () => {
    repo();
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g);
    g.o.pull = { code: 1, out: "CONFLICT (content): Merge conflict in ops/memory/testing.md\nAutomatic merge failed; fix conflicts and then commit." };
    for (const cs of ["a@laptop", "b@laptop", "c@laptop"]) {
      pick(cs, OPS);
      await st!.open(cs);
    }
    const r = await sync();
    expect(r.result.repos[REPO]).toMatchObject({ state: "conflict", op: "git pull --no-rebase", files: ["ops/memory/testing.md"], dir: clone() });
    for (const cs of ["a@laptop", "b@laptop", "c@laptop"]) {
      expect(st!.proc(cs).hookEvents).toEqual(["PostToolUse"]);
      expect(st!.proc(cs).env.SWITCHBOARD_PROFILE).toBeUndefined();
    }
  });

  it("8024 · ключа fleet.profiles.repos нет, в клонах три репозитория — сведение пропущено, причина в журнале, клоны на месте; кусочки на подъёме находятся по диску", async () => {
    piece(OPS);
    piece("beta/p/lib");
    piece("alpha/p/x");
    const g = fakeGit();
    await bench({ git: g.git });
    await sync();
    expect(g.calls).toEqual([]);
    for (const r of [REPO, "beta/p", "alpha/p"]) expect(existsSync(clone(r))).toBe(true);
    expect(st!.journal().some((l) => l.ev === "sync" && l.word === "no_repos" && String(l.why).includes(PROFILE_REPOS))).toBe(true);
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    expect(options("site@laptop").plugins).toHaveLength(1);
  });

  it("8025 · экран убирает один из трёх циклом записей: в ключе два оставшихся, клоны этих двух не удалены", async () => {
    piece(OPS);
    piece("beta/p/lib");
    piece("alpha/p/x");
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g, REPO, "beta/p", "alpha/p");
    const written: unknown[] = [];
    const page = settings({
      read: (async () => ({ ok: true, result: { values: { [KEY]: fleet.repos } } })) as never,
      ask: (async (_: string, b: { value: string[] }) => {
        written.push(b.value);
        fleet.repos = b.value;
        return { ok: true, result: {} };
      }) as never,
      prefix: FLEET_PREFIX,
      scope: "global",
    });
    await page.edit<string[]>(PROFILE_REPOS, (old) => (old ?? []).filter((r) => r !== "alpha/p"));
    expect(written).toEqual([[REPO, "beta/p"]]);
    await sync();
    expect(existsSync(clone("alpha/p"))).toBe(false);
    expect(existsSync(clone())).toBe(true);
    expect(existsSync(clone("beta/p"))).toBe(true);
  });

  /** Настоящий git: общий репозиторий, клон машины и клон второй машины. */
  function realRepo() {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const bare = join(home, "origin.git");
    git(home, "init", "--bare", "-b", "main", bare);
    const other = join(home, "other");
    git(home, "clone", bare, other);
    mkdirSync(join(other, "ops", "memory"), { recursive: true });
    writeFileSync(join(other, "ops", "memory", "note.md"), "исходное\n");
    git(other, "add", "-A");
    git(other, "commit", "-m", "начало");
    git(other, "push", "origin", "HEAD:main");
    mkdirSync(join(home, "profiles"), { recursive: true });
    git(home, "clone", bare, clone());
    for (const dir of [other, clone()]) {
      git(dir, "config", "user.name", "t");
      git(dir, "config", "user.email", "t@t");
    }
    return { git, bare, other };
  }
  const log = (r: ReturnType<typeof realRepo>) => r.git(r.bare, "log", "--all", "--format=%s");
  const realFor = async (r: ReturnType<typeof realRepo>) => {
    await bench({ git: realGit });
    fleet.repos = [REPO];
    return r;
  };

  it("8030 · в клоне новая папка со стилем и правка агента, сессия их не коммитила — сведение отправило обе правки; .gitignore соблюдён", async () => {
    const r = realRepo();
    await realFor(r);
    mkdirSync(join(clone(), "ops", "agents"), { recursive: true });
    mkdirSync(join(clone(), "fresh", "output-styles"), { recursive: true });
    writeFileSync(join(clone(), "ops", "agents", "x.md"), "агент");
    writeFileSync(join(clone(), "fresh", "output-styles", "terse.md"), "стиль");
    writeFileSync(join(clone(), ".gitignore"), "*.tmp\n");
    writeFileSync(join(clone(), "ops", "junk.tmp"), "мусор");
    expect((await sync()).result.repos[REPO].state).toBe("ok");
    r.git(r.other, "pull", "--no-rebase");
    expect(readFileSync(join(r.other, "ops", "agents", "x.md"), "utf8")).toBe("агент");
    expect(readFileSync(join(r.other, "fresh", "output-styles", "terse.md"), "utf8")).toBe("стиль");
    expect(existsSync(join(r.other, "ops", "junk.tmp"))).toBe(false);
  });

  it("8037 · конфликт, два такта, репозиторий убран: коммитов, pull и push нет, state conflict, клон на месте; сессия закоммитила слияние — следующий такт отправил, state ok", async () => {
    const r = realRepo();
    await realFor(r);
    writeFileSync(join(r.other, "ops", "memory", "note.md"), "с другой машины\n");
    r.git(r.other, "add", "-A");
    r.git(r.other, "commit", "-m", "другая машина");
    r.git(r.other, "push", "origin", "HEAD:main");
    writeFileSync(join(clone(), "ops", "memory", "note.md"), "с этой машины\n");
    const first = await sync();
    expect(first.result.repos[REPO]).toMatchObject({ state: "conflict", files: ["ops/memory/note.md"], dir: clone() });
    const before = log(r);
    for (let i = 0; i < 2; i++) {
      const next = await sync();
      expect(next.result.repos[REPO]).toMatchObject({ state: "conflict", files: ["ops/memory/note.md"] });
    }
    expect(log(r)).toBe(before);
    expect(readFileSync(join(clone(), "ops", "memory", "note.md"), "utf8")).toContain("<<<<<<<");
    fleet.repos = [];
    await sync();
    expect(existsSync(clone())).toBe(true);
    expect(log(r)).toBe(before);
    fleet.repos = [REPO];
    writeFileSync(join(clone(), "ops", "memory", "note.md"), "обе версии\n");
    r.git(clone(), "add", "-A");
    r.git(clone(), "commit", "-m", "сведено");
    expect((await sync()).result.repos[REPO].state).toBe("ok");
    expect(r.git(r.bare, "show", "main:ops/memory/note.md")).toBe("обе версии\n");
  });

  it("8034 · defaults кусочка и ключа флота, порядок модулей в сборке обратный — значение ключа выигрывает", async () => {
    piece(OPS, { "settings.json": JSON.stringify({ a: "кусочек", env: { Y: "кусочек" } }) });
    const mod = make({ git: fakeGit().git });
    st = await standHost({ home, modules: [{ manifest: manifest as Manifest, module: mod }, account("host-key", { Y: "ключ" }, { a: "ключ" }), module("host-manage", {}, { uses: { "session.profile@host-profiles": 2 } })] });
    const open = st.open.bind(st);
    await open("site@laptop", { opening: { profile: [OPS] } });
    expect(options("site@laptop").env.Y).toBe("ключ");
    expect(options("site@laptop").settings.a).toBe("ключ");
    await st.close();
    st = await standHost({ home, modules: [account("host-key", { Y: "ключ" }, { a: "ключ" }), { manifest: manifest as Manifest, module: make({ git: fakeGit().git }) }, module("host-manage", {}, { uses: { "session.profile@host-profiles": 2 } })] });
    await st.open("two@laptop", { opening: { profile: [OPS] } });
    expect(options("two@laptop").env.Y).toBe("ключ");
    expect(options("two@laptop").settings.a).toBe("ключ");
  });
});

describe("profiles: ветки и стыки", () => {
  it("session.profile живой сессии — restart; no_profile; без профиля — частей нет", async () => {
    repo();
    await bench({ git: fakeGit().git });
    await st!.open("site@laptop");
    expect(options("site@laptop").settings).toBeUndefined();
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: [`${REPO}/nope`] })).error).toBe("no_profile");
    const r = await ask({ type: "session.profile", callsign: "site@laptop", profile: [OPS] });
    expect(r.result).toEqual({ restart: true });
    await restarted("site@laptop");
    expect(options("site@laptop").settings?.model).toBe("opus");
    expect(st!.proc("site@laptop").hookEvents).toContain("PostToolUse");
  });

  it("запись вне клонов кусочков — сведения нет", async () => {
    repo();
    const g = fakeGit();
    await bench({ git: g.git });
    await known(g);
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    await st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(home, "Projects", "x.md") } });
    await new Promise((r) => setTimeout(r, 30));
    expect(g.calls).toHaveLength(0);
  });

  it("список не списком — bad_frame и на открытии, и в session.profile", async () => {
    repo();
    await bench({ git: fakeGit().git });
    chosen.set("site@laptop", OPS as never);
    await expect(st!.open("site@laptop")).rejects.toMatchObject({ word: "bad_frame" });
    await st!.open("wiki@laptop");
    expect((await ask({ type: "session.profile", callsign: "wiki@laptop", profile: OPS })).error).toBe("bad_frame");
    expect((await ask({ type: "session.profile", callsign: "wiki@laptop", profile: null })).error).toBe("bad_frame");
  });
});

describe("profiles: покрытие плана host-modules", () => {
  it("3056 · session.profile: тот же список — без перезапуска; пустой — профиль снят, restart без части", async () => {
    // источник: чьё: код
    repo();
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: [OPS] })).result).toEqual({ restart: false });
    expect(st!.sdk.of("site@laptop")).toHaveLength(1);
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: [] })).result).toEqual({ restart: true });
    await restarted("site@laptop");
    expect(options("site@laptop").plugins).toBeUndefined();
    await until(() => last("site@laptop").profile === undefined);
  });

  it("3057 · session.profile остановленной — без перезапуска, список со следующего старта", async () => {
    // источник: чьё: код
    repo();
    await bench({ git: fakeGit().git });
    const s = await st!.open("site@laptop");
    await s.stop();
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: [OPS] })).result).toEqual({ restart: false });
    await s.start();
    expect(options("site@laptop").plugins).toEqual([{ type: "local", path: join(clone(), "ops") }]);
  });

  it("3058 · session.profile занятой ходом — ответ сразу, перезапуск после хода", async () => {
    // источник: чьё: код (host/core: restart ждёт result)
    repo();
    await bench({ git: fakeGit().git });
    const s = await st!.open("site@laptop");
    const p = st!.proc("site@laptop");
    p.send(stand.msg.state("running"));
    await until(() => s.state === "busy");
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: [OPS] })).result).toEqual({ restart: true });
    expect(st!.sdk.of("site@laptop")).toHaveLength(1);
    expect(p.interrupts).toBe(0);
    p.send(stand.msg.result());
    p.send(stand.msg.state("idle"));
    await restarted("site@laptop");
    expect(options("site@laptop").plugins).toHaveLength(1);
  });

  it("3060 · machine.profiles: sync с отказом токена — ответ с причиной, не отказ", async () => {
    // источник: чьё: код
    repo();
    rmSync(join(clone(), ".git"), { recursive: true });
    await bench({ git: fakeGit().git, token: () => ({ ok: false, error: "not_installed" }) });
    fleet.repos = [REPO];
    const r = await sync();
    expect(r.ok).toBe(true);
    expect(r.result.profiles[WRITER]).toEqual({ kind: "piece", names: [] });
    expect(r.result.repos[REPO]).toMatchObject({ state: "error", op: "github.token", error: "not_installed" });
  });

  it("3061 · git упал на шаге — state error с этим шагом; push отказал — error", async () => {
    // источник: чьё: код
    const cases: Array<[string, Record<string, { code: number; out: string } | "throw">, boolean]> = [
      ["git clone", { clone: { code: 128, out: "fatal: нет доступа" } }, false],
      ["git add", { add: { code: 1, out: "add упал" } }, true],
      ["git pull --no-rebase", { pull: { code: 1, out: "fatal: сеть" } }, true],
      ["git push", { push: { code: 1, out: "rejected" } }, true],
      ["sync", { add: "throw" }, true],
    ];
    for (const [op, fail, hasClone] of cases) {
      home = mkdtempSync(join(tmpdir(), "sb-profiles-"));
      process.env.SWITCHBOARD_HOME = home;
      if (hasClone) repo();
      await bench({ git: gitWith({ fail }).git });
      fleet.repos = [REPO];
      const r = await sync();
      expect(r.result.repos[REPO], op).toMatchObject({ state: "error", op });
      expect(st!.journal().some((l) => l.ev === "sync" && l.kind === "stop" && l.word === "error"), op).toBe(true);
      await st!.close();
      st = null;
    }
  });

  it("3062 · запись посреди идущего сведения — следующее после него, не вперемешку", async () => {
    // источник: чьё: код
    repo();
    const g = gitWith();
    await bench({ git: g.git });
    await known(g);
    g.opts.hold = "push";
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    const write = (f: string) => st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(clone(), "ops", "memory", f) } });
    expect(await write("a.md")).toEqual([{}]);
    await until(() => g.cmds().includes("push"));
    expect(await write("b.md")).toEqual([{}]);
    await new Promise((r) => setTimeout(r, 20));
    expect(g.cmds().filter((c) => c.startsWith("add"))).toHaveLength(1);
    g.release();
    await until(() => g.cmds().filter((c) => c.startsWith("add")).length === 2);
    const c = g.cmds();
    expect(c.indexOf("push")).toBeLessThan(c.lastIndexOf("add -A"));
  });

  it("3064 · папки кусочка нет при старте — сессия без кусочков, поле state error, строка stop no_profile", async () => {
    // источник: чьё: код; устав «система ловит … пишет в журнал»
    repo();
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS);
    const s = await st!.open("site@laptop");
    rmSync(join(clone(), "ops"), { recursive: true });
    await s.stop();
    await s.start();
    expect(options("site@laptop").plugins).toBeUndefined();
    expect(st!.journal().some((l) => l.ev === "profile" && l.kind === "stop" && l.word === "no_profile")).toBe(true);
    s.input("x");
    stand.turn(st!.proc("site@laptop"));
    await until(() => JSON.stringify(last("site@laptop").profile) === JSON.stringify([{ id: OPS, state: "error" }]));
  });

  it("3065 · после перезапуска Host — список сессии из хранилища", async () => {
    // источник: слово пользователя (устав: «после перезапуска Host модуль поднимает своё из хранилища»)
    repo();
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    await st!.close();
    st = null;
    await bench({ git: fakeGit().git });
    await until(() => st!.kernel.sessions.get("site@laptop")?.state === "idle");
    expect(options("site@laptop").plugins).toEqual([{ type: "local", path: join(clone(), "ops") }]);
  });

  it("3066 · штатная остановка доводит идущее сведение, новое не начинает", async () => {
    // источник: слово пользователя (устав, graceful shutdown: «не принимает новое → доводит текущее»)
    repo();
    const g = gitWith();
    await bench({ git: g.git });
    await known(g);
    g.opts.hold = "push";
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    const write = (f: string) => st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(clone(), "ops", "memory", f) } });
    await write("a.md");
    await until(() => g.cmds().includes("push"));
    await write("b.md");
    const s = st!;
    st = null;
    let closed = false;
    const c = s.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(false);
    g.release();
    await c;
    expect(g.cmds().filter((x) => x.startsWith("add"))).toHaveLength(1);
  });

  it("3104 · machine.profiles до списка флота — пустые profiles и repos", async () => {
    // источник: чьё: код
    await bench({ git: fakeGit().git });
    expect(await ask({ type: "machine.profiles" })).toMatchObject({ ok: true, result: { profiles: {}, repos: {} } });
  });
});

describe("видимое: причины словами", () => {
  it("отказы и журнал называют кусочек; после свода — строка журнала", async () => {
    repo();
    const g = fakeGit();
    g.o.pull = { code: 1, out: "CONFLICT (content): Merge conflict in ops/memory/testing.md" };
    await bench({ git: g.git });
    fleet.repos = [REPO];
    await sync();
    expect(st!.journal().some((l) => l.ev === "sync" && l.word === "conflict" && l.why === `${REPO}: git pull --no-rebase — ops/memory/testing.md`)).toBe(true);
    g.o.pull = { code: 0, out: "ok" };
    await sync();
    expect(st!.journal().some((l) => l.ev === "sync" && l.why === `${REPO}: сведён`)).toBe(true);
    await st!.open("wiki@laptop");
    expect((await ask({ type: "session.profile", callsign: "wiki@laptop", profile: [`${REPO}/nope`] })).why).toBe(`${REPO}/nope: такой папки нет в клонах`);
    pick("site@laptop", OPS);
    const s = await st!.open("site@laptop");
    rmSync(join(clone(), "ops"), { recursive: true });
    await s.stop();
    await s.start();
    expect(st!.journal().some((l) => l.ev === "profile" && l.why === `${OPS}: такой папки нет в клонах — сессия без кусочков`)).toBe(true);
  });
});

describe("сверка строк: чего леса не держали", () => {
  it("хук записи — только на инструменты правки файлов", async () => {
    repo();
    await bench({ git: fakeGit().git });
    pick("site@laptop", OPS);
    await st!.open("site@laptop");
    const hooks = (st!.query("site@laptop").options as { hooks: Record<string, Array<{ matcher?: string }>> }).hooks;
    expect(hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
  });
});
