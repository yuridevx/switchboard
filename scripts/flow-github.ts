// Живой путь приложения GitHub — до шага, где нужен человек (подтвердить форму на github.com под своим входом).
// Приложения нет: форма manifest, отказ на неверный code от настоящего API GitHub, токен — no_app.
// Приложение есть: сведения и репозитории установок, setup без replace — app_exists, с replace и неверным code —
// github_failed (прежнее приложение цело), токен репозитория установки, чужой репозиторий — not_installed.
// Токенов в выводе нет. env: FLOW_CLIENT_KEY; FLOW_REPO — репозиторий установки (по умолчанию yuridevx/switchboard-profiles).
import { link } from "@switchboard/relay";

const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
for (let i = 0; l.state !== "open" && i < 150; i++) await new Promise((r) => setTimeout(r, 100));
const req = (f: Record<string, unknown>) => l.request({ v: 1, to: ".github", ...f } as never) as Promise<{ ok: boolean; result?: any; error?: string }>;
const PULT = "https://switchboard-pult.yuridevx1608.workers.dev/";
const BAD_CODE = "0000000000000000000000000000000000000000";

const app = await req({ type: "github.app", redirect: PULT });
check("github.app отвечает", app.ok, app.error);
if (app.result?.app === null) {
  const form = app.result?.form;
  check("github.app без приложения — форма manifest для github.com", /^https:\/\/github\.com\/settings\/apps\/new/.test(form?.action ?? ""), form?.action);
  const m = form?.manifest ?? {};
  check("manifest: имя, redirect на пульт, право contents", typeof m.name === "string" && m.redirect_url === PULT && JSON.stringify(m.default_permissions ?? {}).includes("contents"), { name: m.name, redirect_url: m.redirect_url, default_permissions: m.default_permissions });
  if (form?.action) {
    const r = await fetch(form.action, { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(m) }), redirect: "manual" });
    check("github.com принимает форму (без входа — переадресация на вход)", r.status === 302 || r.status === 200, { status: r.status, location: r.headers.get("location")?.slice(0, 60) });
  }
  const bad = await req({ type: "github.setup", code: BAD_CODE });
  check("github.setup с неверным code — отказ github_failed от API GitHub", !bad.ok && bad.error === "github_failed", bad.error ?? bad.result);
  const tok = await req({ type: "github.token", repo: "yuridevx/switchboard" });
  check("github.token без приложения — no_app", !tok.ok && tok.error === "no_app", tok.error ?? tok.result);
} else {
  const a = app.result?.app ?? {};
  check("github.app с приложением — id, slug, владелец, репозитории установок, ссылка установки", typeof a.id === "number" && !!a.slug && Array.isArray(app.result?.repos) && /^https:\/\/github\.com\//.test(app.result?.install ?? ""), { app: a, repos: app.result?.repos?.length, install: app.result?.install });
  const exists = await req({ type: "github.setup", code: BAD_CODE });
  check("github.setup без replace — app_exists, приложение не трогается", !exists.ok && exists.error === "app_exists", exists.error ?? "ok");
  const bad = await req({ type: "github.setup", code: BAD_CODE, replace: true });
  check("github.setup replace с неверным code — github_failed от API GitHub", !bad.ok && bad.error === "github_failed", bad.error ?? "ok");
  const after = await req({ type: "github.app", redirect: PULT });
  check("после отказа приложение прежнее", after.result?.app?.id === a.id, after.result?.app);
  const repo = process.env.FLOW_REPO ?? "yuridevx/switchboard-profiles";
  const tok = await req({ type: "github.token", repo });
  check(`github.token ${repo} — токен установки`, tok.ok && typeof tok.result?.token === "string" && tok.result.token.startsWith("ghs_"), tok.ok ? { token: "ghs_…" } : tok.error);
  const none = await req({ type: "github.token", repo: "yuridevx/switchboard-no-such-repo-0" });
  check("github.token чужого репозитория — not_installed", !none.ok && none.error === "not_installed", none.error ?? "токен");
}
l.close(1000, "done");
console.log(fails.length ? `github: ${fails.length} провалов` : "github: ok");
process.exit(fails.length ? 1 : 0);
