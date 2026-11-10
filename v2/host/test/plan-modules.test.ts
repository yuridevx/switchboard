// План тестов v2, модули машины: отказы словом и ожидаемые ветки, которых не держал ни один тест.
// Источник свойств — устав («система ловит», graceful shutdown) и код (помечено «чьё: код»).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { folders } from "../src/modules/accounts/links.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as incidents } from "../src/modules/incidents/incidents.ts";
import { make as machine } from "../src/modules/machine/machine.ts";
import { make as points, projectDir } from "../src/modules/points/points.ts";
import { make as profiles } from "../src/modules/profiles/profiles.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";
import { FakeQuery } from "../stand/sdk.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const CS = "site@laptop";
const row = (cs: string) => st!.link.rows(cs).at(-1)!.row as any;
const shellRoot = () => mkdtempSync(join(tmpdir(), "sb2-shell-"));

/** Папка данных с вошедшими аккаунтами и очередями. */
function homeWithAccounts(names: Record<string, "ok" | "none">, slots: Record<string, string[]>): string {
  const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
  mkdirSync(join(home, "store"), { recursive: true });
  const book = { accounts: Object.fromEntries(Object.entries(names).map(([n, login]) => [n, { login, plan: "max", limits: {} }])), slots };
  writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: book }));
  const dirs = folders(home);
  for (const n of Object.keys(names)) mkdirSync(dirs.accDir(n), { recursive: true });
  for (const [slot, order] of Object.entries(slots)) symlinkSync(dirs.accDir(order[0]!), (mkdirSync(join(home, "slots"), { recursive: true }), dirs.slotDir(slot)), process.platform === "win32" ? "junction" : "dir");
  return home;
}

describe("план v2: машина", () => {
  it("machine.dirs: путь не от ~ и не полный — отказ bad_dir", async () => {
    st = await stand({ modules: [machine()] });
    expect(await st.request("machine.dirs", { to: "@laptop", path: "projects/site" })).toMatchObject({ ok: false, error: "bad_dir" });
  });

  // чьё: код — договор: «before — время, до которого читать»
  it("журнал машины страницами: limit строк и more; следующая страница по before — без повтора", async () => {
    st = await stand({ modules: [machine()] });
    for (let i = 0; i < 5; i++) {
      await st.request("session.stop", { to: `ghost${i}@laptop` });
      st.clock.advance(10);
    }
    const one = (await st.request("machine.journal", { to: "@laptop", limit: 2 })).result as { lines: Array<{ t: number; trace?: string; msg: string }>; more: boolean };
    expect(one.lines).toHaveLength(2);
    expect(one.more).toBe(true);
    const two = (await st.request("machine.journal", { to: "@laptop", limit: 2, before: one.lines.at(-1)!.t })).result as typeof one;
    expect(two.lines).toHaveLength(2);
    expect(two.lines.every((l) => l.t < one.lines.at(-1)!.t)).toBe(true);
  });
});

describe("план v2: запуски оболочки", () => {
  it("shell.kill: запуска с таким номером нет — отказ no_run", async () => {
    st = await stand({ modules: [shell({ root: shellRoot() })] });
    expect(await st.request("shell.kill", { to: "@laptop", run: "нет" })).toMatchObject({ ok: false, error: "no_run" });
  });

  it("shell.run: оболочки нет на машине — no_shell; папки нет — bad_dir; запуск не начат", async () => {
    st = await stand({ modules: [shell({ root: shellRoot() })] });
    expect(await st.request("shell.run", { to: "@laptop", shell: "zsh-нет", script: "echo 1" })).toMatchObject({ ok: false });
    expect(await st.request("shell.run", { to: "@laptop", shell: "node", script: "1", cwd: join(st.dir, "нет-такой") })).toMatchObject({ ok: false, error: "bad_dir" });
  });

  // устав: graceful shutdown — «доводит или отдаёт текущее»
  it("остановка Host: идущий запуск снят, ждущий его получает снимок killed", async () => {
    st = await stand({ modules: [shell({ root: shellRoot() })] });
    const started = (await st.request("shell.run", { to: "@laptop", shell: "node", script: "setTimeout(() => {}, 60000)" })).result as { run: string };
    const waiting = st.request("shell.wait", { to: "@laptop", run: started.run, wait: 60 });
    await tick();
    void st.kernel.shutdown("SIGTERM");
    expect((await waiting).result).toMatchObject({ state: "killed" });
  }, 40_000);

  // чьё: код — замысел в shell.ts: «сессия пустила запуск и не дождалась — конец придёт ей сообщением».
  // Находка (fails.md): флаг «дождалась» ставится после конца запуска, и сообщение уходит и дождавшейся сессии. После починки снять .fails.
  it.fails("сессия дождалась конца своего запуска — сообщение «Запуск кончился» ей не уходит", async () => {
    st = await stand({ modules: [chat(), shell({ root: shellRoot() })] });
    await st.open("site");
    const started = (await st.request("shell.run", { to: "@laptop", shell: "node", script: "setTimeout(() => {}, 300)" }, CS)).result as { run: string };
    expect((await st.request("shell.wait", { to: "@laptop", run: started.run, wait: 20 }, CS)).result).toMatchObject({ state: "done" });
    await new Promise((r) => setTimeout(r, 200));
    expect(st.proc(CS).inputs.some((i) => String(i.message.content).includes("кончился"))).toBe(false);
  }, 40_000);
});

describe("план v2: кусочки", () => {
  const kit = (home: string) => join(home, "profiles", "team__kit");
  async function withKit(extra: (clone: string) => void = () => {}, repos = ["team/kit"]) {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    mkdirSync(join(kit(home), "base", "skills", "deploy"), { recursive: true });
    writeFileSync(join(kit(home), "base", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: выкладка\n---\nтекст");
    writeFileSync(join(kit(home), "base", "settings.json"), JSON.stringify({ outputStyle: "short" }));
    extra(kit(home));
    const git: string[] = [];
    st = await stand({ home, modules: [profiles({ git: async (args: string[], o: { cwd: string }) => (git.push(`${o.cwd.split(/[\\/]/).pop()}: ${args.filter((a) => !a.startsWith("-c") && !a.includes("=")).join(" ")}`), { code: 0, out: "" }) })] });
    st.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": repos } });
    st.services.handlers["github.token"] = () => ({ token: "t", expires: 1 });
    return { home, git };
  }

  // чьё: код — сломанный манифест кусочек не прячет: отказ скажет открытие
  it("profile.list: кусочек со сломанным манифестом виден в списке с ok: false и причиной; целый — ok со счётом содержимого", async () => {
    await withKit((clone) => {
      mkdirSync(join(clone, "bad", ".claude-plugin"), { recursive: true });
      writeFileSync(join(clone, "bad", ".claude-plugin", "plugin.json"), JSON.stringify({ description: "без имени" }));
    });
    const r = (await st!.request("profile.list", { to: "@laptop" })).result as { pieces: Array<{ id: string; ok: boolean; why?: string; has?: Record<string, number> }>; repos: Array<{ repo: string; state: string }> };
    expect(r.pieces.find((p) => p.id === "team/kit/base")).toMatchObject({ ok: true, has: { skill: 1, settings: 1 } });
    expect(r.pieces.find((p) => p.id === "team/kit/bad")).toMatchObject({ ok: false, why: expect.stringContaining("name") });
    expect(r.repos).toMatchObject([{ repo: "team/kit", state: "ok" }]);
  });

  it("profile.file: папки кусочка нет в клонах — no_profile; файл больше предела — too_large", async () => {
    await withKit((clone) => writeFileSync(join(clone, "base", "big.md"), "x".repeat(300 * 1024)));
    await st!.request("profile.list", { to: "@laptop" });
    expect(await st!.request("profile.file", { to: "@laptop", piece: "team/kit/ghost", path: "CLAUDE.md" })).toMatchObject({ ok: false, error: "no_profile" });
    expect(await st!.request("profile.file", { to: "@laptop", piece: "team/kit/base", path: "big.md" })).toMatchObject({ ok: false, error: "too_large" });
  });

  // чьё: код — договор: «session — только репозитории кусочков этой сессии»
  it("profile.sync для сессии: git идёт только в клоне её кусочков; сессии нет — not_found", async () => {
    const { home, git } = await withKit(() => {}, ["team/kit", "team/other"]);
    mkdirSync(join(home, "profiles", "team__other", "base", ".git"), { recursive: true });
    mkdirSync(join(kit(home), ".git"), { recursive: true });
    mkdirSync(join(home, "profiles", "team__other", ".git"), { recursive: true });
    await st!.request("profile.sync", { to: "@laptop" });
    await st!.open("site", { pieces: ["team/kit/base"] });
    git.length = 0;
    const r = (await st!.request("profile.sync", { to: "@laptop", session: CS })).result as { repos: Array<{ repo: string }> };
    expect(r.repos.map((x) => x.repo)).toEqual(["team/kit"]);
    expect(git.length).toBeGreaterThan(0);
    expect(git.every((g) => g.startsWith("team__kit:"))).toBe(true);
    expect(await st!.request("profile.sync", { to: "@laptop", session: "ghost@laptop" })).toMatchObject({ ok: false, error: "not_found" });
  });

  // чьё: код — «второй скил пропал бы молча»
  it("profile.view: два кусочка с одним именем плагина — отказ bad_profile, причина называет оба", async () => {
    await withKit((clone) => {
      for (const p of ["one", "two"]) {
        mkdirSync(join(clone, p, ".claude-plugin"), { recursive: true });
        writeFileSync(join(clone, p, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "same" }));
      }
    });
    await st!.request("profile.list", { to: "@laptop" });
    const r = await st!.request("profile.view", { to: "@laptop", pieces: ["team/kit/one", "team/kit/two"] });
    expect(r).toMatchObject({ ok: false, error: "bad_profile" });
    expect(String((r as any).why)).toContain("team/kit/one");
    expect(String((r as any).why)).toContain("team/kit/two");
  });
});

describe("план v2: точки", () => {
  const talk = (s: { rec: { cwd: string; sessionId: string } }) => {
    const dir = projectDir(s.rec.cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.rec.sessionId}.jsonl`), JSON.stringify({ type: "user", uuid: "u1", message: { content: "шаг" } }) + "\n");
  };
  const accept = () => {
    st!.services.handlers["points.put"] = () => ({ upload: {}, done: true });
  };

  // чьё: код — «файла разговора ещё нет — не сбой»
  it("points.save: файла разговора ещё нет — отказ no_file, причины сбоя в строке сессии нет", async () => {
    st = await stand({ modules: [points()] });
    await st.open("site", { backup: true });
    expect(await st.request("points.save", { to: CS })).toMatchObject({ ok: false, error: "no_file" });
    expect(row(CS).archiveError).toBeUndefined();
  });

  // чьё: код — договор: «stop — после точки остановить сессию»
  it("points.save stop: точка записана, сессия остановлена", async () => {
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site", { backup: true });
    talk(s);
    accept();
    expect((await st.request("points.save", { to: CS, stop: true })).result).toMatchObject({ point: expect.stringMatching(/^p/) });
    await until(() => s.state === "stopped", 5000, "stopped");
  });

  it("points.raise: сессия этого разговора идёт на машине — отказ running, процесс не тронут", async () => {
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site");
    st.services.handlers["points.get"] = () => ({ session: { sid: s.rec.sessionId, machine: "laptop", callsign: CS, cwd: st!.dir, points: 1, last: 1 }, point: { point: "p1", at: 1 }, files: [] });
    expect(await st.request("points.raise", { to: "@laptop", sid: s.rec.sessionId })).toMatchObject({ ok: false, error: "running" });
    expect(s.state).toBe("idle");
    expect(st.holders.spawns).toHaveLength(1);
  });

  // устав: «соединение оборвалось» — ожидаемая ветка; чьё: код — «машина могла умереть»
  it("перенос: прежняя машина не на связи — сессия поднята с последней точки архива, session.start прежней не звали", async () => {
    st = await stand({ modules: [points()] });
    const asked: string[] = [];
    st.link.answers["points.save"] = (f) => (asked.push("save"), { type: "reply", id: f.id!, ok: false, error: "offline", why: "машина server не на связи" });
    st.link.answers["session.start"] = (f) => (asked.push("start"), { type: "reply", id: f.id!, ok: true, result: {} });
    st.link.answers["session.remove"] = (f) => (asked.push("remove"), { type: "reply", id: f.id!, ok: true, result: {} });
    st.services.handlers["points.get"] = () => ({ session: { sid: "sid-x", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 2, last: 1, spec: { name: "docs", cwd: st!.dir } }, point: { point: "p9", at: 1 }, files: [] });
    const r = await st.request("points.raise", { to: "@laptop", sid: "sid-x", move: true });
    expect(r).toMatchObject({ ok: true, result: { callsign: "docs@laptop" } });
    expect(asked).not.toContain("start");
    expect(st.journal().some((l) => l.msg === "raise_release" && l.word === "offline")).toBe(true);
  });
});

describe("план v2: обращения", () => {
  const post = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/incident`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const portOf = async () => ((await st!.request("incident.list", { to: "@laptop" })).result as { port: number }).port;

  it("POST /incident с незаданным видом — 400 со словом и причиной; обращение не записано", async () => {
    st = await stand({ modules: [chat(), incidents()], config: { "host-incidents": { port: 0, kinds: {} } } });
    const res = await post(await portOf(), { kind: "far", text: "диск" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_kind", why: expect.any(String) });
    expect(((await st.request("incident.list", { to: "@laptop" })).result as { incidents: unknown[] }).incidents).toHaveLength(0);
    expect(st.journal().some((l) => l.msg === "incident" && l.word === "unknown_kind")).toBe(true);
  });

  // чьё: код — «отказ доставки остаётся в записи: обращение ждёт следующего прохода»
  it("сессия вида не открылась — отказ open_failed; обращение записано и ждёт с той же причиной; у доставленного причины нет, вложения — именами", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    st = await stand({ home, modules: [chat(), incidents()], config: { "host-incidents": { port: 0, kinds: { disk: { cwd: work }, lost: { cwd: join(home, "нет-такой") } } } } });
    const good = await st.request("incident.raise", { to: "@laptop", kind: "disk", key: "c:", text: "место", files: [{ name: "df.txt", mime: "text/plain", base64: Buffer.from("x").toString("base64") }] }, "@laptop");
    expect(good).toMatchObject({ ok: true, result: { callsign: "disk-1@laptop" } });
    const bad = await st.request("incident.raise", { to: "@laptop", kind: "lost", key: "", text: "беда" }, "@laptop");
    expect(bad).toMatchObject({ ok: false, error: "open_failed" });
    const list = (await st.request("incident.list", { to: "@laptop" })).result as { incidents: Array<Record<string, unknown>> };
    expect(list.incidents.map((a) => a.kind)).toEqual(["lost", "disk"]);
    expect(list.incidents[0]).toMatchObject({ state: "pending", why: (bad as any).why });
    expect(list.incidents[1]).toMatchObject({ callsign: "disk-1@laptop", files: ["df.txt"] });
    expect(list.incidents[1]!.why).toBeUndefined();
  });

  // устав: graceful shutdown — «не принимает новое»
  it("штатная остановка Host: сервер обращений закрыт — новый POST не принят", async () => {
    st = await stand({ modules: [chat(), incidents()], config: { "host-incidents": { port: 0, kinds: {} } } });
    const port = await portOf();
    await st.kernel.shutdown("SIGTERM");
    await expect(post(port, { kind: "disk", text: "x" })).rejects.toThrow();
  });
});

describe("план v2: очереди и правила", () => {
  const A = "a@example.com", B = "b@example.com", C = "c@example.com";
  const slots = async () => ((await st!.request("account.list", { to: "@laptop" })).result as any).slots as Array<{ name: string; account?: string }>;

  // чьё: код
  it("slot.set: в новом порядке нет того, кто стоит сейчас, — очередь идёт на первого вошедшего; строка сессии называет его; в журнале account_swap", async () => {
    st = await stand({ home: homeWithAccounts({ [A]: "ok", [B]: "ok" }, { main: [A, B] }), modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    await st.open("site", { slot: "main" });
    expect(row(CS).account).toBe(A);
    expect(await st.request("slot.set", { to: "@laptop", slot: "main", order: [B] })).toMatchObject({ ok: true });
    expect((await slots()).find((q) => q.name === "main")!.account).toBe(B);
    await until(() => row(CS).account === B, 5000, "строка сессии на B");
    expect(st.journal().some((l) => l.msg === "account_swap" && String(l.why).includes("новый порядок"))).toBe(true);
  });

  it("slot.set: в порядке нет вошедшего аккаунта — отказ no_reserve, очередь не заведена", async () => {
    st = await stand({ home: homeWithAccounts({ [A]: "ok", [C]: "none" }, { main: [A] }), modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    expect(await st.request("slot.set", { to: "@laptop", slot: "docs", order: [C] })).toMatchObject({ ok: false, error: "no_reserve" });
    expect((await slots()).map((q) => q.name)).toEqual(["main"]);
  });

  // устав: «прямой запрос к Worker'у не прошёл — отказ словом»
  it("rules.test без rules: правила флота не прочитаны — отказ rules_unavailable", async () => {
    st = await stand({ modules: [accounts(), proxy()] });
    st.services.handlers["prefs.get"] = () => {
      throw { word: "offline", message: "службы молчат" };
    };
    expect(await st.request("rules.test", { to: "@laptop", text: "internal.example", scope: "user" })).toMatchObject({ ok: false, error: "rules_unavailable" });
  });
});

describe("план v2: сведение кусочков", () => {
  type Call = { args: string[]; env: Record<string, string> };
  /** Поддельный git: записывает команды без служебных -c; ответы — по первому слову команды. */
  const fakeGit = (answers: Record<string, { code: number; out: string } | undefined> = {}) => {
    const calls: Call[] = [];
    const git = async (args: string[], o: { cwd: string; env: Record<string, string> }) => {
      const real = args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c");
      calls.push({ args: real, env: o.env });
      return answers[real[0]!] ?? { code: real[0] === "diff" && real.includes("--cached") ? 1 : 0, out: "" };
    };
    return { calls, git };
  };
  const cloneAt = () => {
    const clone = join(mkdtempSync(join(tmpdir(), "sb2-clone-")), "team__kit");
    mkdirSync(join(clone, ".git"), { recursive: true });
    return clone;
  };

  // чьё: код — токен приложения GitHub идёт в окружении git, не в аргументах
  it("свои правки клона уходят коммитом и push; токен — в окружении git, не в аргументах", async () => {
    const { syncRepo } = await import("../src/modules/profiles/sync.ts");
    const { calls, git } = fakeGit();
    const state = await syncRepo(git, "team/kit", cloneAt(), "laptop", async () => "секрет-токен", () => {});
    expect(state.state).toBe("ok");
    expect(calls.map((c) => c.args[0])).toEqual(["add", "diff", "commit", "rev-parse", "pull", "rev-parse", "push"]);
    expect(calls.find((c) => c.args[0] === "commit")!.args.join(" ")).toContain("сведение: laptop");
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain("секрет-токен");
    expect(JSON.stringify(calls.find((c) => c.args[0] === "push")!.env)).toContain(Buffer.from("x-access-token:секрет-токен").toString("base64"));
  });

  // устав: «система ловит» — остановить, отказать, записать причину
  it("в клоне незавершённое слияние — состояние conflict со списком файлов; add и commit не идут", async () => {
    const { syncRepo } = await import("../src/modules/profiles/sync.ts");
    const clone = cloneAt();
    writeFileSync(join(clone, ".git", "MERGE_HEAD"), "abc");
    const { calls, git } = fakeGit({ diff: { code: 0, out: "skills/deploy/SKILL.md\n" } });
    const state = await syncRepo(git, "team/kit", clone, "laptop", async () => "t", () => {});
    expect(state).toMatchObject({ state: "conflict", files: ["skills/deploy/SKILL.md"] });
    expect(calls.some((c) => c.args[0] === "add" || c.args[0] === "commit")).toBe(false);
  });

  it("шаг git не прошёл — состояние error с названием шага и словами git", async () => {
    const { syncRepo } = await import("../src/modules/profiles/sync.ts");
    const pushed = await syncRepo(fakeGit({ push: { code: 1, out: "rejected: non-fast-forward" } }).git, "team/kit", cloneAt(), "laptop", async () => "t", () => {});
    expect(pushed).toMatchObject({ state: "error", op: "git push", error: expect.stringContaining("rejected") });
    const noToken = await syncRepo(fakeGit().git, "team/kit", cloneAt(), "laptop", async () => { throw new Error("приложение не установлено"); }, () => {});
    expect(noToken).toMatchObject({ state: "error", op: "github.token", error: expect.stringContaining("не установлено") });
  });

  const withRepos = async (clones: string[], git = fakeGit()) => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    for (const c of clones) mkdirSync(join(home, "profiles", c.replace("/", "__"), "base", ".git"), { recursive: true });
    for (const c of clones) mkdirSync(join(home, "profiles", c.replace("/", "__"), ".git"), { recursive: true });
    st = await stand({ home, modules: [profiles({ git: git.git as never })] });
    st.services.handlers["github.token"] = () => ({ token: "t", expires: 1 });
    return { home, git };
  };

  // чьё: код — «ключа нет или служба молчит — не значит „репозиториев нет“: клоны не трогаем»; журнал называет причину один раз
  it("список флота не прочитан — сведение пропущено, клон на месте, строка журнала одна на два такта", async () => {
    const { home } = await withRepos(["team/kit"]);
    st!.services.handlers["prefs.get"] = () => {
      throw { word: "offline", message: "службы молчат" };
    };
    expect(await st!.request("profile.sync", { to: "@laptop" })).toMatchObject({ ok: false, error: "offline" });
    expect(await st!.request("profile.sync", { to: "@laptop" })).toMatchObject({ ok: false, error: "offline" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, "profiles", "team__kit"))).toBe(true);
    expect(st!.journal().filter((l) => l.msg === "sync" && l.word === "offline")).toHaveLength(1);
  });

  // чьё: код
  it("репозиторий убран из списка флота — последнее отправлено, клон удалён, в списке кусочков его нет", async () => {
    const { home, git } = await withRepos(["team/old"]);
    st!.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": [] } });
    await st!.request("profile.sync", { to: "@laptop" });
    const { existsSync } = await import("node:fs");
    expect(git.calls.some((c) => c.args[0] === "push")).toBe(true);
    expect(existsSync(join(home, "profiles", "team__old"))).toBe(false);
    expect(((await st!.request("profile.list", { to: "@laptop" })).result as { pieces: unknown[] }).pieces).toHaveLength(0);
    expect(st!.journal().some((l) => l.msg === "sync" && String(l.why).includes("клон удалён"))).toBe(true);
  });

  it("шаг сведения не прошёл: в profile.list клон в состоянии error с шагом, кусочки клона — ok: false с причиной", async () => {
    await withRepos(["team/kit"], fakeGit({ push: { code: 1, out: "rejected" } }));
    st!.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": ["team/kit"] } });
    await st!.request("profile.sync", { to: "@laptop" });
    const r = (await st!.request("profile.list", { to: "@laptop" })).result as { pieces: Array<{ ok: boolean; why?: string }>; repos: Array<Record<string, unknown>> };
    expect(r.repos).toMatchObject([{ repo: "team/kit", state: "error", op: "git push" }]);
    expect(r.pieces[0]).toMatchObject({ ok: false, why: expect.any(String) });
    expect(st!.journal().some((l) => l.msg === "sync" && l.word === "error")).toBe(true);
  });

  // чьё: код — «сессия записала файл в клон кусочка — сведение сразу»
  it("сессия записала файл в клон своего кусочка — сведение этого клона начато сразу, без такта", async () => {
    const { home, git } = await withRepos(["team/kit"]);
    st!.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": ["team/kit"] } });
    await st!.request("profile.sync", { to: "@laptop" });
    writeFileSync(join(home, "profiles", "team__kit", "base", "CLAUDE.md"), "основа");
    const { proc } = await st!.open("site", { pieces: ["team/kit/base"] });
    const before = git.calls.length;
    await proc.hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(home, "profiles", "team__kit", "base", "memory", "note.md") } });
    await until(() => git.calls.length > before, 5000, "сведение после записи");
    expect(git.calls.slice(before)[0]!.args[0]).toBe("add");
  });
});

describe("план v2: вход Claude и ключи", () => {
  const probes = () => st!.sdk.queries.filter((q) => q.calls.some((c) => c.name === "claudeAuthenticate"));
  const proto = FakeQuery.prototype as any;
  const saved = { auth: proto.claudeAuthenticate, back: proto.claudeOAuthCallback };
  const withUrl = () => {
    proto.claudeAuthenticate = async function (this: InstanceType<typeof FakeQuery>, ...args: unknown[]) {
      this.calls.push({ name: "claudeAuthenticate", args });
      return { manualUrl: `https://claude.ai/oauth/authorize?state=s${probes().length}` };
    };
  };
  afterEach(() => {
    proto.claudeAuthenticate = saved.auth;
    proto.claudeOAuthCallback = saved.back;
  });

  // устав: вход по ссылке и коду с пульта; чьё: код — на машине один вход за раз
  it("второй вход отменяет начатый: процесс первого закрыт, код идёт ко второму", async () => {
    withUrl();
    st = await stand({ modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    const first = (await st.request("account.login", { to: "@laptop" })).result as { url: string };
    const second = (await st.request("account.login", { to: "@laptop" })).result as { url: string };
    expect(second.url).not.toBe(first.url);
    expect(probes()).toHaveLength(2);
    expect(probes()[0]!.closed).toBe(true);
    const dir = folders(st.home).newDir;
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" } }));
    writeFileSync(join(dir, ".credentials.json"), "{}");
    expect((await st.request("account.code", { to: "@laptop", login: "login", code: "код" })).ok).toBe(true);
    expect(probes()[1]!.calls.some((c) => c.name === "claudeOAuthCallback")).toBe(true);
    expect(probes()[0]!.calls.some((c) => c.name === "claudeOAuthCallback")).toBe(false);
  });

  it("Claude не дал ссылку — отказ login_failed с причиной; процесс пробы закрыт", async () => {
    proto.claudeAuthenticate = async function (this: InstanceType<typeof FakeQuery>) {
      this.calls.push({ name: "claudeAuthenticate", args: [] });
      throw new Error("нет сети");
    };
    st = await stand({ modules: [accounts()] });
    const r = await st.request("account.login", { to: "@laptop" });
    expect(r).toMatchObject({ ok: false, error: "login_failed" });
    expect(String((r as any).why)).toContain("нет сети");
    expect(probes()[0]!.closed).toBe(true);
  });

  it("код без начатого входа — отказ not_started; аккаунтов и очередей не прибавилось", async () => {
    st = await stand({ modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    expect(await st.request("account.code", { to: "@laptop", login: "login", code: "код#s" })).toMatchObject({ ok: false, error: "not_started" });
    expect((await st.request("account.list", { to: "@laptop" })).result).toEqual({ accounts: [], slots: [] });
  });

  // чьё: код — секрет не попадает в ответ и журнал
  it("Claude не принял код — отказ bad_code без самого кода в причине; вход закрыт: повторный код — not_started", async () => {
    withUrl();
    proto.claudeOAuthCallback = async (code: string) => {
      throw new Error(`invalid_grant для кода ${code}`);
    };
    st = await stand({ modules: [accounts()] });
    await st.request("account.login", { to: "@laptop" });
    const r = await st.request("account.code", { to: "@laptop", login: "login", code: "тайный-код-123" });
    expect(r).toMatchObject({ ok: false, error: "bad_code" });
    expect(String((r as any).why)).not.toContain("тайный-код-123");
    expect(JSON.stringify(st.journal())).not.toContain("тайный-код-123");
    expect(await st.request("account.code", { to: "@laptop", login: "login", code: "тайный-код-123" })).toMatchObject({ ok: false, error: "not_started" });
  });

  // устав: прямой запрос к службе не прошёл — ожидаемая ветка; чьё: код
  it("account.list: служба ключей не ответила — входы и очереди без ключей флота, не отказ", async () => {
    st = await stand({ home: homeWithAccounts({ "a@example.com": "ok" }, { main: ["a@example.com"] }), modules: [accounts()] });
    st.services.handlers["keys.list"] = () => {
      throw { word: "offline", message: "службы молчат" };
    };
    const r = await st.request("account.list", { to: "@laptop" });
    expect(r.ok).toBe(true);
    expect((r.result as any).accounts.map((a: any) => a.id)).toEqual(["a@example.com"]);
    expect((r.result as any).slots).toMatchObject([{ name: "main", account: "a@example.com" }]);
  });

  const keyStand = async (out: string, code = 0) => {
    st = await stand({ modules: [accounts(), proxy()] });
    st.services.handlers["keys.value"] = (f: any) => {
      if (f.name !== "team-key") throw { word: "not_found", message: "ключа нет" };
      return { value: "sk-тайна", provider: "anthropic", base: "https://api.example.com" };
    };
    st.sdk.cli = async (args, env, input) => {
      st!.sdk.cliCalls.push({ args, env, ...(input !== undefined ? { input } : {}) });
      return { code, out };
    };
  };

  // чьё: код — значение ключа не попадает ни в аргументы, ни в окружение разового запуска
  it("key.check: ключ принят — слова с моделью и временем; значения ключа нет в аргументах и окружении запуска", async () => {
    await keyStand(JSON.stringify({ is_error: false, result: "ok", duration_ms: 420, modelUsage: { "big-1": {} } }));
    expect((await st!.request("key.check", { to: "@laptop", name: "team-key" })).result).toEqual({ ok: true, word: "ключ принят, отвечает big-1, 420 мс" });
    const run = st!.sdk.cliCalls.at(-1)!;
    expect(JSON.stringify([run.args, run.env])).not.toContain("sk-тайна");
    expect(run.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  // чьё: код — отказ провайдера — исход проверки, а не отказ запроса
  it("key.check: провайдер отверг ключ — ответ ok: false словами самого claude, запрос не отказан", async () => {
    await keyStand(JSON.stringify({ is_error: true, result: "401 invalid x-api-key" }), 1);
    expect(await st!.request("key.check", { to: "@laptop", name: "team-key" })).toMatchObject({ ok: true, result: { ok: false, word: "401 invalid x-api-key" } });
  });

  it("key.check: ключа с таким именем нет — отказ no_account, разовый claude не запускался", async () => {
    await keyStand("{}");
    expect(await st!.request("key.check", { to: "@laptop", name: "ghost" })).toMatchObject({ ok: false, error: "no_account" });
    expect(st!.sdk.cliCalls.filter((c) => c.args.includes("-p"))).toHaveLength(0);
  });
});

describe("план v2: прокси модели", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });
  const provider = async (answer: (res: ServerResponse) => void) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => answer(res));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const session = async (base: string, home?: string) => {
    st = await stand({ ...(home ? { home } : {}), modules: [accounts(), proxy()] });
    st.services.handlers["keys.value"] = () => ({ value: "sk-real", provider: "anthropic", base });
    st.services.handlers["prefs.get"] = () => ({ values: { "proxy.rules": [] } });
    // тот же home — сессия уже есть: новый Host поднял её сам
    const s = st.kernel.sessions.get(CS) ?? (await st.open("site", { slot: "team-key" })).s;
    await until(() => s.state === "idle", 5000, "site idle");
    const url = (st.sdk.last(CS)!.options as any).env.ANTHROPIC_BASE_URL as string;
    const call = () => fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fleet", "x-claude-code-session-id": s.rec.sessionId }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "привет" }] }) });
    return { url, call };
  };

  // устав: «система ловит» — отказать и записать причину; чьё: код — отказ провайдера видит сама сессия
  it("провайдер ответил 429 — статус и тело приходят сессии как есть; обрыв сети — 502 upstream и строка журнала", async () => {
    const limited = await provider((res) => res.writeHead(429, { "content-type": "application/json" }).end('{"error":"rate"}'));
    const a = await session(limited);
    const r = await a.call();
    expect([r.status, await r.text()]).toEqual([429, '{"error":"rate"}']);
    await st!.stop();
    const dead = await session("http://127.0.0.1:9");
    const cut = await dead.call();
    expect(cut.status).toBe(502);
    expect(await cut.text()).toContain("upstream");
    expect(st!.journal().some((l) => l.msg === "proxy" && l.word === "upstream")).toBe(true);
  });

  // устав: graceful shutdown; чьё: код — оборванный вызов claude повторит на новом Host; порт тот же после перезапуска
  it("остановка Host: идущий вызов оборван после предела, в журнале proxy_stop; новый Host слушает на том же порту", async () => {
    const hanging = await provider((res) => void res.writeHead(200, { "content-type": "text/event-stream" }).write("event: ping\n\n"));
    const a = await session(hanging);
    const res = await a.call();
    expect(res.status).toBe(200);
    const home = st!.home;
    await st!.kernel.shutdown("SIGTERM");
    expect(st!.journal().some((l) => l.msg === "proxy_stop")).toBe(true);
    await st!.stop();
    const again = await session(hanging, home);
    expect(again.url).toBe(a.url);
  }, 30_000);
});

describe("план v2: точки сами", () => {
  const line = (n: number) => JSON.stringify({ type: "user", uuid: `u${n}`, message: { content: `шаг ${n}` } }) + "\n";
  const fileOf = (s: { rec: { cwd: string; sessionId: string } }) => {
    const dir = projectDir(s.rec.cwd);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${s.rec.sessionId}.jsonl`);
  };

  // чьё: код — «конец хода — точка не чаще раза в 2 мин»
  it("конец хода — точка сама; следующий ход кончился сразу — второй точки нет, хотя разговор изменился", async () => {
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site", { backup: true });
    const file = fileOf(s);
    writeFileSync(file, line(1));
    let puts = 0;
    st.services.handlers["points.put"] = () => (puts++, { upload: {}, done: true });
    await st.turn(CS);
    await until(() => puts === 1, 5000, "точка после хода");
    writeFileSync(file, line(1) + line(2));
    await st.turn(CS);
    await new Promise((r) => setTimeout(r, 150));
    expect(puts).toBe(1);
  });

  // устав: graceful shutdown — «доводит или отдаёт текущее»
  it("штатная остановка Host: идущая точка записана в архив до выхода", async () => {
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site", { backup: true });
    writeFileSync(fileOf(s), line(1));
    let release = () => {};
    let written = false;
    st.services.handlers["points.put"] = () => new Promise((r) => (release = () => ((written = true), r({ upload: {}, done: true }))));
    const saving = st.request("points.save", { to: CS });
    await until(() => st!.services.of("points.put").length === 1, 5000, "точка пошла");
    const down = st.kernel.shutdown("SIGTERM");
    await tick();
    expect(st.exits).toEqual([]);
    release();
    await down;
    expect(written).toBe(true);
    expect((await saving).ok).toBe(true);
    expect(st.exits).toEqual([0]);
  });
});
