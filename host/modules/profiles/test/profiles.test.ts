// Эталоны и стыки модуля profiles на стенде Host: поддельные SDK, relay, keeper и часы;
// git — поддельный, пишет свои вызовы с окружением; github — поддельный участник рации. Номер эталона — номер теста.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, parseYaml, SYNC_MS } from "../src/profiles.ts";
import type { Git } from "../src/profiles.ts";

const { module, standHost, until } = stand;
type Stand = stand.Stand;

let st: Stand | null = null;
let home = "";
const saved = { ...process.env };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-profiles-"));
  process.env.SWITCHBOARD_HOME = home;
});
afterEach(async () => {
  await st?.close();
  st = null;
  vi.useRealTimers();
  process.env = { ...saved };
});

const clone = () => join(home, "profiles", "team__profiles");
const OPS = "team/profiles/ops";

/** Клон team/profiles на машине: ops и writer. */
function repo(ops = "Ты ведёшь эксплуатацию.") {
  mkdirSync(join(clone(), ".git"), { recursive: true });
  mkdirSync(join(clone(), "ops", "memory"), { recursive: true });
  mkdirSync(join(clone(), "writer", "memory"), { recursive: true });
  writeFileSync(join(clone(), "ops", "CLAUDE.md"), ops);
  writeFileSync(join(clone(), "ops", "profile.yaml"), "model: opus\neffort: high\nmax_effort: xhigh\nfallback_model: [sonnet]\n");
  writeFileSync(join(clone(), "writer", "CLAUDE.md"), "Ты пишешь тексты.");
}

type GitCall = { args: string[]; env: Record<string, string>; cwd: string };

/** Поддельный git: ответы по команде, все вызовы с окружением. */
function fakeGit() {
  const calls: GitCall[] = [];
  const o = { dirty: true, pull: { code: 0, out: "Already up to date." }, conflict: ["ops/memory/testing.md"] };
  const git: Git = async (args, x) => {
    calls.push({ args, env: x.env, cwd: x.cwd });
    const a = args.filter((v, i) => !(v === "-c" || args[i - 1] === "-c"));
    if (a[0] === "diff" && a[1] === "--cached") return { code: o.dirty ? 1 : 0, out: "" };
    if (a[0] === "diff" && a[1] === "--name-only") return { code: 0, out: o.conflict.join("\n") };
    if (a[0] === "pull") return o.pull;
    if (a[0] === "log") return { code: 0, out: "память: laptop 14:02" };
    return { code: 0, out: "" };
  };
  const cmds = () => calls.map((c) => c.args.filter((v, i) => !(v === "-c" || c.args[i - 1] === "-c")).join(" "));
  return { git, calls, o, cmds };
}

/** Поддельный github: отвечает на github.token, считает запросы. */
function github(s: Stand, answer: () => { ok: true; result: unknown } | { ok: false; error: string }) {
  const seen: Frame[] = [];
  const recv = s.relay.receive.bind(s.relay);
  s.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const f = JSON.parse(text) as Frame;
    if (f.type !== "github.token") return;
    seen.push(f);
    queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "github", ...answer() } as Frame));
  };
  return seen;
}

const TOKEN = { ok: true as const, result: { token: "ghs_SECRET123", expires_at: "2026-10-31T13:02:11Z" } };

async function bench(o: { git: Git; manage?: Module }) {
  const mod = make({ git: o.git });
  st = await standHost({
    home,
    config: { modules: { "host-profiles": { repos: ["team/profiles"] } } },
    modules: [
      { manifest: manifest as Manifest, module: mod },
      module("host-manage", o.manage ?? {}, { uses: { "session.profile@host-profiles": 1 } }),
    ],
  });
  return { st, mod };
}

/** session.profile до открытия сессии: ядро сейчас отвечает offline на запрос к сессии, которой нет, — зовём обработчик модуля. */
async function preOpen(mod: Module, callsign: string, profile: string | null) {
  const ctx = { host: st!.host("host-profiles"), from: "@laptop", signal: new AbortController().signal };
  return mod.requests!["session.profile"]({ type: "session.profile", v: 1, callsign, profile }, ctx);
}

const ask = async (f: Record<string, unknown>) => (await st!.relay.request({ v: 1, machine: "laptop", ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string };
const last = (cs: string) => st!.states(cs).at(-1)!;

describe("эталоны profiles", () => {
  it("172 · профиль ops: append из CLAUDE.md, settings из profile.yaml и свой путь памяти; модель клиента — опцией manage", async () => {
    repo();
    const { mod } = await bench({ git: fakeGit().git, manage: { session: (s) => (s.info.callsign === "two@laptop" ? { model: "sonnet" } : undefined) } });
    expect(await preOpen(mod, "site@laptop", OPS)).toEqual({ restart: false });
    await st!.open("site@laptop");
    const o = st!.query("site@laptop").options as Record<string, any>;
    expect(o.systemPrompt.append).toContain("Ты ведёшь эксплуатацию.");
    expect(o.settings).toEqual({
      model: "opus",
      effortLevel: "high",
      maxEffortLevel: "xhigh",
      fallbackModel: ["sonnet"],
      autoMemoryDirectory: join(clone(), "ops", "memory"),
    });
    expect(o.model).toBeUndefined();
    expect(Object.keys(o.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "UserPromptSubmit"]);
    // второй прогон: модель в запросе — опция manage, часть profiles та же
    await preOpen(mod, "two@laptop", OPS);
    await st!.open("two@laptop");
    const o2 = st!.query("two@laptop").options as Record<string, any>;
    expect(o2.model).toBe("sonnet");
    expect(o2.settings).toEqual(o.settings);
  });

  it("173 · две сессии в одной папке с разными профилями — разные пути памяти, не в ~/.claude/projects", async () => {
    repo();
    const { mod } = await bench({ git: fakeGit().git });
    const cwd = join(home, "Projects", "site");
    await preOpen(mod, "site@laptop", OPS);
    await preOpen(mod, "review@laptop", "team/profiles/writer");
    await st!.open("site@laptop", { cwd });
    await st!.open("review@laptop", { cwd });
    const a = (st!.query("site@laptop").options as any).settings.autoMemoryDirectory;
    const b = (st!.query("review@laptop").options as any).settings.autoMemoryDirectory;
    expect(a).toBe(join(clone(), "ops", "memory"));
    expect(b).toBe(join(clone(), "writer", "memory"));
    for (const p of [a, b]) expect(p).not.toContain(join(".claude", "projects"));
  });

  it("174 · запись в память: хук отвечает {} сразу; add только memory/, commit, один github.token, pull, push — токен в окружении; по часам — без commit", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    repo();
    const g = fakeGit();
    const { mod } = await bench({ git: g.git });
    const seen = github(st!, () => TOKEN);
    await preOpen(mod, "site@laptop", OPS);
    await st!.open("site@laptop");
    const out = await st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(clone(), "ops", "memory", "testing.md") } });
    expect(out).toEqual([{}]);
    await until(() => g.cmds().includes("push"));
    expect(g.cmds()).toEqual(["add -- ops/memory writer/memory", "diff --cached --quiet", expect.stringMatching(/^commit -m память: laptop \d\d:\d\d$/), "pull --no-rebase --no-edit", "push", "log -1 --format=%s"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ to: "github", repo: "team/profiles" });
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
    expect((await ask({ type: "machine.profiles" })).result.repos["team/profiles"].state).toBe("ok");
    // по часам: нового нет — те же вызовы без commit
    g.calls.length = 0;
    g.o.dirty = false;
    vi.advanceTimersByTime(SYNC_MS);
    await until(() => g.cmds().includes("push"));
    expect(g.cmds()).toEqual(["add -- ops/memory writer/memory", "diff --cached --quiet", "pull --no-rebase --no-edit", "push", "log -1 --format=%s"]);
    expect(JSON.stringify(st!.journal())).not.toContain("ghs_SECRET123");
  });

  it("175 · конфликт при pull: state conflict, задание в UserPromptSubmit профиля ops; у wiki хука нет; после синхронизации — {}", async () => {
    repo();
    const g = fakeGit();
    g.o.pull = { code: 1, out: "CONFLICT (content): Merge conflict in ops/memory/testing.md\nAutomatic merge failed; fix conflicts and then commit." };
    const { mod } = await bench({ git: g.git });
    github(st!, () => TOKEN);
    await preOpen(mod, "site@laptop", OPS);
    await st!.open("site@laptop");
    await st!.open("wiki@laptop");
    const r = await ask({ type: "machine.profiles", sync: true });
    expect(r.result.repos["team/profiles"]).toMatchObject({ state: "conflict", op: "git pull --no-rebase", files: ["ops/memory/testing.md"] });
    expect(r.result.profiles[OPS]).toEqual({ model: "opus", effort: "high", sessions: ["site@laptop"] });
    const out = (await st!.proc("site@laptop").hook("UserPromptSubmit", { prompt: "Поправь тесты миграций" })) as any[];
    expect(out[0].hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out[0].hookSpecificOutput.additionalContext).toContain("ops/memory/testing.md");
    expect(out[0].hookSpecificOutput.additionalContext).toContain("Сведи обе версии");
    expect(st!.proc("wiki@laptop").hookEvents).not.toContain("UserPromptSubmit");
    st!.proc("site@laptop").send(stand.msg.state("idle"));
    await until(() => (last("site@laptop").profile as { state?: string } | undefined)?.state === "conflict");
    g.o.pull = { code: 0, out: "Merge made" };
    await ask({ type: "machine.profiles", sync: true });
    expect(await st!.proc("site@laptop").hook("UserPromptSubmit", { prompt: "ещё" })).toEqual([{}]);
  });

  it("176 · новый CLAUDE.md действует со следующего старта: до restart query() не пересобран, после — новый append", async () => {
    repo();
    const { mod } = await bench({ git: fakeGit().git });
    await preOpen(mod, "site@laptop", OPS);
    const s = await st!.open("site@laptop");
    writeFileSync(join(clone(), "ops", "CLAUDE.md"), "Ты ведёшь эксплуатацию и дежуришь.");
    github(st!, () => TOKEN);
    await ask({ type: "machine.profiles", sync: true });
    expect(st!.sdk.of("site@laptop")).toHaveLength(1);
    await s.restart();
    expect(st!.sdk.of("site@laptop")).toHaveLength(2);
    expect((st!.query("site@laptop").options as any).systemPrompt.append).toContain("и дежуришь");
  });

  it("177 · github отказал not_installed: сетевого git нет, state error, задание спросить человека; токен выдан — ok", async () => {
    repo();
    const g = fakeGit();
    const { mod } = await bench({ git: g.git });
    let answer: { ok: true; result: unknown } | { ok: false; error: string } = { ok: false, error: "not_installed" };
    github(st!, () => answer);
    await preOpen(mod, "site@laptop", OPS);
    await st!.open("site@laptop");
    const r = await ask({ type: "machine.profiles", sync: true });
    expect(r.result.repos["team/profiles"]).toMatchObject({ state: "error", op: "github.token", error: "not_installed" });
    expect(g.cmds().filter((c) => /^(pull|push|clone)/.test(c))).toEqual([]);
    st!.proc("site@laptop").send(stand.msg.state("idle"));
    await until(() => (last("site@laptop").profile as { state?: string } | undefined)?.state === "error");
    const out = (await st!.proc("site@laptop").hook("SessionStart", {})) as any[];
    expect(out[0].hookSpecificOutput.additionalContext).toContain("Без человека не решить — спроси");
    answer = TOKEN;
    await ask({ type: "machine.profiles", sync: true });
    expect(await st!.proc("site@laptop").hook("UserPromptSubmit", { prompt: "x" })).toEqual([{}]);
    expect(g.cmds()).toContain("push");
  });
});

describe("profiles: ветки и стыки", () => {
  it("session.profile живой сессии — restart; no_profile; без профиля — частей нет", async () => {
    repo();
    await bench({ git: fakeGit().git });
    await st!.open("site@laptop");
    expect((st!.query("site@laptop").options as any).settings).toBeUndefined();
    expect((await ask({ type: "session.profile", callsign: "site@laptop", profile: "team/profiles/nope" })).error).toBe("no_profile");
    const r = await ask({ type: "session.profile", callsign: "site@laptop", profile: OPS });
    expect(r.result).toEqual({ restart: true });
    await until(() => st!.sdk.of("site@laptop").length === 2 && st!.session("host-manage", "site@laptop")!.state === "idle");
    expect((st!.query("site@laptop").options as any).settings?.model).toBe("opus");
    expect(st!.proc("site@laptop").hookEvents).toContain("PostToolUse");
  });

  it("запись не в memory/ профиля — синхронизации нет", async () => {
    repo();
    const g = fakeGit();
    const { mod } = await bench({ git: g.git });
    await preOpen(mod, "site@laptop", OPS);
    await st!.open("site@laptop");
    await st!.proc("site@laptop").hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(home, "Projects", "x.md") } });
    await new Promise((r) => setTimeout(r, 30));
    expect(g.calls).toHaveLength(0);
  });

  it("клона нет — сначала токен, потом git clone по https с токеном в окружении", async () => {
    const g = fakeGit();
    await bench({ git: g.git });
    github(st!, () => TOKEN);
    await ask({ type: "machine.profiles", sync: true });
    expect(g.cmds()).toEqual([`clone https://github.com/team/profiles.git ${clone()}`]);
    expect(g.calls[0].env.GIT_CONFIG_VALUE_0).toContain("basic ");
  });

  it("profile.yaml: строки и списки", () => {
    expect(parseYaml("model: opus\nfallback_model: [sonnet, haiku]\n# x\neffort: 'high'")).toEqual({ model: "opus", fallback_model: ["sonnet", "haiku"], effort: "high" });
  });
});
