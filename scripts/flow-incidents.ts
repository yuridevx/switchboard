// Живая проверка инцидентов на тестовом флоте: POST на 127.0.0.1 машины A (отсюда) и машины B (curl внутри WSL).
// Два POST одного ключа — одна сессия; сессию закрыли — третий POST открывает новую; чужой тип — 400 unknown_type.
// Каждая строка — ok или FAIL; в конце — число ok и FAIL.
// Настройка машин: host.json, раздел host-incidents — порт и тип FLOW_TYPE с папкой (профиль не нужен).
// env: FLOW_CLIENT_KEY (client.*), FLOW_A (win), FLOW_B (wsl), FLOW_PORT_A (7717), FLOW_PORT_B (7718),
//      FLOW_TYPE (flow), FLOW_WSL (дистрибутив машины B, Ubuntu-24.04).
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
const opened: string[] = [];

/** POST /incident на машине: A — отсюда, B — curl внутри WSL (там свой 127.0.0.1). */
async function post(machine: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${ports[machine]}/incident`;
  if (machine === A) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }
  const r = spawnSync("wsl.exe", ["-d", distro, "--", "curl", "-s", "-w", "\n%{http_code}", "-H", "content-type: application/json", "-d", JSON.stringify(body), url], {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  const [text, code] = r.stdout.trimEnd().split(/\n(?=\d+$)/);
  return { status: Number(code), body: JSON.parse(text) as Record<string, unknown> };
}

try {
  check("связь", await until(() => l.state === "open", 15000));
  for (const m of [A, B]) {
    const key = `${mark}-${m}`;
    const text = "Это проверка связи: ничего не делай, ответь одним словом «ок».";
    const one = await post(m, { type, key, text });
    const cs = one.body.callsign as string;
    if (cs) opened.push(cs);
    check(`${m}: первый POST — новая сессия`, one.status === 200 && one.body.new === true && cs?.endsWith(`@${m}`), one);
    const two = await post(m, { type, key, text });
    check(`${m}: второй POST того же ключа — та же сессия`, two.status === 200 && two.body.new === false && two.body.callsign === cs, two);
    check(`${m}: поле incident в roster`, await until(() => rec(cs)?.incident?.key === key, 60000), rec(cs)?.incident);
    const rm = (await l.request({ type: "session.remove", v: 1, callsign: cs })) as { ok: boolean };
    check(`${m}: сессия закрыта`, rm.ok && (await until(() => !rec(cs), 60000)), rm);
    const three = await post(m, { type, key, text });
    if (three.body.callsign) opened.push(three.body.callsign as string);
    check(`${m}: POST после закрытия — новая сессия`, three.status === 200 && three.body.new === true, three);
    const bad = await post(m, { type: `нет-${mark}`, text });
    check(`${m}: чужой тип — 400 unknown_type`, bad.status === 400 && bad.body.error === "unknown_type", bad);
  }
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  for (const cs of opened) if (rec(cs)) await l.request({ type: "session.remove", v: 1, callsign: cs });
  console.log(`итого: ${oks} ok, ${fails.length} FAIL${fails.length ? " — " + fails.join("; ") : ""}`);
  process.exitCode = fails.length ? 1 : 0;
  l.close(1000, "done");
}
