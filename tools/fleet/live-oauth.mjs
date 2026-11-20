// Живая проверка «вход внешнего клиента»: node tools/fleet/live-oauth.mjs [флот] [устройство]
// Путь клиента MCP целиком: отказ /mcp называет сервер входа → человек на странице разрешает клиенту вход → клиент получает код
// на свой адрес возврата → меняет его на пропуск в /token → зовёт инструмент флота этим пропуском.
// Клиент — Claude Code: описание клиента флот читает по его публичному адресу https; адрес возврата — этот компьютер (loopback, порт любой).
import crypto from "node:crypto";
import http from "node:http";
import { check } from "./harness.mjs";

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

await check(async (t) => {
  // имя, которое человек даёт устройству клиента на экране согласия
  const LABEL = "client" + t.tag;
  const mcp = (body, token) => t.fetch(t.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });

  // адрес возврата клиента: сюда страница вернёт человека с кодом
  const back = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>клиент получил ответ</p>"));
  await new Promise((done) => back.listen(0, "127.0.0.1", done));
  t.defer("адрес возврата клиента", async () => void back.close());
  const redirect = `http://127.0.0.1:${back.address().port}/callback`;
  // устройство, которое человек разрешил клиенту, — своё: уходит в конце
  t.defer(`устройство клиента ${LABEL}`, async (go) => {
    const r = await go("passes", { kind: "device" });
    for (const p of r.result?.passes ?? []) if (p.addr.startsWith(LABEL + "-")) await go("revoke", { kid: p.kid });
  });

  let ends;
  await t.step("отказ /mcp ведёт к серверу входа: экран согласия и /token названы", async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const meta = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate") ?? "")?.[1];
    if (r.status !== 401 || !meta) throw new Error(`HTTP ${r.status}, заголовок: ${r.headers.get("www-authenticate")}`);
    const resource = await (await t.fetch(meta)).json();
    const server = resource.authorization_servers?.[0];
    if (!server) throw new Error("ресурс не назвал сервер входа");
    ends = await (await t.fetch(server + "/.well-known/oauth-authorization-server")).json();
    if (!ends.authorization_endpoint || !ends.token_endpoint || !ends.code_challenge_methods_supported?.includes("S256")) throw new Error("в метаданных нет адресов или S256");
    return new URL(ends.authorization_endpoint).pathname + " и " + new URL(ends.token_endpoint).pathname;
  });

  const verifier = b64(crypto.randomBytes(32));
  const state = "s" + t.tag;
  let code = "";
  await t.step("человек разрешает клиенту вход на странице: клиент получает код на свой адрес возврата", async () => {
    const page = await t.page({ width: 1280, height: 800 });
    const ask = new URL(ends.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT, redirect_uri: redirect, code_challenge: b64(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state })) ask.searchParams.set(k, v);
    await page.goto(ask.toString());
    await page.getByText("Разрешить клиенту вход во флот?").waitFor();
    const shown = await page.locator("dl.kv").innerText();
    if (!shown.includes("claude.ai") || !shown.includes(new URL(redirect).host)) throw new Error("экран согласия не назвал клиента и адрес возврата: " + shown.replace(/\s+/g, " "));
    await page.getByLabel("Имя устройства клиента").fill(LABEL);
    await page.getByRole("button", { name: "Разрешить" }).click();
    // страница вернула человека на адрес возврата клиента: код и state — в адресе
    await page.waitForURL((u) => u.origin + u.pathname === redirect);
    const q = new URL(page.url()).searchParams;
    if (q.get("error")) throw new Error("клиенту вернулся отказ: " + q.get("error"));
    if (q.get("state") !== state) throw new Error("state вернулся другим");
    code = q.get("code") ?? "";
    if (!code) throw new Error("кода в адресе возврата нет");
    return `код ${code.split(":").slice(0, 2).join(":")}, state на месте`;
  });

  let token = "";
  await t.step("код меняется на пропуск в /token; с чужим проверочным словом — отказ", async () => {
    const form = (v) => t.fetch(ends.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, client_id: CLIENT, redirect_uri: redirect }) });
    const wrong = await form(b64(crypto.randomBytes(32)));
    if (wrong.status !== 400 || (await wrong.json()).error !== "invalid_grant") throw new Error("чужое проверочное слово не отклонено: HTTP " + wrong.status);
    const r = await form(verifier);
    const j = await r.json();
    if (!r.ok || !j.access_token || j.token_type !== "Bearer") throw new Error(`HTTP ${r.status}: ${j.error_description ?? j.error}`);
    token = j.access_token;
    return "чужое слово — invalid_grant, своё — пропуск";
  });

  await t.step("пропуск клиента зовёт инструмент флота от имени человека", async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "passes", arguments: { kind: "device" } } }, token);
    const j = await r.json();
    if (!j.result || j.result.isError) throw new Error(JSON.stringify(j).slice(0, 200));
    // устройство клиента — среди пропусков человека под именем, которое человек дал на экране согласия
    if (!j.result.content[0].text.includes(LABEL + "-")) throw new Error("устройства клиента нет среди пропусков человека");
    return `устройство ${LABEL}-…${(await t.must("whoami", {})).person}`;
  });
});
