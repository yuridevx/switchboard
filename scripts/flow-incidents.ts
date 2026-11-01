// Живая проверка инцидентов на тестовом флоте: POST на 127.0.0.1 машины A (отсюда) и машины B (curl внутри WSL).
// POST отвечает 202 с id сразу; обращение — в разговоре сессии инцидента (id в теге <incident>). Два POST одного ключа —
// одна сессия; сессию закрыли — третий POST открывает новую; чужой тип — 400 unknown_type.
// FLOW_STOP=1 — на машине B POST и сразу перезапуск Host через «выпуски»: обращение в разговоре после перезапуска.
// Каждая строка — ok или FAIL; в конце — число ok и FAIL.
// Настройка машин: host.json, раздел host-incidents — порт и тип FLOW_TYPE с папкой (профиль не нужен).
// env: FLOW_CLIENT_KEY (client.*), FLOW_A (win), FLOW_B (wsl), FLOW_PORT_A (7717), FLOW_PORT_B (7718),
//      FLOW_TYPE (flow), FLOW_WSL (дистрибутив машины B, Ubuntu-24.04), FLOW_STOP=1.
import { spawnSync } from "node:child_process";
import { link } from "@switchboard/relay";

const A = process.env.FLOW_A ?? "win";
const B = process.env.FLOW_B ?? "wsl";
const ports: Record<string, string> = { [A]: process.env.FLOW_PORT_A ?? "7717", [B]: process.env.FLOW_PORT_B ?? "7718" };
const type = process.env.FLOW_TYPE ?? "flow";
const distro = process.env.FLOW_WSL ?? "Ubuntu-24.04";
const mark = Math.random().toString(36).slice(2, 8);
const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });

const fails: string[] = [];
let oks = 0;
const check = (n: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail === undefined ? "" : " · " + JSON.stringify(detail).slice(0, 400)}`);
  if (ok) oks++;
  else fails.push(n);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await sleep(1000);
  }
  return true;
};
type Roster = { sessions: Array<Record<string, any>> };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs);
/** сессии инцидента с этим ключом в roster */
const ofKey = (key: string) => ((l.roster as Roster | null)?.sessions ?? []).filter((s) => s.incident?.type === type && s.incident?.key === key).map((s) => s.callsign as string);
const rq = async (t: string, f: Record<string, unknown>) => (await l.request({ type: t, v: 1, ...f })) as { ok: boolean; error?: string; result?: unknown };
/** обращение с этим id — в разговоре сессии */
const got = (cs: string, id: unknown) => until(async () => JSON.stringify(await rq("session.history", { callsign: cs, before: null, limit: 30 })).includes(String(id)), 180000);

/** POST /incident на машине: A — отсюда, B — curl внутри WSL (там свой 127.0.0.1). */
async function post(machine: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${ports[machine]}/incident`;
  if (machine === A) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }
  // wsl.exe склеивает аргументы в строку для bash: тело — через stdin, в аргументах ни пробелов, ни переводов строки
  const r = spawnSync("wsl.exe", ["-d", distro, "--", "curl", "-s", "-w", "HTTP%{http_code}", "-H", "content-type:application/json", "--data-binary", "@-", url], {
    encoding: "utf8",
    input: JSON.stringify(body),
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  const at = r.stdout.lastIndexOf("HTTP");
  if (at < 0) throw new Error(`curl на ${machine}: ${r.stderr.trim() || "пустой ответ"}`);
  return { status: Number(r.stdout.slice(at + 4)), body: JSON.parse(r.stdout.slice(0, at)) as Record<string, unknown> };
}

try {
  check("связь", await until(() => l.state === "open", 15000));
  for (const m of [A, B]) {
    const key = `${mark}-${m}`;
    const text = "Это проверка связи: ничего не делай, ответь одним словом «ок».";
    const t0 = Date.now();
    const one = await post(m, { type, key, text });
    const ms = Date.now() - t0;
    check(`${m}: POST — 202 с id сразу`, one.status === 202 && typeof one.body.id === "string", { ...one, ms });
    const found = await until(() => ofKey(key).length === 1, 120000);
    const cs = ofKey(key)[0];
    check(`${m}: сессия инцидента в roster с полем incident`, found && cs?.endsWith(`@${m}`), cs);
    check(`${m}: первое обращение в разговоре сессии`, await got(cs, one.body.id));
    const two = await post(m, { type, key, text });
    check(`${m}: второй POST того же ключа — в разговоре той же сессии`, two.status === 202 && (await got(cs, two.body.id)) && ofKey(key).length === 1, { two, sessions: ofKey(key) });
    await until(() => rec(cs)?.state === "idle", 120000);
    const rm = await rq("session.remove", { callsign: cs });
    check(`${m}: сессия закрыта`, rm.ok && (await until(() => !rec(cs), 60000)), rm);
    const three = await post(m, { type, key, text });
    const again = (await until(() => ofKey(key).length === 1, 120000)) ? ofKey(key)[0] : undefined;
    check(`${m}: POST после закрытия — новая сессия, обращение в её разговоре`, three.status === 202 && !!again && (await got(again, three.body.id)), { three, again });
    const bad = await post(m, { type: `нет-${mark}`, text });
    check(`${m}: чужой тип — 400 unknown_type`, bad.status === 400 && bad.body.error === "unknown_type", bad);
    if (process.env.FLOW_STOP === "1" && m === B) {
      const four = await post(m, { type, key, text });
      const off = await rq("releases.set", { to: ".releases", machine: B, part: "host", on: false });
      const gone = await until(() => !l.roster?.machines.some((x: { machine: string }) => x.machine === B), 120000);
      const on = await rq("releases.set", { to: ".releases", machine: B, part: "host", on: true });
      const back = await until(() => !!l.roster?.machines.some((x: { machine: string }) => x.machine === B), 120000);
      check(`${m}: POST и сразу перезапуск Host — Host снова на связи`, four.status === 202 && off.ok && gone && on.ok && back, { four, off, on, gone, back });
      const after = (await until(() => ofKey(key).length >= 1, 120000)) ? ofKey(key)[0] : undefined;
      check(`${m}: обращение до перезапуска — в разговоре сессии после него`, !!after && (await got(after, four.body.id)), { after, sessions: ofKey(key) });
    }
  }
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  for (const s of (l.roster as Roster | null)?.sessions ?? []) if (String(s.incident?.key ?? "").startsWith(mark)) await rq("session.remove", { callsign: s.callsign });
  console.log(`итого: ${oks} ok, ${fails.length} FAIL${fails.length ? " — " + fails.join("; ") : ""}`);
  process.exitCode = fails.length ? 1 : 0;
  l.close(1000, "done");
}
