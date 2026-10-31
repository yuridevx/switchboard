// Живые аккаунты и слоты на машине — до шага, где нужен человек: настоящая ссылка входа claude.ai,
// отказ на неверный код, список аккаунтов, слот без аккаунтов. env: FLOW_CLIENT_KEY, FLOW_MACHINE.
import { link } from "@switchboard/relay";

const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });
const machine = process.env.FLOW_MACHINE!;
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
const req = (f: Record<string, unknown>) => l.request({ v: 1, machine, ...f } as never) as Promise<{ ok: boolean; result?: any; error?: string }>;
for (let i = 0; l.state !== "open" && i < 150; i++) await new Promise((r) => setTimeout(r, 100));

const acc = "probe";
const list0 = await req({ type: "machine.accounts" });
check("machine.accounts отвечает списком", list0.ok && typeof list0.result?.accounts === "object", list0.result ?? list0.error);
const login = await req({ type: "machine.login", account: acc });
const url = String(login.result?.url ?? "");
check("machine.login — ссылка входа claude.ai для своей папки аккаунта", login.ok && /^https:\/\/(claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com)\//.test(url) && /code_challenge=/.test(url), url.slice(0, 120));
if (url) {
  const page = await fetch(url, { redirect: "manual" });
  check("ссылка входа отвечает (страница входа или переадресация)", page.status < 500, page.status);
}
const bad = await req({ type: "machine.login_code", account: acc, code: "неверный-код#state" });
check("machine.login_code с неверным кодом — отказ словом", !bad.ok && typeof bad.error === "string", bad.error);
const list1 = await req({ type: "machine.accounts" });
check("непройденный вход не оставил аккаунт вошедшим", list1.ok && (list1.result.accounts[acc]?.login ?? "none") !== "ok", list1.result?.accounts?.[acc] ?? "нет записи");
const rm = await req({ type: "machine.account_remove", account: acc });
check("machine.account_remove убирает папку пробного аккаунта", rm.ok || rm.error === "no_account", rm.ok ? rm.result : rm.error);

const slots = await req({ type: "machine.slots" });
check("machine.slots отвечает", slots.ok && typeof slots.result?.slots === "object", slots.result ?? slots.error);
const set = await req({ type: "slot.set", slot: "probe-slot", order: ["nobody"] });
check("slot.set с аккаунтом, которого нет, — отказ no_account", !set.ok && set.error === "no_account", set.error ?? set.result);
l.close(1000, "done");
console.log(fails.length ? `accounts: ${fails.length} провалов` : "accounts: ok");
process.exit(fails.length ? 1 : 0);
