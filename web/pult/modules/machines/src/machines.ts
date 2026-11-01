// pult-machines — машины флота из roster: части машины по ответу её keeper (keeper.state), профили, приложение GitHub.
// Каждая цифра — ответ keeper, машины или roster. Машина следует плану «выпусков»: своей кнопки обновления нет.
import { add, h, hhmm, plural, type App, type AppModule, type Roster, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

type Part = { part: string; version?: string; state?: string; pid?: number; restarts?: number; error?: string };
type State = { keeper?: string; rev?: number; os?: string; parts?: Part[] };
type Repo = { state: "ok" | "error" | "conflict"; op?: string; files?: string[]; error?: string; since?: number };
type Profiles = { profiles: Record<string, unknown>; repos: Record<string, Repo> };
type Gh = { app: { slug: string; id?: number; owner?: string } | null; repos?: string[]; install?: string; form?: { action: string; manifest: Record<string, unknown> } };

const CSS = `
.mc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.mc-hd{display:flex;align-items:center;gap:8px}
.mc-hd b{font:600 16px var(--mono);flex:1}
.mc-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:4px 10px;font-size:13px}
.mc-kv span:nth-child(odd){color:var(--muted)}
.mc-kv span:nth-child(even){font-family:var(--mono);font-size:12.5px}
.mc-kv span.bad{color:var(--bad)}
`;

/** Слова отказа → строка на экране. */
function say(w: string): string {
  const t: Record<string, string> = {
    not_installed: "Приложение GitHub не допущено к репозиторию",
    app_exists: "Приложение GitHub флота уже есть",
  };
  return t[w] ?? w;
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createMachines(): AppModule {
  let app: App;
  const states = new Map<string, State | { error: string }>();
  const profs = new Map<string, Profiles>();
  const notes = new Map<string, { text: string; tone: string }>();
  /** since машины в последнем roster: вернулась — keeper спрашиваем заново */
  const seen = new Map<string, number>();
  let gh: Gh | { error: string } | null = null;
  let ghCode = "";
  const screens = new Set<() => void>();
  const redraw = () => screens.forEach((d) => d());

  const can = (m: string, n: string) => app.provides(m)?.[n] !== undefined;
  const note = (k: string, text: string, tone = "") => {
    notes.set(k, { text, tone });
    redraw();
  };

  async function load(m: string) {
    const jobs: Array<Promise<void>> = [];
    // keeper машины отвечает сам, даже когда Host мёртв
    jobs.push(app.request<State>("keeper.state", { to: `.keeper@${m}` }).then((r) => void states.set(m, r.ok ? r.result : { error: r.error })));
    if (can(m, "machine.profiles"))
      jobs.push(
        app.request<Profiles>("machine.profiles", { machine: m }).then((r) => {
          if (r.ok) profs.set(m, r.result);
          // отказ — словом в карточке машины
          note(`profiles:${m}`, r.ok ? "" : `machine.profiles: ${r.error}`, "bad");
        }),
      );
    await Promise.all(jobs);
    redraw();
  }

  async function github() {
    if (!app.roster()?.workers.some((w) => w.name === "github")) return;
    const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname });
    gh = r.ok ? r.result : { error: r.error };
    redraw();
  }

  function onRoster(r: Roster) {
    for (const m of r.machines) {
      // вернулась (since другой) или впервые появилась при открытом экране — спросить её keeper и профили
      if (seen.has(m.machine) ? seen.get(m.machine) !== m.since : screens.size > 0) void load(m.machine);
      seen.set(m.machine, m.since);
    }
    redraw();
  }

  async function sync(m: string) {
    note(`sync:${m}`, "Синхронизирую…");
    const r = await app.request<Profiles>("machine.profiles", { machine: m, sync: true });
    if (!r.ok) return note(`sync:${m}`, `machine.profiles: ${r.error}`, "bad");
    profs.set(m, r.result);
    note(`sync:${m}`, "профили сведены с репозиториями", "ok");
  }

  async function setup() {
    note("gh", "Сохраняю приложение…");
    const r = await app.request<{ app: { slug: string }; install: string }>("github.setup", { code: ghCode });
    if (!r.ok) return note("gh", say(r.error), "bad");
    ghCode = "";
    history.replaceState(null, "", location.pathname + location.hash);
    gh = { app: r.result.app, install: r.result.install, repos: [] };
    note("gh", "Приложение сохранено — установите его на репозитории профилей.", "ok");
  }

  async function create(org: string) {
    let form = gh && "form" in gh ? gh.form : undefined;
    if (org) {
      const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname, org });
      if (!r.ok) return note("gh", say(r.error), "bad");
      form = r.result.form;
    }
    if (!form) return;
    // форма manifest уходит в браузере на github.com; GitHub вернёт страницу с ?code=
    const f = h("form", { method: "post", action: form.action, hidden: true }, h("input", { type: "hidden", name: "manifest", value: JSON.stringify(form.manifest) })) as HTMLFormElement;
    document.body.append(f);
    f.submit();
  }

  function mount(el: HTMLElement): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let org = "";

    function card(m: string): HTMLElement {
      const rm = app.roster()?.machines.find((x) => x.machine === m);
      const st = states.get(m);
      const pr = profs.get(m);
      const n = (app.roster()?.sessions ?? []).filter((s) => machineOf(s.callsign) === m).length;
      const ok = st && !("error" in st) ? st : null;
      return h(
        "section",
        { class: "sb-sec", "data-machine": m },
        h("div", { class: "mc-hd" }, h("b", null, m), rm ? h("span", { class: "sb-pill ok conn" }, "на связи") : h("span", { class: "sb-pill bad" }, "нет в roster"), h("span", { class: "sb-note" }, rm ? `с ${hhmm(rm.since)}` : "")),
        ok
          ? h(
              "div",
              { class: "mc-kv" },
              h("span", null, "система"),
              h("span", null, ok.os ?? "?"),
              h("span", null, "keeper"),
              h("span", { "data-keeper": ok.keeper ?? "" }, `${ok.keeper ?? "?"} · план rev ${ok.rev ?? 0}`),
              h("span", null, "сессии"),
              h("span", null, String(n)),
              ...(ok.parts ?? []).flatMap((p) => [
                h("span", null, p.part),
                h(
                  "span",
                  { "data-part": p.part, "data-state": p.state ?? "", class: p.state === "failed" ? "bad" : "" },
                  [p.version, p.state, p.pid ? `pid ${p.pid}` : "", p.error ?? ""].filter(Boolean).join(" · "),
                ),
              ]),
            )
          : st && "error" in st
            ? h("div", { class: "sb-note bad" }, `keeper.state: ${st.error}`)
            : rm
              ? h("div", { class: "sb-note" }, "…")
              : null,
        pr
          ? h(
              "div",
              { class: "mc-kv" },
              h("span", null, "профили"),
              h("span", null, Object.entries(pr.repos).map(([repo, s]) => `${repo}${s.state === "ok" ? "" : " · " + s.state}`).join(", ") || "—"),
            )
          : null,
        ...Object.entries(pr?.repos ?? {})
          .filter(([, s]) => s.state !== "ok")
          .map(([repo, s]) =>
            h(
              "div",
              { class: "sb-sec bad" },
              h("b", null, s.state === "conflict" ? `${repo}: память не сведена` : `${repo}: ${s.error ?? s.state}`),
              h("span", { class: "sb-note" }, s.state === "conflict" ? `${s.op ?? "git pull"}: CONFLICT в ${(s.files ?? []).join(", ")}. Сессии профиля получат задание свести.` : (s.error ?? "")),
            ),
          ),
        notes.get(`profiles:${m}`)?.text ? h("div", { class: "sb-note bad", role: "alert" }, notes.get(`profiles:${m}`)!.text) : null,
        notes.get(`sync:${m}`)?.text ? h("div", { class: `sb-note ${notes.get(`sync:${m}`)!.tone}` }, notes.get(`sync:${m}`)!.text) : null,
        rm
          ? h(
              "div",
              { class: "sb-opts" },
              can(m, "machine.login") ? h("button", { class: "sb-b", onclick: () => app.open("accounts", { machine: m }) }, "+ Аккаунт") : null,
              can(m, "machine.profiles") ? h("button", { class: "sb-b", onclick: () => void sync(m) }, "Синхронизировать профили") : null,
            )
          : null,
      );
    }

    function ghSection(): HTMLElement | null {
      if (!app.roster()?.workers.some((w) => w.name === "github")) return null;
      const n = notes.get("gh");
      const orgIn = h("input", { class: "sb-in m", "data-f": "org", placeholder: "организация (необязательно)", value: org }) as HTMLInputElement;
      orgIn.addEventListener("input", () => (org = orgIn.value));
      let body: Array<HTMLElement | null>;
      if (ghCode) body = [h("span", null, "GitHub вернул код нового приложения."), h("div", { class: "sb-opts" }, h("button", { class: "sb-b pri", onclick: () => void setup() }, "Сохранить приложение"))];
      else if (!gh) body = [h("span", { class: "sb-note" }, "…")];
      else if ("error" in gh) body = [h("span", { class: "sb-note bad" }, `github.app: ${gh.error}`)];
      else if (gh.app)
        body = [
          h("span", null, h("b", { class: "sb-m" }, gh.app.slug), gh.repos?.length ? ` · репозитории: ${gh.repos.join(", ")}` : " · не установлено на репозитории"),
          gh.install ? h("a", { class: "sb-b", href: gh.install, target: "_blank", rel: "noopener" }, "Установить на репозитории ↗") : null,
        ];
      else body = [h("span", { class: "sb-note" }, "Приложения нет: git профилей ходит на GitHub токеном установки приложения флота."), h("div", { class: "sb-opts" }, orgIn, h("button", { class: "sb-b pri", onclick: () => void create(org.trim()) }, "Создать приложение GitHub"))];
      return h("section", { class: "sb-sec", "data-github": "" }, h("h4", { class: "sb-h4" }, "Приложение GitHub флота"), ...body, n?.text ? h("div", { class: `sb-note ${n.tone}` }, n.text) : null);
    }

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const on = (app.roster()?.machines ?? []).map((m) => m.machine);
      add(
        box,
        h("div", { class: "sb-ph" }, h("h2", null, "Машины"), h("span", { class: "sb-note" }, "версии частей задаёт план «выпусков» — инструменты parts в любой сессии")),
        h("div", { class: "mc-cards" }, on.map(card)),
        ghSection(),
        h("div", { class: "sb-note" }, `${on.length} ${plural(on.length, "машина", "машины", "машин")} на связи. Список — машины из roster; когда машина ушла и вернулась — в «Журнале флота».`),
      );
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLInputElement | null)?.focus();
    }

    screens.add(draw);
    ghCode = new URLSearchParams(location.search).get("code") ?? "";
    draw();
    for (const m of app.roster()?.machines ?? []) void load(m.machine);
    void github();
    return { head: () => ({ title: "Машины" }), close: () => screens.delete(draw) };
  }

  return {
    on: { roster: onRoster },
    screens: { machines: { nav: "Машины", label: "Машины", mount } },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
