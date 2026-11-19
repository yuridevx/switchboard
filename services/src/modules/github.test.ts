import { describe, expect, it } from "vitest";
import { type Stand, stand } from "../../test/stand.ts";

/** Ключ приложения в PEM, как его отдаёт GitHub (здесь — PKCS#8). */
async function pem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** Подделка API GitHub. secret — секрет подписи событий, который GitHub называет при создании приложения, подписанного на события. */
async function github(s: Stand, secret?: string) {
  const key = await pem();
  s.state.net = (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/app-manifests/code123/conversions") return Response.json({ id: 42, slug: "switchboard-test", owner: { login: "yuri" }, pem: key, ...(secret ? { webhook_secret: secret } : {}) });
    if (path === "/app") return Response.json({ slug: "switchboard-test", owner: { login: "team", type: "Organization" } });
    if (path === "/app/installations") return Response.json([{ id: 5 }]);
    if (path === "/installation/repositories") return Response.json({ repositories: [{ full_name: "yuri/site" }, { full_name: "yuri/base" }] });
    if (path === "/repos/yuri/site/installation") return Response.json({ id: 5 });
    if (path === "/app/installations/5/access_tokens" && init?.method === "POST") return Response.json({ token: "ghs_token", expires_at: "2026-11-10T03:00:00Z" });
    return new Response("{}", { status: 404 });
  };
}

describe("GitHub", () => {
  it("приложения нет: форма создания для браузера; токен — отказ no_app", async () => {
    const s = stand();
    const r = (await s.ask("github.setup", { redirect: "https://fleet.test/settings" })).result as { installed: boolean; form: { action: string; manifest: Record<string, unknown> } };
    expect(r.installed).toBe(false);
    expect(r.form.action).toBe("https://github.com/settings/apps/new");
    // приложение подписывается на события о PR и ревью: GitHub шлёт их на адрес флота
    expect(r.form.manifest).toMatchObject({
      redirect_url: "https://fleet.test/settings", public: false, default_permissions: { contents: "write", pull_requests: "read" },
      hook_attributes: { url: `https://fleet.test/github/${s.fleet}`, active: true }, default_events: ["pull_request", "pull_request_review"],
    });
    expect((await s.ask("github.app")).result).toEqual({ installed: false });
    expect(await s.ask("github.token", { repo: "yuri/site" }, "klaptop")).toMatchObject({ ok: false, error: "no_app" });
    expect(await s.ask("github.setup", {}, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("код из возврата GitHub заводит приложение; токен — машине, на один репозиторий и только на содержимое", async () => {
    const s = stand();
    await github(s);
    expect((await s.ask("github.setup", { code: "code123" })).result).toMatchObject({ installed: true, url: "https://github.com/apps/switchboard-test/installations/new" });
    expect((await s.ask("github.app", {}, "kanya1")).result).toEqual({ installed: true, name: "switchboard-test", url: "https://github.com/apps/switchboard-test/installations/new", repos: ["yuri/base", "yuri/site"], events: false });
    s.seen.net.length = 0;
    expect((await s.ask("github.token", { repo: "yuri/site" }, "klaptop")).result).toEqual({ token: "ghs_token", expires: Date.parse("2026-11-10T03:00:00Z") });
    const issue = s.seen.net.find((n) => n.url.endsWith("/access_tokens"))!;
    expect(JSON.parse(String(issue.init!.body))).toEqual({ repositories: ["site"], permissions: { contents: "write" } });
    expect((issue.init!.headers as Record<string, string>).authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(await s.ask("github.token", { repo: "yuri/other" }, "klaptop")).toMatchObject({ ok: false, error: "not_installed" });
    expect(await s.ask("github.token", { repo: "yuri/site" }, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("github.token", { repo: "не репозиторий" }, "klaptop")).toMatchObject({ ok: false, error: "bad_input" });
    // замена приложения на подписанное на события. Без replace формы нет; с ним новое заводится там же, где прежнее, — у организации-владельца
    expect((await s.ask("github.setup", { redirect: "https://fleet.test/settings" })).result).toEqual({ installed: true, url: "https://github.com/apps/switchboard-test/installations/new" });
    const again = (await s.ask("github.setup", { redirect: "https://fleet.test/settings", replace: true })).result as { form: { action: string; manifest: { name: string } } };
    expect(again.form).toMatchObject({ action: "https://github.com/organizations/team/settings/apps/new", manifest: { name: "Switchboard team" } });
    // страница после возврата с GitHub шлёт один код: GitHub называет секрет подписи — приложение принимает события
    await github(s, "whsec_new");
    expect((await s.ask("github.setup", { code: "code123" })).ok).toBe(true);
    expect((await s.ask("github.app")).result).toMatchObject({ installed: true, events: true });
  });
});

// устав: «прямой запрос … не прошёл — отказ словом»
describe("GitHub: недоступен", () => {
  it("GitHub не ответил или ответил ошибкой при выдаче токена — github_failed с причиной, токена нет", async () => {
    const s = stand();
    await github(s);
    await s.ask("github.setup", { code: "code123" });
    const up = s.state.net;
    // сеть оборвалась
    s.state.net = () => { throw new Error("connect ECONNRESET"); };
    const down = await s.ask("github.token", { repo: "yuri/site" }, "klaptop");
    expect(down).toMatchObject({ ok: false, error: "github_failed" });
    expect(down.result).toBeUndefined();
    expect(String(down.why)).toContain("ECONNRESET");
    // GitHub ответил ошибкой на выдачу токена
    s.state.net = (url, init) => (url.endsWith("/access_tokens") ? new Response("{\"message\":\"boom\"}", { status: 500 }) : up(url, init));
    const failed = await s.ask("github.token", { repo: "yuri/site" }, "klaptop");
    expect(failed).toMatchObject({ ok: false, error: "github_failed" });
    expect(failed.result).toBeUndefined();
  });
});

describe("адрес API GitHub", () => {
  // чьё: код — без настройки запросы идут на api.github.com; настройка — дизайн «Проверка всех систем»
  it("адрес API — настройка: не задана — api.github.com; задана — запросы идут на неё", async () => {
    const own = stand();
    await github(own);
    await own.ask("github.setup", { code: "code123" });
    expect(new URL(own.seen.net.at(-1)!.url).origin).toBe("https://api.github.com");
    const other = stand(undefined, { env: { GITHUB_API: "http://127.0.0.1:4200/" } });
    await github(other);
    await other.ask("github.setup", { code: "code123" });
    expect(other.seen.net.at(-1)!.url).toBe("http://127.0.0.1:4200/app-manifests/code123/conversions");
  });
});
