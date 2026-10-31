// pult-machines — машины флота из roster: система и версии, профили, обновление Host, приложение GitHub.
// Каждая цифра — ответ машины или roster; новую версию выбирает машина (machine.upgrade, version: "latest").
import { add, h, hhmm, plural, type App, type AppModule, type Roster, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

type State = { host?: string; sdk?: string; os?: { platform?: string; arch?: string; release?: string }; started?: string; processes?: unknown[] };
type Dry = { from: string; to: string };
type Repo = { state: "ok" | "error" | "conflict"; op?: string; files?: string[]; error?: string; since?: number };
type Profiles = { profiles: Record<string, unknown>; repos: Record<string, Repo> };
type Upg = { from: string; to: string; sdk?: { from: string; to: string }; phase: "sent" | "gone" | "done"; goneAt?: number };
type Gh = { app: { slug: string; id?: number; owner?: string } | null; repos?: string[]; install?: string; form?: { action: string; manifest: Record<string, unknown> } };

const CSS = `
.mc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.mc-hd{display:flex;align-items:center;gap:8px}
.mc-hd b{font:600 16px var(--mono);flex:1}
.mc-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:4px 10px;font-size:13px}
.mc-kv span:nth-child(odd){color:var(--muted)}
.mc-kv span:nth-child(even){font-family:var(--mono);font-size:12.5px}
`;

const OS: Record<string, string> = { win32: "Windows", linux: "Linux", darwin: "macOS" };
/** Слова отказа upgrade → строка на экране. */
function say(w: string, m: string, to?: string): string {
  const t: Record<string, string> = {
    already_current: `${m} уже на ${to ?? "новейшем выпуске"}`,
    upgrade_running: `На ${m} уже идёт обновление`,
    check_failed: `Новая версия не прошла проверку — причина в журнале машины; ${m} работает на прежней`,
    download_failed: "Выпуск не скачался из R2 — причина в журнале машины",
    module_error: "Новая версия модуля не поднялась — модуль выключен на машине, причина в журнале",
    no_release: "В R2 нет выпуска Host",
    not_installed: "Приложение GitHub не допущено к репозиторию",
    app_exists: "Приложение GitHub флота уже есть",
  };
  return t[w] ?? w;
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createMachines(): AppModule {
  let app: App;
  const states = new Map<string, State | { error: string }>();
  const dry = new Map<string, Dry | { error: string }>();
  const profs = new Map<string, Profiles>();
  const upg = new Map<string, Upg>();
  const notes = new Map<string, { text: string; tone: string }>();
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
    if (can(m, "machine.state")) jobs.push(app.request<State>("machine.state", { machine: m }).then((r) => void states.set(m, r.ok ? r.result : { error: r.error })));
    if (can(m, "machine.upgrade")) jobs.push(app.request<Dry>("machine.upgrade", { machine: m, version: "latest", dryRun: true }).then((r) => void dry.set(m, r.ok ? r.result : { error: r.error })));
    if (can(m, "machine.profiles")) jobs.push(app.request<Profiles>("machine.profiles", { machine: m }).then((r) => void (r.ok && profs.set(m, r.result))));
    await Promise.all(jobs);
    redraw();
  }

  async function github() {
    if (!app.roster()?.workers.some((w) => w.name === "github")) return;
    const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname });
    gh = r.ok ? r.result : { error: r.error };
    redraw();
  }

  /** Машина обновляется: ушла из roster — «обновляется»; вернулась (новое since) — снова machine.state. */
  function onRoster(r: Roster) {
    const on = new Map(r.machines.map((m) => [m.machine, m.since]));
    for (const [m, u] of upg) {
      if (u.phase === "sent" && !on.has(m)) Object.assign(u, { phase: "gone", goneAt: Date.now() });
      else if (u.phase === "gone" && on.has(m)) {
        u.phase = "done";
        void load(m);
      }
    }
    redraw();
  }

  async function upgrade(m: string) {
    note(`upg:${m}`, "Отправляю…");
    const r = await app.request<{ from: string; to: string; sdk?: { from: string; to: string } }>("machine.upgrade", { machine: m, version: "latest" });
    const d = dry.get(m);
    if (!r.ok) return note(`upg:${m}`, say(r.error, m, d && "to" in d ? d.to : undefined), "bad");
    upg.set(m, { ...r.result, phase: app.provides(m) ? "sent" : "gone", goneAt: app.provides(m) ? undefined : Date.now() });
    note(`upg:${m}`, "");
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
    if (!r.ok) return note("gh", say(r.error, ""), "bad");
    ghCode = "";
    history.replaceState(null, "", location.pathname + location.hash);
    gh = { app: r.result.app, install: r.result.install, repos: [] };
    note("gh", "Приложение сохранено — установите его на репозитории профилей.", "ok");
  }

  async function create(org: string) {
    let form = gh && "form" in gh ? gh.form : undefined;
    if (org) {
      const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname, org });
      if (!r.ok) return note("gh", say(r.error, ""), "bad");
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
    let dlg = "";
    let org = "";

    function card(m: string): HTMLElement {
      const rm = app.roster()?.machines.find((x) => x.machine === m);
      const st = states.get(m);
      const d = dry.get(m);
      const u = upg.get(m);
      const pr = profs.get(m);
      const n = (app.roster()?.sessions ?? []).filter((s) => machineOf(s.callsign) === m).length;
      const ok = st && !("error" in st) ? st : null;
      const newer = d && !("error" in d) && d.to !== d.from ? d : null;
      const sameSdk = !u?.sdk || u.sdk.from === u.sdk.to;
      return h(
        "section",
        { class: "sb-sec", "data-machine": m },
        h("div", { class: "mc-hd" }, h("b", null, m), rm ? h("span", { class: "sb-pill ok conn" }, "на связи") : h("span", { class: "sb-pill bad" }, "нет в roster"), h("span", { class: "sb-note" }, rm ? `с ${hhmm(rm.since)}` : u?.goneAt ? `с ${hhmm(u.goneAt)}` : "")),
        u?.phase === "sent" || u?.phase === "gone"
          ? h(
              "div",
              { class: "sb-sec wait", "data-upg": u.phase },
              h("b", null, u.phase === "gone" ? `${m} обновляется: ${u.from} → ${u.to}` : `Обновление ${u.from} → ${u.to}`),
              h("span", { class: "sb-note" }, sameSdk ? `SDK тот же — ${u.sdk?.to ?? "?"}: keeper подменяет Host, процессы claude живут, начатые ходы доходят. Машина вернётся в roster сама.` : "SDK новая — каждая сессия перейдёт на неё между ходами, разговор сохранится."),
            )
          : null,
        u?.phase === "done" ? h("div", { class: "sb-sec ok", "data-upg": "done" }, h("b", null, `${m}: ${u.from} → ${u.to}`), h("span", { class: "sb-note" }, sameSdk ? "Сессии не останавливались." : "Сессии перешли на новую SDK между ходами.")) : null,
        ok
          ? h(
              "div",
              { class: "mc-kv" },
              h("span", null, "система"),
              h("span", null, [OS[ok.os?.platform ?? ""] ?? ok.os?.platform, ok.os?.arch].filter(Boolean).join(" ") + (ok.os?.release ? ` · ${ok.os.release}` : "")),
              h("span", null, "Host"),
              h("span", { "data-host": ok.host ?? "" }, `${ok.host ?? "?"} · SDK ${ok.sdk ?? "?"}`),
              h("span", null, "сессии"),
              h("span", null, `${n} · процессов у keeper: ${ok.processes?.length ?? 0}`),
            )
          : st && "error" in st
            ? h("div", { class: "sb-note bad" }, `machine.state: ${st.error}`)
            : rm
              ? h("div", { class: "sb-note" }, "…")
              : null,
        newer && rm && u?.phase !== "sent" ? h("div", { class: "sb-note wait", "data-newer": newer.to }, `есть новая версия · ${newer.to}`) : null,
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
        dlg === m && newer
          ? h(
              "div",
              { class: "sb-sec dlg", "data-dlg": "upgrade" },
              h("h4", { class: "sb-h4" }, `Обновить Host на ${m}`),
              h("b", null, `${newer.from} → ${newer.to}`),
              h("span", { class: "sb-note" }, "новейший выпуск в R2 — его выложил локальный агент или выпуск GitHub; машина берёт его оттуда сама"),
              h("span", { class: "sb-note" }, "SDK та же — сессии не заметят обновления. SDK новая — каждая сессия перейдёт на неё между ходами, разговор сохранится."),
              h("div", { class: "sb-opts" }, h("button", { class: "sb-b", onclick: () => ((dlg = ""), draw()) }, "Отмена"), h("button", { class: "sb-b pri", onclick: () => ((dlg = ""), void upgrade(m)) }, "Обновить")),
            )
          : null,
        notes.get(`upg:${m}`)?.text ? h("div", { class: `sb-note ${notes.get(`upg:${m}`)!.tone}`, role: "status" }, notes.get(`upg:${m}`)!.text) : null,
        notes.get(`sync:${m}`)?.text ? h("div", { class: `sb-note ${notes.get(`sync:${m}`)!.tone}` }, notes.get(`sync:${m}`)!.text) : null,
        rm
          ? h(
              "div",
              { class: "sb-opts" },
              newer && can(m, "machine.upgrade") && u?.phase !== "sent" ? h("button", { class: "sb-b pri", onclick: () => ((dlg = m), draw()) }, `Обновить до ${newer.to}`) : null,
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
      const gone = [...upg.keys()].filter((m) => !on.includes(m));
      const latest = [...dry.values()].filter((d): d is Dry => !("error" in d)).map((d) => d.to).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      add(
        box,
        h("div", { class: "sb-ph" }, h("h2", null, "Машины"), latest ? h("span", { class: "sb-note" }, `новейший выпуск Host в R2: ${latest}`) : null),
        h("div", { class: "mc-cards" }, [...on, ...gone].map(card)),
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
