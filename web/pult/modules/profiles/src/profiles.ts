// pult-profiles — профили флота: ответы machine.profiles всех машин, сведённые в строки по id. Конфликт — состояние репозитория профиля на машине.
// Раньше сводили «Машины» и «Настройки»; теперь это единственный экран профилей.
import { h, plural, projectOf, stateLabel, type App, type AppModule, type Roster, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

const EFFORT: Record<string, string> = { low: "низкое", medium: "среднее", high: "высокое", xhigh: "очень высокое", max: "макс." };

type Repo = { state: "ok" | "error" | "conflict"; files?: string[]; error?: string };
type Answer = { profiles: Record<string, { model?: string | null; effort?: string | null; about?: string }>; repos: Record<string, Repo> };
type Shown = { text: string; human: boolean };

const CSS = `
.pf{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg)}
.pf-h{flex:none;display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line2)}
.pf-h b{font:600 19px/1.2 var(--body)}
.pf-repo{flex:1;min-width:0;font:400 12.5px var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-b{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.pf-t{flex:none;display:flex;gap:6px;align-items:center}
.pf-t input{flex:1;min-width:0;font:400 14px var(--body);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.pf-l{display:flex;flex-direction:column;gap:6px;flex:none}
.pf-w{background:var(--surface);border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.pf-w.cf{border-color:var(--bad)}
.pf-r{display:flex;gap:12px;align-items:flex-start;width:100%;border:0;background:transparent;padding:9px 12px;text-align:left;color:var(--ink)}
.pf-r:hover{background:var(--surface2)}
.pf-n{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.pf-n b{font:600 13.5px var(--body)}
.pf-n span{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-m{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:12.5px}
.pf-m .c{font-size:11.5px;color:var(--muted)}
.pf-p{display:inline-flex;font:600 11px var(--body);padding:1px 7px;border-radius:999px;background:var(--surface2);border:1px solid var(--line2);white-space:nowrap}
.pf-p.ok{background:var(--ok-weak);color:var(--ok);border-color:transparent}
.pf-p.bad{background:var(--bad-weak);color:var(--bad);border-color:transparent}
.pf-d{display:flex;flex-direction:column;gap:8px;padding:2px 12px 10px;border-top:1px solid var(--line2)}
.pf-ms{display:flex;flex-wrap:wrap;gap:4px;padding-top:8px}
.pf-ss{display:flex;flex-direction:column;gap:1px}
.pf-ss button{display:flex;align-items:center;gap:8px;border:0;background:transparent;padding:4px 6px;border-radius:7px;text-align:left;font-size:13px;color:var(--ink)}
.pf-ss button:hover{background:var(--surface2)}
.pf-ss .sb-dot{width:7px;height:7px;animation:none;box-shadow:none;flex:none}
.pf-ss .nm{font:600 13px var(--mono)}
.pf-ss .nm.hum{font-family:var(--body)}
.pf-ss .k{font-size:11.5px;color:var(--muted)}
.pf-cf{border:1px solid var(--bad);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;font-size:12.5px}
.pf-cf code{font:400 12px var(--mono);overflow-wrap:anywhere}
.pf-e{font-size:12.5px;color:var(--bad)}
.pf-none{font-size:12.5px;color:var(--muted);padding:12px}
.sb-app:not(.wide) .pf-m .c{white-space:nowrap}
`;

const repoOf = (id: string) => id.slice(0, id.lastIndexOf("/"));
const short = (id: string) => id.split("/").at(-1) ?? id;

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createProfiles(): AppModule {
  let app: App;
  const answers = new Map<string, Answer | { error: string }>();
  const redraws = new Set<() => void>();

  const can = (m: string) => app.provides(m)?.["machine.profiles"] !== undefined;
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine).filter(can);
  const redraw = () => redraws.forEach((f) => f());
  const mLabel = (m: string) => (app.mark("label.machine", m) as Shown | undefined)?.text ?? `@${m}`;

  async function load(m: string, sync = false) {
    const r = await app.request<Answer>("machine.profiles", sync ? { machine: m, sync: true } : { machine: m });
    answers.set(m, r.ok ? r.result : { error: r.error });
    redraw();
  }

  /** Строки: id → машины, описание и модель первой ответившей, машины с конфликтом. */
  function rows() {
    const out = new Map<string, { id: string; about: string; model: string; effort: string; ms: string[]; cf: Array<{ m: string; repo: Repo }> }>();
    for (const [m, a] of answers) {
      if ("error" in a) continue;
      for (const [id, p] of Object.entries(a.profiles)) {
        const row = out.get(id) ?? { id, about: p.about ?? "", model: p.model ?? "", effort: p.effort ?? "", ms: [], cf: [] };
        row.ms.push(m);
        out.set(id, row);
        const repo = a.repos[repoOf(id)];
        if (!repo || repo.state === "ok") continue;
        // файлы конфликта — под папками профилей: конфликт у того, чьи файлы; ни под чьей — у всех профилей репозитория
        const files = repo.files ?? [];
        const own = files.filter((f) => f.startsWith(`${short(id)}/`));
        const anyone = files.some((f) => Object.keys(a.profiles).some((x) => f.startsWith(`${short(x)}/`)));
        if (own.length || !anyone) row.cf.push({ m, repo: { ...repo, files: own.length ? own : files } });
      }
    }
    return [...out.values()];
  }

  function mount(el: HTMLElement): ScreenHandle {
    let q = "";
    let onlyCf = false;
    let exp: string | null = null;
    let syncing = false;
    const head = h("div", { class: "pf-h" });
    const body = h("div", { class: "pf-b" });
    el.append(h("div", { class: "pf" }, head, body));

    async function syncAll() {
      syncing = true;
      draw();
      await Promise.all(machines().map((m) => load(m, true)));
      syncing = false;
      const cf = rows().flatMap((r) => r.cf.map((x) => `${short(r.id)} ${mLabel(x.m)}`));
      app.toast(cf.length ? `Сведено. Конфликт: ${cf.join(", ")}` : "Сведено", cf.length ? "bad" : "ok");
      draw();
    }

    function draw() {
      const top = body.scrollTop;
      const ae = document.activeElement as HTMLElement | null;
      const keep = !!ae && body.contains(ae) && ae.dataset.f === "q";
      const pos = keep ? (ae as HTMLInputElement).selectionStart : null;
      const all = rows();
      const repos = [...new Set([...answers.values()].flatMap((a) => ("error" in a ? [] : Object.keys(a.repos))))];
      head.replaceChildren(
        ...[app.wide ? h("b", null, "Профили") : null, h("span", { class: "pf-repo" }, repos.join(", ")), h("button", { class: "sb-b", "data-act": "sync", disabled: syncing, onclick: () => void syncAll() }, syncing ? "Свожу…" : "Синхронизировать")].filter((x): x is HTMLElement => !!x),
      );
      const ql = q.trim().toLowerCase();
      const ncf = all.filter((r) => r.cf.length).length;
      if (!ncf) onlyCf = false;
      const shown = all
        .filter((r) => (!ql || `${r.id} ${r.about}`.toLowerCase().includes(ql)) && (!onlyCf || r.cf.length))
        .sort((a, b) => (b.cf.length ? 1 : 0) - (a.cf.length ? 1 : 0) || short(a.id).localeCompare(short(b.id)));
      const nm = machines().length;
      const find = h("input", { "data-f": "q", value: q, placeholder: `Найти профиль · ${all.length}`, autocomplete: "off", "aria-label": "Найти профиль", oninput: (e) => ((q = (e.target as HTMLInputElement).value), draw()) });
      body.replaceChildren(
        h("div", { class: "pf-t" }, find, ncf ? h("button", { class: "sb-b", "data-act": "conflicts", "aria-pressed": String(onlyCf), onclick: () => ((onlyCf = !onlyCf), draw()) }, `конфликты ${ncf}`) : null),
        ...[...answers].filter(([, a]) => "error" in a).map(([m, a]) => h("div", { class: "pf-e", role: "alert" }, `${mLabel(m)}: machine.profiles: ${(a as { error: string }).error}`)),
        h(
          "div",
          { class: "pf-l" },
          shown.length
            ? shown.map((r) => {
                const run = (app.roster()?.sessions ?? []).filter((s) => (s.profile as { id?: string } | null | undefined)?.id === r.id);
                const open = exp === r.id;
                return h(
                  "div",
                  { class: "pf-w" + (r.cf.length ? " cf" : ""), "data-profile": r.id },
                  h(
                    "button",
                    { class: "pf-r", "aria-expanded": String(open), onclick: () => ((exp = open ? null : r.id), draw()) },
                    h("span", { class: "pf-n" }, h("b", null, short(r.id)), r.about ? h("span", null, r.about) : null),
                    h(
                      "span",
                      { class: "pf-m" },
                      h("span", null, [r.model, EFFORT[r.effort] ?? r.effort].filter(Boolean).join(" · ")),
                      h("span", { class: "c" }, `${r.ms.length}/${nm} ${plural(nm, "машины", "машин", "машин")} · ${run.length} ${plural(run.length, "сессия", "сессии", "сессий")}`),
                      r.cf.length ? h("span", { class: "pf-p bad" }, `конфликт ${r.cf.map((x) => mLabel(x.m)).join(", ")}`) : null,
                    ),
                  ),
                  open
                    ? h(
                        "div",
                        { class: "pf-d" },
                        h("div", { class: "pf-ms" }, r.ms.map((m) => (r.cf.some((x) => x.m === m) ? h("span", { class: "pf-p bad" }, `${mLabel(m)} конфликт`) : h("span", { class: "pf-p ok" }, mLabel(m))))),
                        run.length
                          ? h(
                              "div",
                              { class: "pf-ss" },
                              run.map((s) => {
                                const n = (app.mark("label.session", s.callsign) as Shown | undefined) ?? { text: s.callsign, human: false };
                                const lamp = s.state === "failed" ? "bad" : stateLabel(s.state).dot || "stop";
                                return h("button", { "data-callsign": s.callsign, onclick: () => app.open("card", { callsign: s.callsign }) }, h("span", { class: `sb-dot ${lamp}` }), h("span", { class: "nm" + (n.human ? " hum" : "") }, n.text), h("span", { class: "k" }, `${mLabel(machineOf(s.callsign) ?? "")} · ${projectOf(s.dir)}`));
                              }),
                            )
                          : null,
                        r.cf.map((x) => h("div", { class: "pf-cf" }, h("b", null, `${mLabel(x.m)}: ${x.repo.state === "conflict" ? "конфликт" : "ошибка"}`), x.repo.error ? h("span", null, x.repo.error) : null, (x.repo.files ?? []).map((f) => h("code", null, f)))),
                      )
                    : null,
                );
              })
            : h("div", { class: "pf-none" }, "профилей нет"),
        ),
      );
      body.scrollTop = top;
      if (keep) {
        const e = body.querySelector<HTMLInputElement>('[data-f="q"]');
        e?.focus();
        if (e && pos !== null) e.setSelectionRange(pos, pos);
      }
    }
    redraws.add(draw);
    for (const m of machines()) void load(m);
    draw();
    return {
      head: () => ({ title: "Профили" }),
      close: () => redraws.delete(draw),
    };
  }

  return {
    on: {
      roster(r: Roster) {
        // машина пришла при открытом экране — спросить и её
        if (redraws.size) for (const x of r.machines) if (!answers.has(x.machine) && can(x.machine)) void load(x.machine);
      },
    },
    screens: { profiles: { nav: "Профили", group: "Флот", label: "Профили", path: "profiles", mount } },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
