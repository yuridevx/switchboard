// Эталоны третьей итерации Host: срок входа у аккаунта, предел повторов точки и точка остановленной сессии, снятие архива,
// порт сервера инцидентов в журнале, ответ «из уведомления», числа Host для наблюдения.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostMetrics } from "@sb/protocol";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { folders } from "../src/modules/accounts/links.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as incidents } from "../src/modules/incidents/incidents.ts";
import { make as machine } from "../src/modules/machine/machine.ts";
import { make as points, projectDir } from "../src/modules/points/points.ts";
import { stand, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastRow = (cs: string) => st!.link.rows(cs).at(-1)!.row as any;

/** Хранилище блоков: принимает загрузку по ссылке. */
async function store(): Promise<string> {
  const s = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.writeHead(200).end("{}"));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
/** Сессия с архивом и файлом разговора; puts — принятые запросы точки; fail — архив отказывает. */
async function withConversation(o: { retryMs?: number; waitMs?: number } = {}) {
  const url = await store();
  st = await stand({ modules: [points(o)] });
  const { s } = await st.open("site", { backup: true });
  const dir = projectDir(s.rec.cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.rec.sessionId}.jsonl`);
  let n = 0;
  const more = () => appendFileSync(file, JSON.stringify({ type: "user", uuid: `u${++n}`, message: { content: `шаг ${n}` } }) + "\n");
  more();
  const state = { fail: false, puts: [] as any[], tries: 0 };
  st.services.handlers["points.put"] = (f: any) => {
    state.tries++;
    if (state.fail) throw { word: "store_failed", message: "архив не отвечает" };
    state.puts.push(f);
    return f.commit ? { upload: {}, done: true } : { upload: Object.fromEntries((f.files as any[]).flatMap((x) => x.blocks).map((h: string) => [h, `${url}/b/${h}`])), done: false };
  };
  return { s, more, state };
}

describe("аккаунты", () => {
  it("у входа Claude в списке — срок входа и время последнего замера лимитов", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    mkdirSync(join(home, "store"), { recursive: true });
    const at = Math.floor(Date.now() / 1000), expires = at + 30 * 86400;
    const book = { accounts: { "a@example.com": { login: "ok", plan: "max", expires, limits: { five_hour: { utilization: 0.2, resetsAt: at + 600, at: at - 30 }, seven_day: { utilization: 0.4, resetsAt: at + 9000, at } } } }, slots: { main: ["a@example.com"] } };
    writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: book }));
    mkdirSync(folders(home).accDir("a@example.com"), { recursive: true });
    await folders(home).place("main", "a@example.com");
    st = await stand({ home, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    const reply = await st.request("account.list", { to: "@laptop" });
    expect(reply.why ?? reply.error ?? "").toBe("");
    const [a] = (reply.result as any).accounts;
    expect(a.expires).toBe(expires * 1000);
    expect(a.at).toBe(at * 1000);
    expect(a.limits.find((l: any) => l.name === "five_hour").at).toBe((at - 30) * 1000);
  });
});

describe("точки: предел повторов, остановленная сессия, снятие архива", () => {
  /** Двигать часы стенда шагами, пока условие не выполнится: повторы точек идут по часам ядра. */
  const ticking = async (cond: () => boolean, label: string) => {
    for (let i = 0; i < 300 && !cond(); i++) {
      st!.clock.advance(20);
      await wait(5);
    }
    if (!cond()) throw new Error("не дождались: " + label);
  };

  it("сбой точки повторяется сам до предела от первого сбоя; срок виден в строке; после предела повторов нет, причина остаётся", async () => {
    const { state } = await withConversation({ retryMs: 40, waitMs: 150 });
    state.fail = true;
    const t0 = st!.clock.now();
    expect(await st!.request("points.save", { to: "site@laptop" })).toMatchObject({ ok: false, error: "store_failed" });
    const first = lastRow("site@laptop");
    expect(first.archiveError).toContain("архив не отвечает");
    expect(first.archiveUntil).toBeGreaterThanOrEqual(t0 + 150);
    expect(first.archiveUntil).toBeLessThan(t0 + 150 + 1000);
    expect(first.archiveRetryAt).toBeGreaterThanOrEqual(t0 + 40);
    await ticking(() => !lastRow("site@laptop").archiveRetryAt, "повторы кончились");
    const tries = state.tries;
    expect(tries).toBeGreaterThanOrEqual(2); // сам запрос и хотя бы один повтор
    expect(tries).toBeLessThanOrEqual(1 + Math.ceil(150 / 40));
    st!.clock.advance(120);
    await wait(30);
    expect(state.tries).toBe(tries);
    const after = lastRow("site@laptop");
    expect(after.archiveError).toContain("архив не отвечает");
    expect(after.archiveUntil).toBe(first.archiveUntil);
  });

  it("остановленная сессия с несохранённой точкой повторяет сохранение; удача снимает причину и срок", async () => {
    const { more, state } = await withConversation({ retryMs: 40, waitMs: 60_000 });
    more();
    state.fail = true;
    expect((await st!.request("session.stop", { to: "site@laptop" })).ok).toBe(true);
    await ticking(() => state.tries >= 2, "повтор у остановленной");
    expect(lastRow("site@laptop")).toMatchObject({ state: "stopped", archiveError: expect.stringContaining("архив не отвечает") });
    state.fail = false;
    await ticking(() => state.puts.some((p) => p.commit), "точка записана");
    await ticking(() => !lastRow("site@laptop").archiveError, "причина снята");
    expect(lastRow("site@laptop").archiveUntil).toBeUndefined();
    expect(lastRow("site@laptop").archiveRetryAt).toBeUndefined();
  });

  it("снятие архива у сессии: новых точек нет, прежние остаются в архиве — служба об удалении не слышит", async () => {
    const { more, state } = await withConversation();
    expect((await st!.request("points.save", { to: "site@laptop" })).ok).toBe(true);
    const saved = state.puts.length;
    expect(saved).toBeGreaterThan(0);
    expect((await st!.request("session.update", { to: "site@laptop", patch: { backup: false } })).ok).toBe(true);
    more();
    expect((await st!.request("session.stop", { to: "site@laptop" })).ok).toBe(true);
    await wait(80);
    expect(state.puts).toHaveLength(saved);
    expect(st!.services.of("points.delete")).toHaveLength(0);
    // архив вернули — остановленная сессия сохраняется снова
    expect((await st!.request("session.update", { to: "site@laptop", patch: { backup: true } })).ok).toBe(true);
    await until(() => state.puts.length > saved, 5000, "точка после возврата архива");
  });
});

describe("инциденты", () => {
  it("порт 0: в журнале машины и в списке — настоящий порт сервера", async () => {
    st = await stand({ modules: [chat(), incidents()], config: { "host-incidents": { port: 0 } } });
    const port = ((await st.request("incident.list", { to: "@laptop" })).result as any).port as number;
    expect(port).toBeGreaterThan(0);
    const line = st.journal().find((l) => l.msg === "incident_listen");
    expect(line).toMatchObject({ port, why: expect.stringContaining(`127.0.0.1:${port}/incident`) });
  });
});

describe("вопрос человеку", () => {
  it("ответ кнопкой уведомления помечен в итоге вопроса; ответ со страницы — без пометки", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    const PULT = "pult~yuri@example.com";
    await st.request("message", { to: "site@laptop", text: "выкладывай" }, PULT);
    await st.request("session.watch", { to: "site@laptop" }, PULT);
    const events = () => st!.link.of("session.events").flatMap((f) => f.events as any[]);
    const ask = (id: string) => proc.ask("AskUserQuestion", { questions: [{ question: "Какую ветку?", options: [{ label: "main" }, { label: "release" }] }] }, id);
    const a1 = ask("q-1");
    await until(() => lastRow("site@laptop").ask?.id === "q-1", 5000, "вопрос");
    expect((await st.request("answer", { to: "site@laptop", ask: "q-1", answer: "main", via: "push" }, PULT)).ok).toBe(true);
    await a1;
    expect(await until(() => events().find((e) => e.type === "ask.answered" && e.ask === "q-1"), 5000, "итог")).toMatchObject({ by: PULT, answer: "main", via: "push" });
    const a2 = ask("q-2");
    await until(() => lastRow("site@laptop").ask?.id === "q-2", 5000, "второй вопрос");
    await st.request("answer", { to: "site@laptop", ask: "q-2", answer: "release" }, PULT);
    await a2;
    const second = await until(() => events().find((e) => e.type === "ask.answered" && e.ask === "q-2"), 5000, "второй итог");
    expect(second.via).toBeUndefined();
  });
});

describe("числа Host для наблюдения", () => {
  it("раз в такт Host отдаёт службе окно: сессии по состояниям, очередь, время провайдера, сбои и возобновления; новое окно — с нуля", async () => {
    st = await stand({ modules: [chat(), machine({ metricsMs: 40 })] });
    const sent: HostMetrics[] = [];
    st.services.handlers["obs.metrics"] = (f: any) => {
      sent.push(f);
      return {};
    };
    const { s, proc } = await st.open("site");
    await st.open("docs");
    for (const ms of [100, 200, 300, 400, 2000]) st.kernel.meter.time("provider", ms);
    st.kernel.meter.count("provider.failed");
    proc.exit(1, "упал");
    await until(() => st!.holders.spawns.length === 3 && s.state === "idle", 5000, "resume");
    // замеры и сбой могут попасть в соседние окна: каждое проверяется там, где оказалось
    const m = await until(() => sent.find((x) => x.crashes === 1), 5000, "окно со сбоем");
    expect(m).toMatchObject({ build: 1, crashes: 1, resumes: 1, queue: 0 });
    expect(Object.values(m.sessions).reduce((a, b) => a + b, 0)).toBe(2);
    const timed = await until(() => sent.find((x) => x.provider.n > 0), 5000, "окно с замерами");
    expect(timed.provider).toEqual({ n: 5, p50: 300, p95: 2000, failed: 1, retries: 0 });
    // следующее окно — без прежних сбоев и замеров
    const n = sent.length;
    const next = await until(() => sent[n + 1], 5000, "следующее окно");
    expect(next).toMatchObject({ crashes: 0, resumes: 0, provider: { n: 0, p50: 0, p95: 0, failed: 0 }, sessions: { idle: 2 } });
    // запрос машины отдаёт числа последнего окна и нынешние сессии
    const now = (await st.request("machine.metrics", { to: "@laptop" })).result as HostMetrics;
    expect(now.sessions).toEqual({ idle: 2 });
    expect(now.provider.n).toBe(0);
  });

  it("служба не ответила — строка журнала, Host работает дальше", async () => {
    st = await stand({ modules: [machine({ metricsMs: 30 })] });
    st.services.handlers["obs.metrics"] = () => {
      throw { word: "offline", message: "службы молчат" };
    };
    await until(() => st!.journal().some((l) => l.msg === "metrics" && l.word === "offline"), 5000, "строка журнала");
    expect((await st.request("machine.dirs", { to: "@laptop", path: st.dir })).ok).toBe(true);
  });
});
