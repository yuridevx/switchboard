// Живой путь приложения GitHub — до шага, где нужен человек (подтвердить форму на github.com под своим входом):
// форма manifest, отказ на неверный code от настоящего API GitHub, токен без приложения. env: FLOW_CLIENT_KEY, FLOW_MACHINE.
import { link } from "@switchboard/relay";

const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
for (let i = 0; l.state !== "open" && i < 150; i++) await new Promise((r) => setTimeout(r, 100));
const req = (f: Record<string, unknown>) => l.request({ v: 1, to: "github", ...f } as never) as Promise<{ ok: boolean; result?: any; error?: string }>;

const app = await req({ type: "github.app", redirect: "https://switchboard-pult.yuridevx1608.workers.dev/" });
const form = app.result?.form;
check("github.app без приложения — форма manifest для github.com", app.ok && app.result?.app === null && /^https:\/\/github\.com\/settings\/apps\/new/.test(form?.action ?? ""), form?.action);
const m = form?.manifest ?? {};
check("manifest: имя, redirect на пульт, право contents", typeof m.name === "string" && m.redirect_url === "https://switchboard-pult.yuridevx1608.workers.dev/" && JSON.stringify(m.default_permissions ?? {}).includes("contents"), { name: m.name, redirect_url: m.redirect_url, default_permissions: m.default_permissions });
if (form?.action) {
  const r = await fetch(form.action, { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(m) }), redirect: "manual" });
  check("github.com принимает форму (без входа — переадресация на вход)", r.status === 302 || r.status === 200, { status: r.status, location: r.headers.get("location")?.slice(0, 60) });
}
const bad = await req({ type: "github.setup", code: "0000000000000000000000000000000000000000" });
check("github.setup с неверным code — отказ github_failed от API GitHub", !bad.ok && bad.error === "github_failed", bad.error ?? bad.result);
const tok = await req({ type: "github.token", repo: "yuridevx/switchboard" });
check("github.token без приложения — no_app", !tok.ok && tok.error === "no_app", tok.error ?? tok.result);
l.close(1000, "done");
console.log(fails.length ? `github: ${fails.length} провалов` : "github: ok");
process.exit(fails.length ? 1 : 0);
