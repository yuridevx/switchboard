// Живой смоук флота: две стороны подключаются к выложенному relay, проверяют roster, участников и доставку.
// Ключи флота — из env SMOKE_HOST_KEY и SMOKE_CLIENT_KEY (выдаёт switchboard invite). Адрес — SWITCHBOARD_URL.
import type { Roster } from "@switchboard/relay";
import { client, type Client } from "./client.ts";

const hostKey = process.env.SMOKE_HOST_KEY;
const clientKey = process.env.SMOKE_CLIENT_KEY;
if (!hostKey || !clientKey) {
  console.error("smoke: нужны SMOKE_HOST_KEY и SMOKE_CLIENT_KEY");
  process.exit(2);
}

const fails: string[] = [];
const check = (what: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : " · " + JSON.stringify(detail)}`);
  if (!ok) fails.push(what);
};
const open = (l: Client) =>
  new Promise<void>((res, rej) => {
    const t = setInterval(() => {
      if (l.state === "open") {
        clearInterval(t);
        res();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(t);
      rej(new Error("нет связи за 15 с, state " + l.state));
    }, 15000);
  });

const got: unknown[] = [];
const host = client(hostKey, {
  machine: "smoke",
  hello: () => ({ sdk: "smoke", contract: { "smoke.echo": 1 }, sessions: [{ callsign: "probe@smoke", state: "idle" }] }),
  onFrame: (f) => {
    if (f.type === "smoke.echo" && f.id) host.send({ type: "reply", id: f.id, to: f.from, ok: true, result: { echo: f.text } });
  },
});
const phone = client(clientKey, { onFrame: (f) => got.push(f) });

try {
  await open(host);
  await open(phone);
  await new Promise((r) => setTimeout(r, 800));
  const r = phone.roster as Roster;
  check("roster: машина smoke", !!r?.machines.some((m) => m.machine === "smoke"), r?.machines.map((m) => m.machine));
  check("roster: сессия probe@smoke", !!r?.sessions.some((s) => s.callsign === "probe@smoke"));
  // клиент в roster — адрес устройства: имя из ключа client.<имя>.… и email владельца флота
  const me = clientKey!.split(".")[1];
  check(`roster: клиент ${me}~владелец`, !!r?.clients.some((c) => c.startsWith(`${me}~`) && c.length > me.length + 1), r?.clients);
  const workers = (r?.workers ?? []).map((w) => w.name).sort();
  check("roster: участники push, points, ledger, github", ["github", "ledger", "points", "push"].every((n) => workers.includes(n)), workers);

  const echo = await phone.request({ type: "smoke.echo", v: 1, machine: "smoke", text: "привет" });
  check("запрос клиента → Host машины и ответ", echo.ok === true && (echo as { result?: { echo?: string } }).result?.echo === "привет", echo);

  const key = await phone.request({ type: "push.key", v: 1, to: ".push" });
  check("push.key у Worker push", key.ok === true && typeof (key as { result?: { key?: string } }).result?.key === "string", key);

  const led = await phone.request({ type: "ledger.read", v: 1, to: ".ledger", limit: 20 });
  check("ledger.read у Worker ledger", led.ok === true, led.ok ? (led as { result?: { events?: Array<{ ev: string; machine?: string }> } }).result?.events?.map((e) => `${e.ev}:${e.machine}`) : led);

  const off = await phone.request({ type: "smoke.echo", v: 1, machine: "nobody", text: "x" });
  check("машины нет — offline", off.ok === false && (off as { error?: string }).error === "offline", off);
} catch (e) {
  check("связь", false, String(e));
} finally {
  host.close(1000, "shutting_down");
  phone.close(1000, "shutting_down");
}

// подделанный ключ — отказ relay
const bad = client(clientKey.slice(0, -2) + "xx");
const why = await new Promise<string>((res) => {
  const t = setInterval(() => {
    if (bad.state !== "connecting" && bad.state !== "open") {
      clearInterval(t);
      res(bad.state);
    }
  }, 50);
  setTimeout(() => res("timeout " + bad.state), 10000);
});
bad.close();
check("подделанный ключ не пускают", why !== "open" && !why.startsWith("timeout"), why);

console.log(fails.length ? `smoke: ${fails.length} провалов` : "smoke: ok");
process.exit(fails.length ? 1 : 0);
