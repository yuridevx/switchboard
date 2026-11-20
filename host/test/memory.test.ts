// Эталоны машины дизайна «Память флота» (docs/designs/memory): замок записи по модели, один старт для любой модели, след, наследование кусочков.
// Номер эталона — номер карточки дизайна; источник свойства — над каждым.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as profiles } from "../src/modules/profiles/profiles.ts";
import { stand, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const OPUS = "claude-opus-5-5", HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5";
/** Кусочек с памятью и кусочек без неё. */
const GAME = "team/kit/game", PLAIN = "team/kit/plain";
const PULT = "pult~yuri@example.com";
const CS = "site@laptop";

/** Машина с клоном team/kit: game — с памятью (индекс и одна запись), plain — только скил. */
async function fleet(extra: (clone: string) => void = () => {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "sb2-host-")));
  const clone = join(home, "profiles", "team__kit");
  const memory = join(clone, "game", "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "- [Правила движения](movement-rules.md) — разворот на месте\n");
  writeFileSync(join(memory, "movement-rules.md"), "Разворот на месте — через остановку.\n");
  mkdirSync(join(clone, "plain", "skills", "deploy"), { recursive: true });
  writeFileSync(join(clone, "plain", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: выкладка\n---\nтекст");
  mkdirSync(join(clone, ".git"), { recursive: true });
  extra(clone);
  const git: string[][] = [];
  st = await stand({ home, modules: [profiles({ git: (async (args: string[]) => (git.push(args.filter((a) => !a.startsWith("-c") && !a.includes("="))), { code: 0, out: "" })) as never })] });
  st.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": ["team/kit"] } });
  st.services.handlers["github.token"] = () => ({ token: "t", expires: 1 });
  await st.request("profile.sync", { to: "@laptop" });
  return { home, clone, memory, git };
}

const open = (name: string, model: string, pieces?: string[]) => st!.open(name, { key: "claude", model, ...(pieces ? { pieces } : {}) });
const write = (file: string) => ({ tool_name: "Write", tool_input: { file_path: file, content: "новая запись" } });
const denied = (out: unknown[]) => (out[0] as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)?.hookSpecificOutput;
const trail = () => st!.journal().filter((l) => l.msg === "memory");
const settingsOf = (cs: string) => (st!.sdk.last(cs)!.options as { settings?: Record<string, unknown> }).settings;

describe("память флота: один старт, запись по модели", () => {
  // эталон 1 — чьё: код — папку встроенной памяти ставит хозяин кусочков; на модель старт не смотрит
  it("эталон 1 · Opus 5.5 и Haiku 5.5 с одним кусочком с памятью — опции запуска одинаковые: память включена, папка — память кусочка", async () => {
    const { memory } = await fleet();
    await open("strong", OPUS, [GAME]);
    await open("weak", HAIKU, [GAME]);
    const part = (cs: string) => {
      const o = st!.sdk.last(cs)!.options as Record<string, any>;
      return { settings: o.settings, plugins: o.plugins, dirs: o.additionalDirectories, hooks: Object.fromEntries(Object.entries(o.hooks as Record<string, Array<{ matcher?: string }>>).map(([event, list]) => [event, list.map((m) => m.matcher)])) };
    };
    expect(part("strong@laptop").settings).toEqual({ autoMemoryDirectory: memory });
    expect(part("weak@laptop")).toEqual(part("strong@laptop"));
  });

  // эталон 2 — чьё: слово пользователя 19 нояб. («память пишут сильные модели»); факт опыта — 1 попытка, 1 отказ, 0 файлов
  it("эталон 2 · Haiku 5.5 пишет файл в память кусочка — отказ с причиной до вызова, файл прежний, строка следа «отказ»", async () => {
    const { memory } = await fleet();
    const { proc } = await open("site", HAIKU, [GAME]);
    const fresh = join(memory, "new-note.md"), old = join(memory, "movement-rules.md");
    const no = denied(await proc.hook("PreToolUse", write(fresh)));
    expect(no).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(no!.permissionDecisionReason).toBe(`Память только для чтения: модель ${HAIKU} не из пишущих память. Важное для памяти скажи в ответе тому, кто дал задачу.`);
    expect(denied(await proc.hook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: old, old_string: "через", new_string: "без" } }))?.permissionDecision).toBe("deny");
    expect(existsSync(fresh)).toBe(false);
    expect(readFileSync(old, "utf8")).toBe("Разворот на месте — через остановку.\n");
    expect(trail()).toMatchObject([
      { level: "info", callsign: CS, model: HAIKU, piece: GAME, record: "new-note", op: "refused" },
      { level: "info", callsign: CS, model: HAIKU, piece: GAME, record: "movement-rules", op: "refused" },
    ]);
    // запись мимо памяти замок не трогает
    expect(await proc.hook("PreToolUse", write(join(st!.dir, "notes.md")))).toEqual([{}]);
  });

  // эталон 3 — чьё: слово пользователя 19 нояб. («остальные читают»)
  it("эталон 3 · Haiku 5.5 читает запись — чтение прошло, строка следа «чтение»", async () => {
    const { memory } = await fleet();
    const { proc } = await open("site", HAIKU, [GAME]);
    const read = { tool_name: "Read", tool_input: { file_path: join(memory, "movement-rules.md") } };
    // до вызова чтения хуков нет: отказать некому
    expect(await proc.hook("PreToolUse", read)).toEqual([]);
    await proc.hook("PostToolUse", read);
    expect(trail()).toMatchObject([{ level: "info", callsign: CS, model: HAIKU, piece: GAME, record: "movement-rules", op: "read" }]);
    // файл вне памяти кусочка следа не даёт
    await proc.hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: join(st!.dir, "readme.md") } });
    expect(trail()).toHaveLength(1);
  });

  // эталон 4 — чьё: слово пользователя 19 нояб. (след); сведение сразу после записи — чьё: код
  it("эталон 4 · Opus 5.5 пишет запись — запись проходит, строка следа «запись», сведение с git сразу", async () => {
    const { memory, git } = await fleet();
    const { proc } = await open("site", OPUS, [GAME]);
    const fresh = write(join(memory, "new-note.md"));
    expect(await proc.hook("PreToolUse", fresh)).toEqual([{}]);
    const before = git.length;
    await proc.hook("PostToolUse", fresh);
    expect(trail()).toMatchObject([{ level: "info", callsign: CS, model: OPUS, piece: GAME, record: "new-note", op: "write" }]);
    await until(() => git.length > before, "сведение после записи");
    expect(git[before]![0]).toBe("add");
  });

  // эталон 5 — чьё: слово пользователя 19 нояб.; ответ на смену модели — чьё: код
  it("эталон 5 · у живой сессии модель Opus 5.5 → Sonnet 5.5 — следующая запись в память получает отказ; процесс тот же, ответ на смену прежний", async () => {
    const { memory } = await fleet();
    const { proc, s } = await open("site", OPUS, [GAME]);
    const note = write(join(memory, "new-note.md"));
    expect(await proc.hook("PreToolUse", note)).toEqual([{}]);
    const restarts = s.restarts;
    expect(await st!.request("session.update", { to: CS, patch: { model: SONNET } }, PULT)).toMatchObject({ ok: true, result: { now: ["model"], later: [] } });
    expect(denied(await proc.hook("PreToolUse", note))).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining(SONNET) });
    expect(s.restarts).toBe(restarts);
    expect(st!.proc(CS)).toBe(proc);
  });

  // эталон 6 — чьё: слово пользователя 19 нояб.
  it("эталон 6 · у живой сессии модель Sonnet 5.5 → Opus 5.5 — следующая запись в память проходит; процесс тот же", async () => {
    const { memory } = await fleet();
    const { proc, s } = await open("site", SONNET, [GAME]);
    const note = write(join(memory, "new-note.md"));
    expect(denied(await proc.hook("PreToolUse", note))?.permissionDecision).toBe("deny");
    const restarts = s.restarts;
    expect(await st!.request("session.update", { to: CS, patch: { model: OPUS } }, PULT)).toMatchObject({ ok: true, result: { now: ["model"], later: [] } });
    expect(await proc.hook("PreToolUse", note)).toEqual([{}]);
    expect(s.restarts).toBe(restarts);
    expect(st!.proc(CS)).toBe(proc);
  });

  // эталон 7 — чьё: слово пользователя 19 нояб. («Opus 5.5 и более сильные»): список один, неизвестная модель читает
  it("эталон 7 · модель, которой нет в списке пишущих, — запись закрыта; четыре модели списка пишут, пометка окна [1m] модель не меняет", async () => {
    const { memory } = await fleet();
    const { proc } = await open("site", OPUS, [GAME]);
    const note = write(join(memory, "new-note.md"));
    const tryWith = async (model: string) => {
      await st!.request("session.update", { to: CS, patch: { model } }, PULT);
      return denied(await proc.hook("PreToolUse", note))?.permissionDecision ?? "allow";
    };
    for (const model of ["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-opus-5-5[1m]"]) expect(await tryWith(model), model).toBe("allow");
    for (const model of ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-haiku-5-5", "muse-wonder-1.0", "gpt-6.2-astra", "anthropic/claude-opus-5-5", "model-of-tomorrow"]) expect(await tryWith(model), model).toBe("deny");
  });

  // эталон 10 — чьё: вторая развилка дизайна, без ответа решена рекомендованным: память одна — общая
  it("эталон 10 · сессия без кусочка с памятью стартует с выключенной встроенной памятью: без кусочков, с кусочком без памяти и с несобранным набором", async () => {
    const { clone } = await fleet();
    await open("bare", HAIKU);
    expect(settingsOf("bare@laptop")).toEqual({ autoMemoryEnabled: false });
    await open("plain", OPUS, [PLAIN]);
    expect(settingsOf("plain@laptop")).toEqual({ autoMemoryEnabled: false });
    // кусочек пропал из клона после открытия: сессия поднимается без кусочков — и без памяти машины
    await open("lost", OPUS, [GAME]);
    rmSync(join(clone, "game"), { recursive: true, force: true });
    await st!.request("session.stop", { to: "lost@laptop" }, PULT);
    await st!.request("session.start", { to: "lost@laptop" }, PULT);
    await until(() => st!.kernel.sessions.get("lost@laptop")?.state === "idle", "сессия поднялась");
    expect(settingsOf("lost@laptop")).toEqual({ autoMemoryEnabled: false });
    expect(st!.journal().some((l) => l.msg === "profile" && l.level === "error" && l.callsign === "lost@laptop")).toBe(true);
  });

  // чьё: код — настройки памяти держит система: кусочек своим settings.json их не ставит
  it("кусочек называет в settings.json выключатель встроенной памяти — отказ bad_profile: его держит система", async () => {
    await fleet((clone) => {
      mkdirSync(join(clone, "sly"), { recursive: true });
      writeFileSync(join(clone, "sly", "settings.json"), JSON.stringify({ autoMemoryEnabled: true }));
    });
    const r = await st!.request("session.open", { to: "@laptop", spec: { name: "a", cwd: st!.dir, key: "claude", model: OPUS, pieces: ["team/kit/sly"] } }, PULT);
    expect(r).toMatchObject({ ok: false, error: "bad_profile" });
    expect(r.why).toContain("autoMemoryEnabled");
  });
});

describe("память флота: дочерняя берёт кусочки родителя", () => {
  // эталон 8 — чьё: факт прода 19 нояб. — 23 сессии из 38 без памяти открыты сессией с памятью
  it("эталон 8 · сессия открывает дочернюю, кусочки не названы — в документе дочерней кусочки родителя; запись решает её модель", async () => {
    const { memory } = await fleet();
    await open("boss", OPUS, [GAME]);
    expect(await st!.request("session.open", { to: "@laptop", spec: { name: "kid", cwd: st!.dir, key: "claude", model: HAIKU } }, "boss@laptop")).toMatchObject({ ok: true });
    await until(() => st!.kernel.sessions.get("kid@laptop")?.state === "idle", "дочерняя готова");
    expect(st!.kernel.sessions.get("kid@laptop")!.rec.spec).toMatchObject({ pieces: [GAME], parent: "boss@laptop" });
    expect(settingsOf("kid@laptop")).toEqual({ autoMemoryDirectory: memory });
    expect(denied(await st!.proc("kid@laptop").hook("PreToolUse", write(join(memory, "new-note.md"))))?.permissionDecision).toBe("deny");
    // человек открывает сессию без кусочков — наследовать не у кого
    await st!.request("session.open", { to: "@laptop", spec: { name: "solo", cwd: st!.dir, key: "claude", model: OPUS } }, PULT);
    expect(st!.kernel.sessions.get("solo@laptop")!.rec.spec.pieces).toBeUndefined();
    // родитель на другой машине — его документ приходит одной полной строкой картины флота
    const asked: Array<Record<string, unknown>> = [];
    st!.services.handlers["fleet.list"] = (f) => (asked.push(f as Record<string, unknown>), { machines: [], people: [], sessions: (f as { machine?: string }).machine === "server" ? [{ callsign: "lead@server", state: "idle", spec: { name: "lead", cwd: "~", key: "claude", model: OPUS, pieces: [GAME] }, by: PULT, since: 1 }] : [] });
    await st!.request("session.open", { to: "@laptop", spec: { name: "far", cwd: st!.dir, key: "claude", model: OPUS } }, "lead@server");
    expect(st!.kernel.sessions.get("far@laptop")!.rec.spec).toMatchObject({ pieces: [GAME], parent: "lead@server" });
    expect(asked).toMatchObject([{ machine: "server", full: true }]);
  });

  // эталон 9 — чьё: код — названное значение хозяин не трогает: пустой список назван
  it("эталон 9 · дочерняя с пустым списком кусочков — без кусочков и без памяти", async () => {
    await fleet();
    await open("boss", OPUS, [GAME]);
    await st!.request("session.open", { to: "@laptop", spec: { name: "kid", cwd: st!.dir, key: "claude", model: OPUS, pieces: [] } }, "boss@laptop");
    await until(() => st!.kernel.sessions.get("kid@laptop")?.state === "idle", "дочерняя готова");
    expect(st!.kernel.sessions.get("kid@laptop")!.rec.spec.pieces).toEqual([]);
    const o = st!.sdk.last("kid@laptop")!.options as Record<string, unknown>;
    expect(o.settings).toEqual({ autoMemoryEnabled: false });
    expect(o.plugins).toBeUndefined();
  });
});

describe("память флота: мера индекса", () => {
  // чьё: код — пределы индекса Claude Code знает только машина: она же режет по ним индекс соседней памяти
  it("profile.view отдаёт готовую меру индекса каждой памяти набора: строки, байты, пределы и «сверх меры»", async () => {
    const { memory } = await fleet();
    const view = async () => ((await st!.request("profile.view", { to: "@laptop", pieces: [GAME, PLAIN] }, PULT)).result as { memory: Array<Record<string, unknown>> }).memory;
    const bytes = Buffer.byteLength("- [Правила движения](movement-rules.md) — разворот на месте\n");
    expect(await view()).toEqual([{ piece: GAME, path: "memory/MEMORY.md", lines: 1, bytes, maxLines: 200, maxBytes: 25_000, over: false }]);
    writeFileSync(join(memory, "MEMORY.md"), Array.from({ length: 201 }, (_, i) => `- запись ${i}`).join("\n"));
    expect((await view())[0]).toMatchObject({ lines: 201, maxLines: 200, over: true });
    writeFileSync(join(memory, "MEMORY.md"), "я".repeat(12_501));
    expect((await view())[0]).toMatchObject({ lines: 1, bytes: 25_002, maxBytes: 25_000, over: true });
  });
});
