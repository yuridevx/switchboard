// Эталоны второй итерации: остаток сверки в Host.
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { stand, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const PULT = "pult~yuri@example.com";
const PHONE = "phone~yuri@example.com";
const events = (s: Stand) => s.link.of("session.events").flatMap((f) => f.events as any[]);

describe("вопрос человеку", () => {
  it("в строке — кому вопрос и кто его видел; после ответа в ленте — кто ответил и чем", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    await st.request("message", { to: "site@laptop", text: "выкладывай" }, PULT);
    await st.request("session.watch", { to: "site@laptop" }, PHONE);
    const input = { questions: [{ question: "Какую ветку?", options: [{ label: "main" }, { label: "release" }] }] };
    const asked = proc.ask("AskUserQuestion", input, "q-1");
    const row = await until(() => (st!.link.rows("site@laptop").at(-1)!.row as any).ask, 5000, "вопрос в строке");
    expect(row).toMatchObject({ id: "q-1", to: PULT, seen: [PULT, PHONE] });
    expect((await st.request("answer", { to: "site@laptop", ask: "q-1", answer: "main" }, PHONE)).ok).toBe(true);
    await asked;
    const done = await until(() => events(st!).find((e) => e.type === "ask.answered"), 5000, "итог вопроса в ленте");
    expect(done).toMatchObject({ type: "ask.answered", ask: "q-1", kind: "question", by: PHONE, answer: "main" });
  });
});

/* ===== точки ===== */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { make as points, projectDir, RETRY_MS } from "../src/modules/points/points.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
async function store(body?: () => Buffer) {
  const s = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.writeHead(200).end(body ? body() : "{}"));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe("точки: ветки, повтор, сверка", () => {
  it("точка называет ту, от которой продолжена; сбой — причина и час повтора в строке, удача снимает оба", async () => {
    const url = await store();
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site", { backup: true });
    const dir = projectDir(s.rec.cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.rec.sessionId}.jsonl`);
    const line = (n: number) => JSON.stringify({ type: "user", uuid: `u${n}`, message: { content: `шаг ${n}` } }) + "\n";
    writeFileSync(file, line(1));
    const puts: any[] = [];
    const good = (f: any) => {
      puts.push(f);
      return f.commit ? { upload: {}, done: true } : { upload: Object.fromEntries((f.files as any[]).flatMap((x) => x.blocks).map((h: string) => [h, `${url}/b/${h}`])), done: false };
    };
    st.services.handlers["points.put"] = good;
    const first = (await st.request("points.save", { to: "site@laptop" })).result as { point: string };
    expect(puts[0].base).toBeUndefined();
    appendFileSync(file, line(2));
    await st.request("points.save", { to: "site@laptop" });
    expect(puts.at(-1).base).toBe(first.point);

    appendFileSync(file, line(3));
    st.services.handlers["points.put"] = () => {
      throw { word: "store_failed", message: "архив не отвечает" };
    };
    const t0 = st.clock.now();
    expect(await st.request("points.save", { to: "site@laptop" })).toMatchObject({ ok: false, error: "store_failed" });
    const row = st.link.rows("site@laptop").at(-1)!.row as any;
    expect(row.archiveError).toContain("архив не отвечает");
    expect(row.archiveRetryAt).toBeGreaterThanOrEqual(t0 + RETRY_MS);
    st.services.handlers["points.put"] = good;
    expect((await st.request("points.save", { to: "site@laptop" })).ok).toBe(true);
    const after = st.link.rows("site@laptop").at(-1)!.row as any;
    expect(after.archiveError).toBeUndefined();
    expect(after.archiveRetryAt).toBeUndefined();
  });

  it("подъём называет архиву, кто его начал и какую точку видел; первая точка копии продолжает точку, с которой поднята", async () => {
    const text = JSON.stringify({ type: "user", uuid: "u1", message: { content: "привет" } }) + "\n";
    const hash = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
    const url = await store(() => gzipSync(Buffer.from(text)));
    st = await stand({ modules: [points()] });
    const gets: any[] = [];
    st.services.handlers["points.get"] = (f) => {
      gets.push(f);
      return { session: { sid: "sid-old", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 1, last: 1 }, point: { point: "p1", at: 1 }, files: [{ path: "sid-old.jsonl", size: text.length, blocks: [{ hash, url: `${url}/b/${hash}` }] }] };
    };
    const raised = await st.request("points.raise", { to: "@laptop", sid: "sid-old", name: "docs-copy", expect: "p1" }, PULT);
    expect(raised).toMatchObject({ ok: true, result: { callsign: "docs-copy@laptop" } });
    expect(gets[0]).toMatchObject({ sid: "sid-old", expect: "p1", by: PULT });
    expect(gets[0].move).toBeUndefined();

    const copy = st.kernel.sessions.get("docs-copy@laptop")!;
    writeFileSync(join(projectDir(copy.rec.cwd), `${copy.rec.sessionId}.jsonl`), text);
    const puts: any[] = [];
    st.services.handlers["points.put"] = (f) => (puts.push(f), { upload: {}, done: true });
    expect((await st.request("points.save", { to: "docs-copy@laptop" })).ok).toBe(true);
    expect(puts[0].base).toBe("sid-old/p1");
  });
});
