// Живой прогон «Прокси модели» на одной машине: правило прокси → модель видит замену, файл разговора — как написал claude;
// архив: пометка, каталог со сводкой, points.history = session.history, копия из точки помнит разговор; ключ флота в памяти:
// key_check и ход сессии на ключе. env: FLOW_CLIENT_KEY (пропуск человека), FLOW_MACHINE, FLOW_SLOT (слот-аккаунт),
// FLOW_DIR (~/sb-flow), FLOW_KEY_FILE — файл ключа Orca (значение читает сценарий, в argv не попадает).
import { readFileSync } from "node:fs";
import { client, WORKERS } from "./client.ts";

const KEY = process.env.FLOW_CLIENT_KEY!;
const M = process.env.FLOW_MACHINE!;
const SLOT = process.env.FLOW_SLOT ?? "main";
const DIR = process.env.FLOW_DIR ?? "~/sb-flow";
const KEY_FILE = process.env.FLOW_KEY_FILE;
const WORD = "ЗЕБРА-777";
const SEEN = "ЖИРАФ-555";
const NAME = "archlive";
const CS = `${NAME}@${M}`;
const COPY = `archcopy@${M}`;
const KEYED = `keylive@${M}`;
const ORCA = "orca-live";

const l = client(KEY, { machine: M });
const results: Array<[string, boolean, string]> = [];
const check = (what: string, ok: boolean, detail = "") => {
  results.push([what, ok, detail]);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` · ${detail}` : ""}`);
};
const wait = async <T>(what: string, get: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T> => {
  for (const t0 = Date.now(); ; ) {
    const v = await get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`не дождался: ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const req = async (f: Record<string, unknown>, v = 1) => {
  const r = await l.request({ v, ...f } as never);
  if (!r.ok) throw new Error(`${f.type}: ${(r as { error?: string }).error} ${(r as { why?: string }).why ?? ""}`);
  return r.result as any;
};
/** POST в Worker пропуском человека, как страница. */
const post = async (worker: string, f: Record<string, unknown>) => {
  const r = (await (await fetch(WORKERS[worker], { method: "POST", body: JSON.stringify({ id: "f", key: KEY, ...f }), signal: AbortSignal.timeout(60_000) })).json()) as any;
  if (!r.ok) throw new Error(`${f.type}: ${r.error} ${r.why ?? ""}`);
  return r.result;
};
const state = (cs: string) => l.roster?.sessions.find((s) => s.callsign === cs)?.state;
const history = async (cs: string) => (await req({ type: "session.history", callsign: cs, before: null, limit: 400 })).messages as any[];
const textOf = (m: any) => {
  const c = m?.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join(" ") : "";
};
/** Ответ модели после prompt: последний текст ассистента, который пришёл позже вопроса. */
async function ask(cs: string, text: string, ms = 240_000): Promise<string> {
  const before = (await history(cs)).length;
  await req({ type: "session.prompt", callsign: cs, text });
  return wait(`ответ ${cs}`, async () => {
    if (state(cs) !== "idle") return undefined;
    const said = (await history(cs)).slice(before).filter((m) => m.type === "assistant").map(textOf).join(" ").trim();
    return said || undefined;
  }, ms);
}
const open = async (name: string, slot: string) => {
  await l.request({ type: "session.remove", v: 1, callsign: `${name}@${M}` } as never).catch(() => {});
  const r = await req({ type: "session.open", machine: M, name, dir: DIR, slot }, 2);
  await wait(`${r.callsign} idle`, () => state(r.callsign) === "idle", 120_000);
  return r.callsign as string;
};

try {
  await wait("roster машины", () => l.roster?.machines.some((m) => m.machine === M), 30_000);
  const mc = l.roster!.machines.find((m) => m.machine === M)!.contract ?? {};
  check("контракт машины: session.archive и machine.key_check, session.r2 нет", "session.archive" in mc && "machine.key_check" in mc && !("session.r2" in mc));

  // ключ флота — первым: FLOW_SLOT может быть им (слот-аккаунт у порога лимита)
  if (KEY_FILE) {
    const value = readFileSync(KEY_FILE, "utf8").trim();
    const env = { ANTHROPIC_BASE_URL: "https://api.orcarouter.ai", ANTHROPIC_DEFAULT_OPUS_MODEL: "orca/orcacyber-flash-1.0", ANTHROPIC_DEFAULT_SONNET_MODEL: "orca/orcacyber-flash-1.0", ANTHROPIC_DEFAULT_HAIKU_MODEL: "orca/orcacyber-flash-1.0", ANTHROPIC_DEFAULT_FABLE_MODEL: "orca/orcacyber-flash-1.0", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" };
    await post("fleetkeys", { type: "fleetkeys.set", v: 1, to: ".fleetkeys", name: ORCA, env, value });
    await new Promise((r) => setTimeout(r, 5000));
  }

  // 18 вживую: правило прокси флота
  await post("prefs", { type: "prefs.set", v: 1, to: ".prefs", scope: "global", name: "proxy.rules", value: [{ name: "live", scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: WORD, replacement: SEEN }] });
  await open(NAME, SLOT);
  const said = await ask(CS, `Повтори дословно это слово и больше ничего не пиши: ${WORD}`);
  check("18 · провайдер видит текст после правила: модель повторила замену", said.includes(SEEN) && !said.includes(WORD), said.slice(0, 80));
  const mine = (await history(CS)).filter((m) => m.type === "user").map(textOf).join(" ");
  check("18 · файл разговора — как написал claude, до правил", mine.includes(WORD) && !mine.includes(SEEN));

  // архив: пометка, каталог, разговор
  const mark = await req({ type: "session.archive", callsign: CS, on: true });
  check("session.archive: первая точка", typeof mark.point === "number", `точка ${mark.point}`);
  await wait("поле roster archive", () => JSON.stringify(l.roster?.sessions.find((s) => s.callsign === CS)?.archive) === "{}", 30_000);
  const cat = await post("points", { type: "points.list", v: 2, to: ".points" });
  const row = cat.sessions.find((x: any) => x.callsign === CS);
  check("27 · каталог: заголовок, модель, токены из точки", !!row?.title && !!row?.model && row?.tok_in > 0 && row?.tok_out > 0, JSON.stringify({ title: row?.title, model: row?.model, tok_in: row?.tok_in, tok_out: row?.tok_out }));
  const q = await fetch(WORKERS.points, { method: "POST", body: JSON.stringify({ id: "q", key: KEY, type: "points.list", v: 2, q: WORD }) }).then((r) => r.json() as any);
  check("36 · хранилище R2: поиск — no_search, каталог search: false", q.error === "no_search" && cat.search === false);
  const t0 = Date.now();
  const arch = await post("points", { type: "points.history", v: 1, to: ".points", sid: row.sid, before: null, limit: 400 });
  const live = await history(CS);
  const same = JSON.stringify(arch.messages.map((m: any) => [m.uuid, m.type])) === JSON.stringify(live.map((m: any) => [m.uuid, m.type]));
  check("39 · points.history = session.history живой сессии", same, `${arch.messages.length} = ${live.length}, ${Date.now() - t0} мс`);
  check("38 · вызовы модели из файла: модель, токены, system", arch.calls.length >= 1 && arch.calls.every((c: any) => c.model && c.tok_in > 0 && c.system.length > 100), `вызовов ${arch.calls.length}`);

  // копия из точки помнит разговор
  await l.request({ type: "session.remove", v: 1, callsign: COPY } as never).catch(() => {});
  const raised = await req({ type: "points.raise", machine: M, sid: row.sid, point: mark.point, copy: true, dir: "~/sb-copy", name: "archcopy", files: "point" });
  await wait(`${raised.callsign} idle`, () => state(raised.callsign) === "idle", 120_000);
  const recall = await ask(raised.callsign, "Какое слово ты повторил в этом разговоре? Напиши только его.");
  check("подъём копии из точки: разговор на месте", recall.includes(SEEN) || recall.includes(WORD), recall.slice(0, 80));

  // 21 вживую: ключ флота в памяти, проверка и ход
  if (KEY_FILE) {
    const kc = await req({ type: "machine.key_check", machine: M, name: ORCA });
    check("key_check ключа флота через прокси", kc.ok === true, String(kc.word));
    await open("keylive", ORCA);
    const pong = await ask(KEYED, "Ответь одним словом: pong");
    check("21 · ход сессии на ключе флота: ключ из памяти logins", /pong/i.test(pong), pong.slice(0, 60));
  }
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  for (const cs of [COPY, KEYED]) await l.request({ type: "session.remove", v: 1, callsign: cs } as never).catch(() => {});
  await l.request({ type: "session.archive", v: 1, callsign: CS, on: false } as never).catch(() => {});
  await l.request({ type: "session.remove", v: 1, callsign: CS } as never).catch(() => {});
  await post("prefs", { type: "prefs.set", v: 1, to: ".prefs", scope: "global", name: "proxy.rules", value: [] }).catch((e) => console.log("правила:", e.message));
  if (KEY_FILE) await post("fleetkeys", { type: "fleetkeys.remove", v: 1, to: ".fleetkeys", name: ORCA }).catch((e) => console.log("ключ:", e.message));
  l.close(1000, "done");
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`archive: ${results.length - bad} ok, ${bad} FAIL`);
  process.exitCode = bad ? 1 : 0;
}
