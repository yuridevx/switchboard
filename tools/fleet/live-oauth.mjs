// Живая проверка «вход внешнего клиента»: node tools/fleet/live-oauth.mjs [флот] [устройство]
// Путь клиента MCP целиком: отказ /mcp называет сервер входа → человек на странице разрешает клиенту вход → клиент получает код
// на свой адрес возврата → меняет его на пропуск в /token → зовёт инструмент флота этим пропуском.
// Клиент — Claude Code: описание клиента флот читает по его публичному адресу https; адрес возврата — этот компьютер (loopback, порт любой).
import crypto from "node:crypto";
import http from "node:http";
import { fleetEnv } from "../dev.mjs";
import { fleetCall, launchBrowser, newTag } from "./harness.mjs";

const [fleet = "test", device = "cli"] = process.argv.slice(2);
const { call, must } = fleetCall(fleet, device);
const base = fleetEnv.SB2_BASE;
const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const tag = newTag();
const LABEL = "oauth" + tag;
let bad = 0, total = 0;
async function step(label, fn) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const mcp = (body, token) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });

// адрес возврата клиента: сюда страница вернёт человека с кодом
let landed;
const got = new Promise((done) => (landed = done));
const back = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>клиент получил ответ</p>");
  if (u.pathname === "/callback") landed(u.searchParams);
});
await new Promise((done) => back.listen(0, "127.0.0.1", done));
const redirect = `http://127.0.0.1:${back.address().port}/callback`;

let ends;
await step("отказ /mcp ведёт к серверу входа: экран согласия и /token названы", async () => {
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const meta = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate") ?? "")?.[1];
  if (r.status !== 401 || !meta) throw new Error(`HTTP ${r.status}, заголовок: ${r.headers.get("www-authenticate")}`);
  const resource = await (await fetch(meta)).json();
  const server = resource.authorization_servers?.[0];
  if (!server) throw new Error("ресурс не назвал сервер входа");
  ends = await (await fetch(server + "/.well-known/oauth-authorization-server")).json();
  if (!ends.authorization_endpoint || !ends.token_endpoint || !ends.code_challenge_methods_supported?.includes("S256")) throw new Error("в метаданных нет адресов или S256");
  return new URL(ends.authorization_endpoint).pathname + " и " + new URL(ends.token_endpoint).pathname;
});

const me = must("whoami", {});
const invite = must("invite", { addr: "consent" + tag + me.person });
const verifier = b64(crypto.randomBytes(32));
const state = "s" + tag;
const browser = await launchBrowser();
let code = "";
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await step("человек разрешает клиенту вход на странице: клиент получает код на свой адрес возврата", async () => {
    if (!ends) throw new Error("адреса входа неизвестны");
    await page.goto(base + "/#invite=" + encodeURIComponent(invite.invite));
    await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 20_000 });
    const ask = new URL(ends.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT, redirect_uri: redirect, code_challenge: b64(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state })) ask.searchParams.set(k, v);
    await page.goto(ask.toString());
    await page.getByText("Разрешить клиенту вход во флот?").waitFor({ timeout: 20_000 });
    const shown = await page.locator("dl.kv").innerText();
    if (!shown.includes("claude.ai") || !shown.includes(new URL(redirect).host)) throw new Error("экран согласия не назвал клиента и адрес возврата: " + shown.replace(/\s+/g, " "));
    await page.getByLabel("Имя устройства клиента").fill(LABEL);
    await page.getByRole("button", { name: "Разрешить" }).click();
    const q = await Promise.race([got, new Promise((_, no) => setTimeout(() => no(new Error("клиент не дождался возврата: " + page.url().split("?")[0])), 30_000))]);
    if (q.get("error")) throw new Error("клиенту вернулся отказ: " + q.get("error"));
    if (q.get("state") !== state) throw new Error("state вернулся другим");
    code = q.get("code") ?? "";
    if (!code) throw new Error("кода в адресе возврата нет");
    return `код ${code.split(":").slice(0, 2).join(":")}, state на месте`;
  });
} finally {
  await browser.close();
}

let token = "";
await step("код меняется на пропуск в /token; с чужим проверочным словом — отказ", async () => {
  if (!code) throw new Error("кода нет");
  const form = (v) => fetch(ends.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, client_id: CLIENT, redirect_uri: redirect }) });
  const wrong = await form(b64(crypto.randomBytes(32)));
  if (wrong.status !== 400 || (await wrong.json()).error !== "invalid_grant") throw new Error("чужое проверочное слово не отклонено: HTTP " + wrong.status);
  const r = await form(verifier);
  const j = await r.json();
  if (!r.ok || !j.access_token || j.token_type !== "Bearer") throw new Error(`HTTP ${r.status}: ${j.error_description ?? j.error}`);
  token = j.access_token;
  return "чужое слово — invalid_grant, своё — пропуск";
});

await step("пропуск клиента зовёт инструмент флота от имени человека", async () => {
  if (!token) throw new Error("пропуска нет");
  const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "passes", arguments: { kind: "device" } } }, token);
  const j = await r.json();
  if (!j.result || j.result.isError) throw new Error(JSON.stringify(j).slice(0, 200));
  // устройство клиента — среди пропусков человека под именем, которое человек дал на экране согласия
  if (!j.result.content[0].text.includes(LABEL + "-")) throw new Error("устройства клиента нет среди пропусков человека");
  return `устройство ${LABEL}-…${me.person}`;
});

back.close();
for (const p of must("passes", { kind: "device" }).passes) if (p.addr.startsWith(LABEL + "-")) call("revoke", { kid: p.kid });
call("revoke", { kid: invite.kid });
console.log(bad ? `сбоев: ${bad} из ${total}` : `вход клиента: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
