// Живой прогон «Идентификации» и сервера MCP на одной машине тестового флота: пропуска по адресу (эталоны 1, 42, 43),
// пропуск сессии и сервер switchboard в сессии (24, 26, 45), вход снаружи по OAuth — Claude Code настоящий (23, 44) и шаги claude.ai.
// env: FLOW_CLIENT_KEY (пропуск человека), FLOW_MACHINE, FLOW_SLOT (слот с моделью), FLOW_DIR (~/sb-flow).
// Claude Code входит в своей временной папке CLAUDE_CONFIG_DIR: общий ~/.claude.json не трогается.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { client, WORKERS } from "./client.ts";
import { pageOf } from "./fleets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.FLOW_CLIENT_KEY!;
const M = process.env.FLOW_MACHINE!;
const SLOT = process.env.FLOW_SLOT ?? "main";
const DIR = process.env.FLOW_DIR ?? "~/sb-flow";
const PERSON = "flow-id@example.com";
const CS = `idlive@${M}`;
const PULT = pageOf("test", "pult");
const MCP = `${WORKERS.mcp.replace(/\/$/, "")}/mcp`;
const CLAUDE_AI = { client: "https://claude.ai/oauth/mcp-oauth-client-metadata", back: "https://claude.ai/api/mcp/auth_callback" };

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
/** POST в Worker пропуском key, как страница. Ответ целиком: ok или отказ словом. */
const post = async (worker: string, f: Record<string, unknown>, key = KEY) =>
  (await (await fetch(WORKERS[worker], { method: "POST", body: JSON.stringify({ id: "f", key, ...f }), signal: AbortSignal.timeout(60_000) })).json()) as any;
const passes = async (f: Record<string, unknown> = {}) => (await post("gate", { type: "keys.list", v: 2, ...f })).result.passes as Array<{ kid: string; addr: string; wait: boolean }>;
/** Приглашение и приём: пропуск адреса addr. */
const passFor = async (addr: string) => {
  const inv = await post("gate", { type: "keys.invite", v: 2, addr });
  if (!inv.ok) throw new Error(`keys.invite ${addr}: ${inv.error}`);
  const got = await post("gate", { type: "gate.redeem", v: 1, invite: inv.result.invite });
  return { kid: inv.result.kid as string, key: got.result.key as string };
};
/** Один запрос MCP по HTTP с пропуском: ответ JSON-RPC и код. */
const mcp = async (key: string, method: string, params: Record<string, unknown> = {}) => {
  const r = await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as any) : null };
};
const state = (cs: string) => l.roster?.sessions.find((s) => s.callsign === cs)?.state;
const history = async (cs: string) => (await req({ type: "session.history", callsign: cs, before: null, limit: 400 })).messages as any[];
const textOf = (m: any) => {
  const c = m?.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join(" ") : "";
};
async function ask(cs: string, text: string, ms = 300_000): Promise<string> {
  const before = (await history(cs)).length;
  await req({ type: "session.prompt", callsign: cs, text });
  return wait(`ответ ${cs}`, async () => {
    if (state(cs) !== "idle") return undefined;
    const said = (await history(cs)).slice(before).filter((m) => m.type === "assistant").map(textOf).join(" ").trim();
    return said || undefined;
  }, ms);
}
/** Вызовы инструментов сессии после n-го сообщения. */
const toolUses = async (cs: string) => (await history(cs)).flatMap((m) => (Array.isArray(m?.message?.content) ? m.message.content : [])).filter((b: any) => b.type === "tool_use").map((b: any) => b.name as string);

/** Согласие в настоящем пульте: страница с адресом authorize и приглашением устройства; «Разрешить» → адрес возврата клиента с кодом. */
let pults = 0;
async function consent(authorize: string, back: (url: string) => boolean): Promise<string> {
  const { chromium } = createRequire(join(ROOT, "package.json"))("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let landed = "";
    await page.route((u: URL) => back(u.href), (route: any) => {
      landed = route.request().url();
      return route.fulfill({ status: 200, body: "ok" });
    });
    // своё устройство на каждое согласие: пульт человека — тот же, что у него в браузере, только адрес новый
    const device = await post("gate", { type: "keys.invite", v: 2, addr: `pult${++pults}~${PERSON}` });
    if (!device.ok) throw new Error(`keys.invite пульта: ${device.error}`);
    await page.goto(`${authorize}#invite=${device.result.invite}`);
    await page.getByRole("button", { name: "Разрешить" }).click({ timeout: 60_000 });
    await wait("возврат в клиент", () => landed || undefined, 60_000);
    return landed;
  } finally {
    await browser.close();
  }
}

/**
 * Claude Code настоящий: add и login --no-browser в своей папке. login без терминала выходит с кодом 1 — он идёт в псевдотерминале,
 * как у человека: адрес входа — в согласие, адрес возврата вставляется в его приглашение.
 */
async function claudeCode(): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), "sb-cc-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home } as Record<string, string>;
  let login: { kill(): void } | undefined;
  try {
    const add = spawnSync("claude", ["mcp", "add", "--transport", "http", "-s", "user", "switchboard", MCP], { env, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
    if (add.status !== 0) throw new Error(`claude mcp add: ${add.stderr || add.stdout}`);
    const pty = createRequire(join(ROOT, "package.json"))("@lydell/node-pty");
    const term = pty.spawn(process.platform === "win32" ? "claude.exe" : "claude", ["mcp", "login", "switchboard", "--no-browser"], { env, cols: 4000, rows: 50 });
    login = term;
    let out = "";
    let exited: number | null | undefined;
    term.onData((d: string) => (out += d));
    term.onExit(({ exitCode }: { exitCode: number }) => (exited = exitCode));
    // адрес — до управляющих последовательностей терминала (ссылка OSC 8 повторяет его)
    const url = await wait("адрес входа Claude Code", () => /https:\/\/[^\s\x1b\x07\\]*open=consent[^\s\x1b\x07\\]*/.exec(out)?.[0], 60_000);
    const landed = await consent(url, (u) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/callback/.test(u));
    term.write(`${landed}\r`);
    const code = await wait("выход claude mcp login", () => (exited === undefined ? undefined : { exited }), 60_000)
      .then((x) => x.exited)
      .catch(() => null);
    const got = spawnSync("claude", ["mcp", "get", "switchboard"], { env, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
    check("23 · Claude Code вошёл по OAuth: login и сервер на связи", code === 0 && /connected/i.test(got.stdout), `выход ${code} · ${got.stdout.split("\n").find((x) => /status/i.test(x)) ?? out.slice(-200)}`);
    return code === 0;
  } finally {
    // псевдотерминал Windows держит процесс сценария и после выхода claude
    try { login?.kill(); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
}

/** Шаги claude.ai: его описание клиента и адрес возврата, код из перехода браузера, /token с PKCE. */
async function claudeAi(): Promise<string> {
  const meta = (await (await fetch(`${WORKERS.gate.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)).json()) as { authorization_endpoint: string; token_endpoint: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: CLAUDE_AI.client, redirect_uri: CLAUDE_AI.back, state: "st1", code_challenge: challenge, code_challenge_method: "S256", resource: MCP })) url.searchParams.set(k, v);
  const landed = new URL(await consent(url.href, (u) => u.startsWith(CLAUDE_AI.back)));
  const token = (await (await fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: landed.searchParams.get("code") ?? "", code_verifier: verifier, client_id: CLAUDE_AI.client, redirect_uri: CLAUDE_AI.back }) })).json()) as { access_token?: string };
  check("23 · шаги claude.ai: код с state, /token → пропуск устройства", !!token.access_token && landed.searchParams.get("state") === "st1");
  return token.access_token ?? "";
}

try {
  await wait("roster машины", () => l.roster?.machines.some((m) => m.machine === M), 30_000);
  // 43: пропуска прежней выдачи живы — Host машины на связи, пропуск этого сценария принят
  check("43 · прежние пропуска: машина на связи, пропуск человека принят", !!l.roster?.machines.some((m) => m.machine === M) && (await post("gate", { type: "keys.list", v: 2 })).ok);

  // 1: устройство от имени человека
  const dev = await passFor(`flowdev~${PERSON}`);
  const mine = await post("gate", { type: "keys.list", v: 2, ids: [dev.kid] }, dev.key);
  check("1 · устройство от имени человека: пропуск подпись.номер.секрет, адрес в keys.list", /^flowdev\.[a-z0-9]{4}\./.test(dev.key) && mine.result?.you === `flowdev~${PERSON}`);

  // 42: прав нет — новый пропуск пишет настройку флота
  const set = await post("prefs", { type: "prefs.set", v: 1, to: ".prefs", scope: "global", name: "flow.identity", value: "ЗЕБРА" }, dev.key);
  check("42 · права — мок: новое устройство пишет prefs области флота", set.ok === true, set.error ?? "");
  await post("relay", { type: "keys.revoke", v: 1, kid: dev.kid });
  check("42 · отозванный пропуск — bad_key", (await post("gate", { type: "keys.list", v: 2 }, dev.key)).error === "bad_key");

  // 24: пропуск сессии и сервер switchboard
  await l.request({ type: "session.remove", v: 1, callsign: CS } as never).catch(() => {});
  const r = await req({ type: "session.open", machine: M, name: "idlive", dir: DIR, slot: SLOT }, 2);
  await wait(`${r.callsign} idle`, () => state(r.callsign) === "idle", 120_000);
  const sessionPass = (await passes({ kind: "session" })).find((p) => p.addr === CS);
  check("24 · пропуск сессии: keys.invite с адресом сессии и приём", !!sessionPass && !sessionPass.wait);

  // 26 · 45: инструменты сервера switchboard из сессии
  const said = await ask(CS, "Вызови инструмент mcp__switchboard__prefs_set с аргументами {\"scope\":\"global\",\"name\":\"flow.identity\",\"value\":\"ЖИРАФ\"}, затем mcp__switchboard__fleetkeys_list. Ответь одним словом: имена ключей через запятую.");
  const used = await toolUses(CS);
  const pref = await post("prefs", { type: "prefs.get", v: 1, to: ".prefs", scope: "global", prefix: "flow.identity" });
  check("26 · 45 · сессия зовёт инструменты сервера switchboard: prefs_set исполнен, fleetkeys_list ответил", used.includes("mcp__switchboard__prefs_set") && used.includes("mcp__switchboard__fleetkeys_list") && pref.result?.values?.["flow.identity"] === "ЖИРАФ", `${used.filter((u) => u.startsWith("mcp__switchboard")).join(", ")} · ${said.slice(0, 80)}`);

  await req({ type: "session.remove", callsign: CS });
  await wait("пропуск сессии отозван", async () => !(await passes({ kind: "session" })).some((p) => p.addr === CS), 60_000);
  check("24 · session.remove — пропуск сессии отозван", true);

  // 23 · 44: вход снаружи — Claude Code и шаги claude.ai у одного человека
  await claudeCode();
  const aiKey = await claudeAi();
  const list = await mcp(aiKey, "tools/list");
  const names = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
  check("31 · tools/list — инструменты из манифестов", ["points_list", "points_history", "prefs_get", "prefs_set", "fleetkeys_list", "fleetkeys_set", "keys_invite", "keys_list", "keys_revoke"].every((n) => names.includes(n)), names.join(", "));
  const call = await mcp(aiKey, "tools/call", { name: "points_list", arguments: {} });
  check("23 · points_list отвечает пропуску внешнего Claude", call.status === 200 && !call.body?.result?.isError, JSON.stringify(call.body?.result ?? call.status).slice(0, 120));
  const devices = (await passes({ kind: "device" })).map((p) => p.addr);
  check("44 · claude.ai и Claude Code одного человека — два устройства, оба живы", devices.includes(`claude~${PERSON}`) && devices.includes(`code~${PERSON}`), devices.filter((a) => a.endsWith(PERSON)).join(", "));
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  await l.request({ type: "session.remove", v: 1, callsign: CS } as never).catch(() => {});
  for (const p of await passes().catch(() => [])) if (p.addr.endsWith(`~${PERSON}`)) await post("relay", { type: "keys.revoke", v: 1, kid: p.kid }).catch(() => {});
  await post("prefs", { type: "prefs.set", v: 1, to: ".prefs", scope: "global", name: "flow.identity", value: null }).catch(() => {});
  l.close(1000, "done");
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`identity: ${results.length - bad} ok, ${bad} FAIL`);
  process.exit(bad ? 1 : 0);
}
