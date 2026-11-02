// pult-machines — машины флота строками: лампа, имя, система, host, keeper, сессии, состояние; поиск и фильтры.
// Строка раскрывается в карточку: части по ответу keeper (keeper.state), профили, перезапуск упавшей части планом.
// Каждая цифра — ответ keeper, машины или roster. Ушедшую машину помнит, пока страница открыта: roster её больше не несёт.
import { h, hhmm, plural, type App, type AppModule, type Roster, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

type Part = { part: string; version?: string; state?: string; pid?: number; restarts?: number; error?: string };
type State = { keeper?: string; rev?: number; os?: string; parts?: Part[] };
type Repo = { state: "ok" | "error" | "conflict"; op?: string; files?: string[]; error?: string; since?: number };
type Profiles = { profiles: Record<string, unknown>; repos: Record<string, Repo> };
/** Состояние строки: на связи, сбой части, ушла. */
type Mst = "ok" | "fail" | "gone";
type Filter = "project" | "all" | "fail" | "gone";

const CSS = `
.mc-list{background:var(--surface);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
.mc-row{display:flex;align-items:center;border-bottom:1px solid var(--line2)}
.mc-row:last-child{border-bottom:0}
.mc-head{flex:1;min-width:0;display:flex;align-items:center;gap:12px;border:0;background:transparent;text-align:left;padding:10px 14px;font:inherit;color:inherit}
.mc-head:hover{background:var(--surface2)}
.mc-head .n{font:600 13.5px var(--mono);min-width:96px}
.mc-head .os{font-size:12.5px;color:var(--muted);min-width:150px}
.mc-head .v{font:500 12px var(--mono);color:var(--muted)}
.mc-head .st{margin-left:auto;font-size:12.5px;color:var(--muted);white-space:nowrap}
.mc-det{padding:6px 16px 14px 36px;display:flex;flex-direction:column;gap:10px;background:var(--surface2);border-bottom:1px solid var(--line2)}
.mc-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:4px 10px;font-size:13px}
.mc-kv span:nth-child(odd){color:var(--muted)}
.mc-kv span:nth-child(even){font-family:var(--mono);font-size:12.5px}
.mc-kv span.bad{color:var(--bad)}
.mc-parts{display:flex;flex-direction:column;gap:6px}
.mc-part{display:flex;align-items:center;gap:10px;font-size:13px}
.mc-part b{font-weight:600}
.mc-part .v{font:500 12px var(--mono);color:var(--muted)}
.mc-part .e{font-size:12px;color:var(--bad)}
.mc-part .r{margin-left:auto}
@media (max-width:760px){.mc-head .os,.mc-head .v{display:none}.mc-det{padding-left:16px}}
`;

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createMachines(): AppModule {
  let app: App;
  const states = new Map<string, State | { error: string }>();
  const profs = new Map<string, Profiles>();
  const notes = new Map<string, { text: string; tone: string }>();
  /** since машины в последнем roster: вернулась — keeper спрашиваем заново */
  const seen = new Map<string, number>();
  /** машина ушла из roster, пока страница открыта: когда */
  const gone = new Map<string, number>();
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
          note(`profiles:${m}`, r.ok ? "" : `machine.profiles: ${r.error}`, "bad");
        }),
      );
    await Promise.all(jobs);
    redraw();
  }

  function onRoster(r: Roster) {
    const now = new Set(r.machines.map((m) => m.machine));
    for (const m of seen.keys()) if (!now.has(m) && !gone.has(m)) gone.set(m, Date.now());
    for (const m of r.machines) {
      gone.delete(m.machine);
      // вернулась (since другой) или впервые появилась — при открытом экране спросить её keeper и профили
      if (screens.size > 0 && seen.get(m.machine) !== m.since) void load(m.machine);
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

  /** Перезапуск упавшей части — планом машины: выключить и включить; keeper исполняет. */
  async function restart(m: string, part: string) {
    note(`part:${m}:${part}`, "Перезапускаю…");
    const off = await app.request("releases.set", { machine: m, part, on: false });
    if (!off.ok) return note(`part:${m}:${part}`, `releases.set: ${off.error}`, "bad");
    const on = await app.request("releases.set", { machine: m, part, on: true });
    if (!on.ok) return note(`part:${m}:${part}`, `releases.set: ${on.error}`, "bad");
    note(`part:${m}:${part}`, "выключена и включена по плану", "ok");
    void load(m);
  }

  function stateOf(m: string): Mst {
    if (gone.has(m)) return "gone";
    const st = states.get(m);
    return st && !("error" in st) && (st.parts ?? []).some((p) => p.state === "failed") ? "fail" : "ok";
  }

  function mount(el: HTMLElement): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let q = "";
    let filter: Filter = app.mark("project.current") ? "project" : "all";
    let open: string | null = null;

    function detail(m: string): HTMLElement {
      const st = states.get(m);
      const pr = profs.get(m);
      const ok = st && !("error" in st) ? st : null;
      const on = !gone.has(m);
      const noteEl = (k: string) => (notes.get(k)?.text ? h("div", { class: `sb-note ${notes.get(k)!.tone}`, role: "status" }, notes.get(k)!.text) : null);
      return h(
        "div",
        { class: "mc-det", "data-machine": m },
        ok
          ? h(
              "div",
              { class: "mc-kv" },
              h("span", null, "система"),
              h("span", null, ok.os ?? "?"),
              h("span", null, "keeper"),
              h("span", { "data-keeper": ok.keeper ?? "" }, `${ok.keeper ?? "?"} · план rev ${ok.rev ?? 0}`),
              pr ? h("span", null, "профили") : null,
              pr ? h("span", null, Object.entries(pr.repos).map(([repo, s]) => `${repo}${s.state === "ok" ? "" : " · " + s.state}`).join(", ") || "—") : null,
            )
          : st && "error" in st
            ? h("div", { class: "sb-note bad" }, `keeper.state: ${st.error}`)
            : on
              ? h("div", { class: "sb-note" }, "…")
              : null,
        ok
          ? h(
              "div",
              { class: "mc-parts" },
              (ok.parts ?? []).map((p) =>
                h(
                  "div",
                  { class: "mc-part" },
                  h("span", { class: `sb-dot ${p.state === "running" ? "idle" : p.state === "failed" ? "bad" : "stop"}` }),
                  h(
                    "span",
                    null,
                    h("b", null, p.part),
                    " ",
                    h("span", { class: p.state === "failed" ? "v bad" : "v", "data-part": p.part, "data-state": p.state ?? "" }, [p.version, p.state, p.pid ? `pid ${p.pid}` : ""].filter(Boolean).join(" · ")),
                    p.error ? h("div", { class: "e" }, p.error) : null,
                  ),
                  p.state === "failed" && p.part !== "keeper" && app.worker("releases")
                    ? h("button", { class: "sb-b r", onclick: () => void restart(m, p.part) }, "Перезапустить")
                    : null,
                  noteEl(`part:${m}:${p.part}`),
                ),
              ),
            )
          : null,
        ...Object.entries(pr?.repos ?? {})
          .filter(([, s]) => s.state !== "ok")
          .map(([repo, s]) =>
            h(
              "div",
              { class: "sb-sec bad" },
              h("b", null, s.state === "conflict" ? `${repo}: память не сведена` : `${repo}: ${s.error ?? s.state}`),
              s.state === "conflict" ? h("span", { class: "sb-note" }, `${s.op ?? "git pull"}: CONFLICT в ${(s.files ?? []).join(", ")}`) : null,
            ),
          ),
        noteEl(`profiles:${m}`),
        noteEl(`sync:${m}`),
        on
          ? h(
              "div",
              { class: "sb-opts" },
              can(m, "machine.login") ? h("button", { class: "sb-b", onclick: () => app.open("accounts", { machine: m }) }, "Аккаунты машины") : null,
              can(m, "machine.profiles") ? h("button", { class: "sb-b", onclick: () => void sync(m) }, "Синхронизировать профили") : null,
              app.wide ? h("button", { class: "sb-b", onclick: () => app.open("settings", { tab: "releases", machine: m }) }, "План в «Выпусках»") : null,
            )
          : null,
      );
    }

    function row(m: string): HTMLElement[] {
      const st = stateOf(m);
      const k = states.get(m);
      const ok = k && !("error" in k) ? k : null;
      const host = ok?.parts?.find((p) => p.part === "host")?.version;
      const n = (app.roster()?.sessions ?? []).filter((s) => machineOf(s.callsign) === m).length;
      const text = st === "gone" ? `ушла ${hhmm(gone.get(m)!)}` : st === "fail" ? "сбой части" : "на связи";
      const head = h(
        "div",
        { class: "mc-row", "data-row": m, "data-state": st },
        h(
          "button",
          { class: "mc-head", "aria-expanded": open === m ? "true" : "false", onclick: () => ((open = open === m ? null : m), draw()) },
          h("span", { class: `sb-dot ${st === "ok" ? "idle" : st === "gone" ? "gone" : "bad"}` }),
          h("span", { class: "n" }, `@${m}`),
          h("span", { class: "os" }, ok?.os ?? ""),
          h("span", { class: "v" }, host ? `host ${host}` : ""),
          h("span", { class: "v" }, ok?.keeper ? `keeper ${ok.keeper}` : ""),
          h("span", { class: "st" }, [n ? `${n} ${plural(n, "сессия", "сессии", "сессий")}` : "", text].filter(Boolean).join(" · ")),
        ),
      );
      return open === m ? [head, detail(m)] : [head];
    }

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const all = [...new Set([...(app.roster()?.machines ?? []).map((m) => m.machine), ...gone.keys()])];
      // открыт проект — его машины: фильтр «в проекте» первым
      const proj = app.mark("project.current") as string | null | undefined;
      const pm = proj ? ((app.mark("project.machines", proj) as string[] | undefined) ?? []) : [];
      if (filter === "project" && !proj) filter = "all";
      const F: Record<Filter, [string, (m: string) => boolean]> = {
        project: [proj ? `в проекте ${proj}` : "", (m) => pm.includes(m)],
        all: ["все", () => true],
        fail: ["со сбоем", (m) => stateOf(m) === "fail"],
        gone: ["ушли", (m) => stateOf(m) === "gone"],
      };
      const t = q.trim().toLowerCase();
      const shown = all.filter((m) => F[filter][1](m) && (!t || m.toLowerCase().includes(t) || (states.get(m) as State | undefined)?.os?.toLowerCase().includes(t)));
      const qi = h("input", { class: "sb-in", "data-f": "q", type: "search", placeholder: "Найти машину", value: q }) as HTMLInputElement;
      qi.addEventListener("input", () => ((q = qi.value), draw()));
      box.append(
        h(
          "div",
          { class: "sb-ph" },
          qi,
          h(
            "div",
            { class: "sb-opts" },
            (Object.keys(F) as Filter[]).filter((k) => k !== "project" || !!proj).map((k) => h("button", { class: "sb-b", "data-filter": k, "aria-pressed": filter === k ? "true" : "false", onclick: () => ((filter = k), draw()) }, `${F[k][0]} ${all.filter(F[k][1]).length}`)),
          ),
        ),
        shown.length ? h("div", { class: "mc-list" }, shown.flatMap(row)) : h("div", { class: "sb-note" }, "Таких машин нет"),
      );
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLInputElement | null)?.focus();
    }

    screens.add(draw);
    draw();
    for (const m of app.roster()?.machines ?? []) void load(m.machine);
    return { head: () => ({ title: "Машины" }), close: () => screens.delete(draw) };
  }

  return {
    on: { roster: onRoster },
    screens: { machines: { nav: "Машины", group: "Флот", label: "Машины", mount } },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
