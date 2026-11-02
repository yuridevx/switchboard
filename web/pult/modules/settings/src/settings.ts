// pult-settings — настройки флота вкладками: выпуски по машинам и каталог, пропуска, GitHub и устройство.
// Каждая цифра — ответ владельца: «Выпусков» (stable, планы), keeper машины (что стоит), gate (пропуска), github, профилей.
import { add, h, plural, type App, type AppModule, type Params, type Roster, type ScreenHandle } from "@switchboard/web-core";

type Entry = { pin?: string; on?: boolean; force?: boolean };
type Listed = { parts: Record<string, { where: "machine" | "cloud"; edge: string | null; stable: string | null }>; machines: Array<{ machine: string; plan: Record<string, Entry> }>; rev: number };
type KPart = { part: string; version?: string; state?: string; error?: string };
type KState = { keeper?: string; rev?: number; os?: string; parts?: KPart[] };
type Pass = { id: string; role: "host" | "client"; name: string; person: string | null; addr: string; state: "wait" | "ok" | "revoked"; by: string; at: number };
type Repo = { state: "ok" | "error" | "conflict"; error?: string };
type Profiles = { profiles: Record<string, unknown>; repos: Record<string, Repo> };
type Gh = { app: { slug: string } | null; repos?: string[]; install?: string; form?: { action: string; manifest: Record<string, unknown> } };
type Err = { error: string };
type Cell = { k: "ok" | "upd" | "behind" | "fail" | "off" | "gone"; t: string; pin?: string; why?: string };
type Tab = "releases" | "passes" | "general";

const CSS = `
.st-tabs{display:flex;gap:6px;flex-wrap:nowrap}
.st-roll{display:flex;align-items:center;gap:10px;font-size:13px}
.st-roll .sb-barw{width:120px}
.st-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--busy-weak);border:1px solid var(--busy);border-radius:10px;padding:8px 12px;font-size:13px}
.st-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start}
.st-side{position:sticky;top:0}
.st-mx{width:100%;border-collapse:collapse;font-size:12.5px}
.st-mx th{font:600 11.5px var(--body);color:var(--muted);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line2);white-space:nowrap}
.st-mx td{padding:4px 8px;white-space:nowrap}
.st-mx tr[aria-current="true"] td{background:var(--accent-weak)}
.st-ck{width:18px;height:18px;padding:0;border:1px solid var(--line);border-radius:5px;background:var(--surface);font-size:11px;line-height:1}
.st-ck[aria-checked="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.st-mn{display:flex;gap:7px;align-items:center;border:0;background:transparent;padding:3px 6px;border-radius:6px;font:500 12.5px var(--mono);color:var(--ink)}
.st-cell{display:inline-block;font:500 12px var(--mono);padding:2px 7px;border-radius:6px;background:var(--ok-weak);color:var(--ok)}
.st-cell.behind,.st-cell.upd{background:var(--busy-weak);color:var(--busy)}
.st-cell.fail{background:var(--bad-weak);color:var(--bad)}
.st-cell.off,.st-cell.gone{background:var(--surface2);color:var(--muted)}
.st-part{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-top:1px solid var(--line2)}
.st-tbl{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
.st-tbl th{font:600 11.5px var(--body);color:var(--muted);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line2)}
.st-tbl td{padding:7px 8px;border-bottom:1px solid var(--line2);vertical-align:middle;overflow:hidden;text-overflow:ellipsis}
.st-repos{max-height:340px;overflow-y:auto;border:1px solid var(--line2);border-radius:9px;background:var(--surface2)}
.st-repo{display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--line2);font-size:13px}
.st-repo:last-child{border-bottom:0}
.st-two{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px;align-items:start}
@media (max-width:900px){.st-grid,.st-two{grid-template-columns:minmax(0,1fr)}}
`;

/** Слова отказа → строка на экране. */
function say(w: string): string {
  const t: Record<string, string> = {
    check_failed: "проверка флота не прошла",
    no_release: "такой версии нет",
    no_build: "приложение не собирается «Выпусками»",
    no_part: "такой части нет",
    cf_failed: "Cloudflare не принял",
    bad_version: "номер версии не того вида",
    name_taken: "у адреса уже есть живой пропуск — сначала отзовите прежний",
    unknown_key: "такого пропуска нет",
    not_installed: "приложение GitHub не допущено к репозиторию",
    app_exists: "приложение GitHub флота уже есть",
  };
  return t[w] ?? w;
}

/** Сборка «+n»: прежняя — «+n−1»; версия каталога — null. */
export function prevBuild(v: string | null | undefined): string | null {
  const m = /^(.+)\+(\d+)$/.exec(v ?? "");
  return m && Number(m[2]) > 1 ? `${m[1]}+${Number(m[2]) - 1}` : null;
}
const short = (v: string) => (v.includes("+") ? "+" + v.split("+")[1] : v);

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createSettings(): AppModule {
  let app: App;
  let list: Listed | Err | null = null;
  const kst = new Map<string, KState | Err>();
  let passes: Pass[] | Err | null = null;
  const profs = new Map<string, Profiles | Err>();
  let gh: Gh | Err | null = null;
  let ghCode = "";
  // вид экрана: вкладка выпусков, выбранная машина, отмеченные, поиск, форма приглашения, подтверждение отзыва
  let rtab: "machines" | "catalog" = "machines";
  let rm: string | null = null;
  const rsel = new Set<string>();
  let rq = "";
  let gq = "";
  let used = false;
  let inviting: { kind: "device" | "program" | "machine"; name: string; person: string } | null = null;
  let invited: { kind: "device" | "program" | "machine"; invite: string; addr: string } | null = null;
  let confirm: string | null = null;
  let busy = "";
  const notes = new Map<string, { text: string; tone: string }>();
  const screens = new Set<() => void>();
  /** открытые вкладки, которым нужны ответы машин: машина пришла в roster — спросить её */
  const open = { releases: 0, general: 0 };
  const redraw = () => screens.forEach((d) => d());
  const note = (k: string, text: string, tone = "") => {
    notes.set(k, { text, tone });
    redraw();
  };
  const noteEl = (k: string) => {
    const n = notes.get(k);
    return n?.text ? h("div", { class: `sb-note ${n.tone}`, role: n.tone === "bad" ? "alert" : null }, n.text) : null;
  };
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine);
  const can = (m: string, n: string) => app.provides(m)?.[n] !== undefined;

  // ───────── данные ─────────
  async function loadList() {
    if (!app.worker("releases")) return;
    const r = await app.request<Listed>("releases.list");
    list = r.ok ? r.result : { error: r.error };
    redraw();
  }
  async function loadKeeper(m: string) {
    // keeper машины отвечает сам, даже когда Host мёртв
    const r = await app.request<KState>("keeper.state", { to: `.keeper@${m}` });
    kst.set(m, r.ok ? r.result : { error: r.error });
    redraw();
  }
  async function loadReleases() {
    await Promise.all([loadList(), ...machines().map(loadKeeper)]);
  }
  async function loadPasses() {
    const r = await app.request<{ passes: Pass[] }>("keys.list");
    passes = r.ok ? r.result.passes : { error: r.error };
    redraw();
  }
  async function loadProfiles(sync = false) {
    await Promise.all(
      machines()
        .filter((m) => can(m, "machine.profiles"))
        .map(async (m) => {
          const r = await app.request<Profiles>("machine.profiles", sync ? { machine: m, sync: true } : { machine: m });
          profs.set(m, r.ok ? r.result : { error: r.error });
        }),
    );
    redraw();
  }
  async function loadGithub() {
    if (!app.worker("github")) return;
    const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname });
    gh = r.ok ? r.result : { error: r.error };
    redraw();
  }

  // ───────── выпуски: что держит машина ─────────
  function planOf(m: string): Record<string, Entry> {
    return list && !("error" in list) ? (list.machines.find((x) => x.machine === m)?.plan ?? {}) : {};
  }
  function stableOf(part: string): string | null {
    return list && !("error" in list) ? (list.parts[part]?.stable ?? null) : null;
  }
  /** Ячейка матрицы: что стоит на машине против того, что ей велено (закрепление плана, иначе stable). */
  function cellOf(m: string, part: string): Cell | null {
    const st = kst.get(m);
    const pe = planOf(m)[part];
    const pin = pe?.pin;
    const want = pin ?? stableOf(part);
    const online = machines().includes(m);
    const kp = st && !("error" in st) ? (part === "keeper" && st.keeper ? { part, version: st.keeper, state: "running" } : st.parts?.find((x) => x.part === part)) : undefined;
    if (!online || !st || "error" in st) return kp || pe || want ? { k: "gone", t: kp?.version ?? want ?? "—", pin } : null;
    if (!kp && !pe) return null;
    if (pe?.on === false) return { k: "off", t: "выключена", pin };
    if (kp?.state === "failed") return { k: "fail", t: `${kp.version ?? "?"} · сбой`, pin, why: kp.error };
    if (kp?.version && want && kp.version !== want) return { k: kp.state === "starting" || kp.state === "updating" ? "upd" : "behind", t: `${kp.version} → ${want}`, pin };
    return { k: "ok", t: kp?.version ?? want ?? "—", pin };
  }
  const machineParts = () => {
    const fromList = list && !("error" in list) ? Object.entries(list.parts).filter(([, p]) => p.where === "machine").map(([n]) => n) : [];
    const seen = [...kst.values()].flatMap((s) => ("error" in s ? [] : (s.parts ?? []).map((p) => p.part)));
    const all = [...new Set([...fromList, ...seen])];
    const rank = (p: string) => (p === "host" ? 0 : p === "keeper" ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  };
  /** Машины матрицы: на связи и те, у кого есть план. */
  const relMachines = () => {
    const planned = list && !("error" in list) ? list.machines.map((x) => x.machine) : [];
    return [...new Set([...machines(), ...planned])].sort();
  };

  async function setPlan(m: string, part: string, body: Record<string, unknown>, quiet = false) {
    const r = await app.request<{ machine: string; rev: number }>("releases.set", { machine: m, part, ...body });
    if (!r.ok) {
      note("rel", `@${m} ${part}: ${say(r.error)}`, "bad");
      return false;
    }
    if (!quiet) app.toast(`@${m}: план rev ${r.result.rev}`, "ok");
    return true;
  }
  async function pin(m: string, part: string, v: string | null) {
    if (await setPlan(m, part, { pin: v })) await Promise.all([loadList(), loadKeeper(m)]);
  }
  async function toggle(m: string, part: string) {
    const on = planOf(m)[part]?.on !== false;
    if (await setPlan(m, part, { on: !on })) await Promise.all([loadList(), loadKeeper(m)]);
  }
  async function bulk(v: string | null) {
    const ms = [...rsel];
    const done = await Promise.all(ms.map((m) => setPlan(m, "host", { pin: v }, true)));
    const ok = done.filter(Boolean).length;
    app.toast(`${ok} ${plural(ok, "машина", "машины", "машин")}: план изменён`, ok === ms.length ? "ok" : "bad");
    rsel.clear();
    await Promise.all([loadList(), ...ms.map(loadKeeper)]);
  }
  async function deploy(part: string, version?: string) {
    busy = part;
    note("deploy", "");
    const r = await app.request<{ parts: Record<string, { from: string | null; to: string }> }>("releases.deploy", version ? { part, version } : { part });
    busy = "";
    if (!r.ok) {
      note("deploy", `Не выложен ${part}${version ? " " + version : ""}: ${say(r.error)}`, "bad");
      return;
    }
    const moved = Object.entries(r.result.parts).map(([p, x]) => `${p} ${x.from ?? "—"} → ${x.to}`);
    note("deploy", `Выложено: ${moved.join(", ")}`, "ok");
    await loadReleases();
  }

  // ───────── пропуска ─────────
  async function invite() {
    if (!inviting) return;
    const { kind, name, person } = inviting;
    const role = kind === "machine" ? "host" : "client";
    const r = await app.request<{ kid: string; invite: string; addr: string }>("keys.invite", { role, name: name.trim(), ...(role === "client" ? { person: person.trim() } : {}) });
    if (!r.ok) return note("invite", say(r.error), "bad");
    invited = { kind, invite: r.result.invite, addr: r.result.addr };
    inviting = null;
    note("invite", "");
    await loadPasses();
  }
  async function revoke(p: Pass) {
    const r = await app.request<{ addr: string }>("keys.revoke", { kid: p.id });
    confirm = null;
    if (!r.ok) return note("passes", `${p.addr}: ${say(r.error)}`, "bad");
    app.toast(`${p.addr} отозван — соединения закрыты`, "ok");
    await loadPasses();
  }
  function copy(text: string) {
    // буфер — по нажатию; отказ браузера — словом
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (!clip) return app.toast("Буфер обмена недоступен — выделите строку");
    clip.writeText(text).then(
      () => app.toast("Скопировано", "ok"),
      () => app.toast("Буфер обмена недоступен — выделите строку"),
    );
  }

  // ───────── GitHub ─────────
  async function setup() {
    note("gh", "Сохраняю приложение…");
    const r = await app.request<{ app: { slug: string }; install: string }>("github.setup", { code: ghCode });
    if (!r.ok) return note("gh", say(r.error), "bad");
    ghCode = "";
    history.replaceState(null, "", location.pathname + location.hash);
    gh = { app: r.result.app, install: r.result.install, repos: [] };
    note("gh", "Приложение сохранено — установите его на репозитории.", "ok");
  }
  async function create(org: string) {
    let form = gh && !("error" in gh) ? gh.form : undefined;
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
  /** Репозиторий → машины, чьи профили в нём, и их состояния. */
  function profileRepos(): Map<string, Array<{ m: string; state: string }>> {
    const out = new Map<string, Array<{ m: string; state: string }>>();
    for (const [m, p] of profs) {
      if ("error" in p) continue;
      for (const [repo, s] of Object.entries(p.repos)) out.set(repo, [...(out.get(repo) ?? []), { m, state: s.state }]);
    }
    return out;
  }

  // ───────── экран ─────────
  function mount(el: HTMLElement, params: Params): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    const tab = (): Tab => (!app.wide ? "general" : params.tab === "passes" || params.tab === "general" ? params.tab : "releases");
    if (params.machine) rm = params.machine;

    function tabs(): HTMLElement | null {
      if (!app.wide) return null;
      const t = tab();
      const b = (k: Tab, l: string) => h("button", { class: "sb-b", role: "tab", "aria-selected": t === k ? "true" : "false", "aria-pressed": t === k ? "true" : "false", "data-tab": k, onclick: () => app.open("settings", { tab: k }) }, l);
      return h("div", { class: "st-tabs", role: "tablist" }, b("releases", "Выпуски"), b("passes", "Пропуска"), b("general", "GitHub и устройство"));
    }

    // ── выпуски по машинам ──
    function rollH(): HTMLElement {
      const on = machines();
      const rows = ["host", "keeper"].filter((p) => stableOf(p)).map((p) => {
        const n = on.filter((m) => cellOf(m, p)?.k === "ok").length;
        const back = prevBuild(stableOf(p));
        return h(
          "div",
          { class: "st-roll", "data-roll": p },
          h("span", { style: "flex:1" }, h("b", null, p), " ", h("span", { class: "sb-m" }, stableOf(p)!)),
          h("span", { class: `sb-barw${n < on.length ? " warn" : ""}` }, h("i", { style: `width:${on.length ? Math.round((n / on.length) * 100) : 0}%` })),
          h("span", { class: "sb-note" }, `${n} из ${on.length} ${plural(on.length, "машины", "машин", "машин")}`),
          back ? h("button", { class: "sb-b", disabled: busy !== "", onclick: () => void deploy(p, back) }, `Вернуть ${short(back)}`) : null,
        );
      });
      return h("section", { class: "sb-sec" }, h("b", null, "Stable флота"), ...rows, noteEl("deploy"));
    }
    function matrixH(): HTMLElement {
      const parts = machineParts();
      const q = rq.trim().toLowerCase();
      const ms = relMachines().filter((m) => !q || m.toLowerCase().includes(q));
      const search = h("input", { class: "sb-in", "data-f": "rq", placeholder: "Найти машину", "aria-label": "Найти машину", value: rq, style: "max-width:220px" }) as HTMLInputElement;
      search.addEventListener("input", () => {
        rq = search.value;
        redraw();
      });
      const rows = ms.map((m) => {
        const st = kst.get(m);
        const online = machines().includes(m);
        const tone = !online ? "stop" : st && "error" in st ? "wait" : parts.some((p) => cellOf(m, p)?.k === "fail") ? "wait" : "idle";
        return h(
          "tr",
          { "data-machine": m, "aria-current": rm === m ? "true" : null },
          h("td", null, h("button", { class: "st-ck", role: "checkbox", "aria-checked": rsel.has(m) ? "true" : "false", "aria-label": `Выбрать ${m}`, onclick: () => (rsel.has(m) ? rsel.delete(m) : rsel.add(m), redraw()) }, rsel.has(m) ? "✓" : "")),
          h("td", null, h("button", { class: "st-mn", onclick: () => ((rm = rm === m ? null : m), redraw()) }, h("span", { class: `sb-dot ${tone}` }), `@${m}`)),
          ...parts.map((p) => {
            const c = cellOf(m, p);
            return h("td", { "data-part": p }, c ? h("span", { class: `st-cell ${c.k}`, title: c.why ?? null }, `${c.pin ? "📌 " : ""}${c.t}`) : h("span", { class: "sb-note" }, "—"));
          }),
          h("td", { class: "sb-note" }, st && !("error" in st) ? `rev ${st.rev ?? 0}` : online ? (st ? `keeper: ${st.error}` : "…") : "не на связи"),
        );
      });
      return h(
        "section",
        { class: "sb-sec", style: "min-width:0" },
        h("div", { class: "sb-ph" }, search, h("span", { class: "sb-note", style: "margin-left:auto" }, `${ms.length} ${plural(ms.length, "машина", "машины", "машин")}`)),
        h("div", { style: "overflow-x:auto" }, h("table", { class: "st-mx" }, h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "машина"), ...parts.map((p) => h("th", null, p)), h("th", null, "план"))), h("tbody", null, rows))),
      );
    }
    function planH(m: string): HTMLElement {
      const st = kst.get(m);
      const verInput = new Map<string, HTMLInputElement>();
      return h(
        "section",
        { class: "sb-sec st-side", "data-plan": m },
        h("div", { class: "sb-ph" }, h("b", { class: "sb-m", style: "flex:1" }, `@${m}`), st && !("error" in st) && st.os ? h("span", { class: "sb-note" }, st.os) : null, h("button", { class: "sb-b", "aria-label": "Закрыть", onclick: () => ((rm = null), redraw()) }, "✕")),
        h("span", { class: "sb-note" }, `план rev ${st && !("error" in st) ? (st.rev ?? 0) : "—"}${machines().includes(m) ? "" : " · не на связи"}`),
        ...machineParts()
          .filter((p) => cellOf(m, p))
          .map((p) => {
            const c = cellOf(m, p)!;
            const stable = stableOf(p);
            const edge = list && !("error" in list) ? (list.parts[p]?.edge ?? null) : null;
            const pinned = planOf(m)[p]?.pin;
            const choices = [...new Set([edge, prevBuild(stable), pinned].filter((v): v is string => !!v && v !== stable))];
            const vin = h("input", { class: "sb-in m", placeholder: "версия", "aria-label": `Версия ${p}`, style: "width:110px" }) as HTMLInputElement;
            verInput.set(p, vin);
            return h(
              "div",
              { class: "st-part", "data-part": p },
              h("div", { class: "sb-ph" }, h("b", { style: "flex:1" }, p), h("span", { class: `st-cell ${c.k}` }, c.t)),
              c.why ? h("span", { class: "sb-note bad" }, c.why) : null,
              stable || choices.length
                ? h(
                    "div",
                    { class: "sb-opts" },
                    stable ? h("button", { class: "sb-b", "aria-pressed": pinned ? "false" : "true", onclick: () => void pin(m, p, null) }, `stable ${short(stable)}`) : null,
                    ...choices.map((v) => h("button", { class: "sb-b", "aria-pressed": pinned === v ? "true" : "false", onclick: () => void pin(m, p, v) }, `📌 ${short(v)}`)),
                    vin,
                    h("button", { class: "sb-b", onclick: () => (vin.value.trim() ? void pin(m, p, vin.value.trim()) : undefined) }, "Закрепить"),
                  )
                : null,
              p === "keeper"
                ? null
                : h("label", { class: "sb-opts" }, h("button", { class: "sb-b", role: "switch", "aria-checked": planOf(m)[p]?.on === false ? "false" : "true", "aria-pressed": planOf(m)[p]?.on === false ? "false" : "true", onclick: () => void toggle(m, p) }, planOf(m)[p]?.on === false ? "выключена" : "включена")),
            );
          }),
        noteEl("rel"),
      );
    }
    function bulkH(): HTMLElement | null {
      if (!rsel.size) return null;
      const stable = stableOf("host");
      const vs = [...new Set([prevBuild(stable), list && !("error" in list) ? list.parts.host?.edge : null].filter((v): v is string => !!v && v !== stable))];
      return h(
        "div",
        { class: "st-bulk", "data-bulk": "" },
        h("b", null, `Выбрано ${rsel.size}`),
        h("span", { class: "sb-note" }, [...rsel].map((m) => "@" + m).join(", ")),
        h("span", { style: "flex:1" }),
        ...vs.map((v) => h("button", { class: "sb-b", onclick: () => void bulk(v) }, `host: закрепить ${short(v)}`)),
        h("button", { class: "sb-b", onclick: () => void bulk(null) }, "host: к stable"),
        h("button", { class: "sb-b", onclick: () => (rsel.clear(), redraw()) }, "Снять"),
      );
    }
    // ── каталог и сборки ──
    function catalogH(): HTMLElement {
      const ls = list && !("error" in list) ? list : null;
      const rows = Object.entries(ls?.parts ?? {}).sort(([a], [b]) => a.localeCompare(b));
      const nameIn = h("input", { class: "sb-in m", "data-f": "dep", placeholder: "модуль", "aria-label": "Модуль" }) as HTMLInputElement;
      const verIn = h("input", { class: "sb-in m", placeholder: "версия", "aria-label": "Версия модуля", style: "width:110px" }) as HTMLInputElement;
      return h(
        "div",
        { style: "display:flex;flex-direction:column;gap:12px" },
        h(
          "section",
          { class: "sb-sec" },
          h("b", null, "Части"),
          h(
            "table",
            { class: "st-tbl" },
            h("thead", null, h("tr", null, h("th", null, "часть"), h("th", null, "где"), h("th", null, "stable"), h("th", null, "новее"), h("th", { style: "width:30%" }, ""))),
            h(
              "tbody",
              null,
              rows.map(([p, x]) => {
                const back = prevBuild(x.stable);
                return h(
                  "tr",
                  { "data-part": p },
                  h("td", { class: "sb-m" }, p),
                  h("td", null, x.where === "cloud" ? "Cloudflare" : "машины"),
                  h("td", { class: "sb-m" }, x.stable ?? "—"),
                  h("td", { class: "sb-m" }, x.edge && x.edge !== x.stable ? x.edge : ""),
                  h(
                    "td",
                    null,
                    h(
                      "div",
                      { class: "sb-opts" },
                      x.edge && x.edge !== x.stable ? h("button", { class: "sb-b pri", disabled: busy !== "", onclick: () => void deploy(p, x.edge!) }, busy === p ? "Выкладываю…" : `Выложить ${short(x.edge)}`) : null,
                      back ? h("button", { class: "sb-b", disabled: busy !== "", onclick: () => void deploy(p, back) }, `Вернуть ${short(back)}`) : null,
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
        h(
          "section",
          { class: "sb-sec" },
          h("b", null, "Модуль сборки"),
          h("div", { class: "sb-opts" }, nameIn, verIn, h("button", { class: "sb-b pri", disabled: busy !== "", onclick: () => (nameIn.value.trim() ? void deploy(nameIn.value.trim(), verIn.value.trim() || undefined) : undefined) }, busy && !ls?.parts[busy] ? "Выкладываю…" : "Выложить")),
        ),
        noteEl("deploy"),
      );
    }
    function releasesH(): Array<HTMLElement | null> {
      if (!app.worker("releases")) return [h("div", { class: "sb-note" }, "«Выпусков» во флоте нет")];
      const sub = h(
        "div",
        { class: "st-tabs" },
        h("button", { class: "sb-b", "aria-pressed": rtab === "machines" ? "true" : "false", onclick: () => ((rtab = "machines"), redraw()) }, "По машинам"),
        h("button", { class: "sb-b", "aria-pressed": rtab === "catalog" ? "true" : "false", onclick: () => ((rtab = "catalog"), redraw()) }, "Каталог и сборки"),
      );
      if (list && "error" in list) return [sub, h("div", { class: "sb-note bad", role: "alert" }, `releases.list: ${list.error}`)];
      if (!list) return [sub, h("div", { class: "sb-note" }, "…")];
      if (rtab === "catalog") return [sub, catalogH()];
      return [sub, rollH(), bulkH(), h("div", { class: "st-grid" }, matrixH(), rm ? planH(rm) : h("span"))];
    }

    // ── пропуска ──
    function passesH(): Array<HTMLElement | null> {
      const form = inviting
        ? (() => {
            const f = inviting;
            const nameIn = h("input", { class: "sb-in", "data-f": "iname", placeholder: f.kind === "machine" ? "имя машины" : "laptop", "aria-label": "Имя", value: f.name }) as HTMLInputElement;
            nameIn.addEventListener("input", () => (f.name = nameIn.value));
            const whoIn = h("input", { class: "sb-in", "data-f": "iwho", placeholder: "почта", "aria-label": "Почта", value: f.person }) as HTMLInputElement;
            whoIn.addEventListener("input", () => (f.person = whoIn.value));
            const kind = (k: typeof f.kind, l: string) => h("button", { class: "sb-b", "aria-pressed": f.kind === k ? "true" : "false", onclick: () => ((f.kind = k), redraw()) }, l);
            return h(
              "section",
              { class: "sb-sec", "data-invite": "" },
              h("div", { class: "sb-opts" }, kind("device", "устройство"), kind("program", "программа"), kind("machine", "машина")),
              h("div", { class: "sb-opts" }, nameIn, f.kind === "machine" ? null : whoIn),
              h("div", { class: "sb-opts" }, h("button", { class: "sb-b pri", onclick: () => void invite() }, "Пригласить"), h("button", { class: "sb-b", onclick: () => ((inviting = null), redraw()) }, "Отмена")),
              noteEl("invite"),
            );
          })()
        : invited
          ? (() => {
              const x = invited;
              const text = x.kind === "device" ? `${location.origin}${location.pathname}#invite=${x.invite}` : x.invite;
              return h(
                "section",
                { class: "sb-sec ok", "data-invited": "" },
                h("span", null, x.kind === "device" ? "Ссылка для " : x.kind === "program" ? "Приглашение для " : "Приглашение машины ", h("b", { class: "sb-m" }, x.addr)),
                h("div", { class: "sb-opts" }, h("code", { class: "sb-cmd", style: "flex:1;min-width:0;overflow-wrap:anywhere" }, text), h("button", { class: "sb-b pri", onclick: () => copy(text) }, "Копировать")),
                h("div", { class: "sb-opts" }, h("button", { class: "sb-b", onclick: () => ((invited = null), redraw()) }, "Готово")),
              );
            })()
          : null;
      const ps = passes && !("error" in passes) ? passes : [];
      const me = ps.find((p) => p.role === "client" && p.name === app.name && p.state === "ok");
      const word = { ok: ["действует", "ok"], wait: ["ждёт приёма", "wait"], revoked: ["отозван", "bad"] } as const;
      const table = (title: string, rows: Pass[]) =>
        rows.length
          ? h(
              "section",
              { class: "sb-sec", "data-passes": title },
              h("b", null, title),
              h(
                "table",
                { class: "st-tbl" },
                h("colgroup", null, h("col", { style: "width:28%" }), h("col", { style: "width:16%" }), h("col", { style: "width:22%" }), h("col", { style: "width:14%" }), h("col", null)),
                h("thead", null, h("tr", null, h("th", null, "адрес"), h("th", null, "состояние"), h("th", null, "кто пригласил"), h("th", null, "когда"), h("th", null, ""))),
                h(
                  "tbody",
                  null,
                  rows.map((p) =>
                    h(
                      "tr",
                      { "data-pass": p.id },
                      h("td", { class: "sb-m" }, p.addr),
                      h("td", null, h("span", { class: `sb-pill ${word[p.state][1]}` }, word[p.state][0])),
                      h("td", { class: "sb-m" }, p.by),
                      h("td", null, new Date(p.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })),
                      h(
                        "td",
                        null,
                        p.state === "revoked"
                          ? null
                          : p === me
                            ? h("span", { class: "sb-note" }, "это устройство")
                            : confirm === p.id
                              ? h("div", { class: "sb-opts" }, h("button", { class: "sb-b bad", onclick: () => void revoke(p) }, "Отозвать"), h("button", { class: "sb-b", onclick: () => ((confirm = null), redraw()) }, "Отмена"))
                              : h("button", { class: "sb-b bad", onclick: () => ((confirm = p.id), redraw()) }, "Отозвать…"),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null;
      return [
        form,
        passes && "error" in passes ? h("div", { class: "sb-note bad", role: "alert" }, `keys.list: ${passes.error}`) : passes ? null : h("div", { class: "sb-note" }, "…"),
        table("Машины", ps.filter((p) => p.role === "host")),
        table("Устройства и программы", ps.filter((p) => p.role === "client")),
        noteEl("passes"),
      ];
    }

    // ── GitHub и устройство ──
    function ghH(): HTMLElement | null {
      if (!app.worker("github")) return null;
      const used_ = profileRepos();
      let body: Array<HTMLElement | null>;
      if (ghCode) body = [h("span", null, "GitHub вернул код нового приложения."), h("div", { class: "sb-opts" }, h("button", { class: "sb-b pri", onclick: () => void setup() }, "Сохранить приложение"))];
      else if (!gh) body = [h("span", { class: "sb-note" }, "…")];
      else if ("error" in gh) body = [h("span", { class: "sb-note bad" }, `github.app: ${gh.error}`)];
      else if (gh.app) {
        const repos = gh.repos ?? [];
        const q = gq.trim().toLowerCase();
        const shown = repos.filter((r) => (!used || used_.has(r)) && (!q || r.toLowerCase().includes(q)));
        const search = h("input", { class: "sb-in", "data-f": "gq", placeholder: "Найти репозиторий", "aria-label": "Найти репозиторий", value: gq, style: "flex:1" }) as HTMLInputElement;
        search.addEventListener("input", () => {
          gq = search.value;
          redraw();
        });
        const nUsed = repos.filter((r) => used_.has(r)).length;
        body = [
          h("div", { class: "sb-ph" }, h("b", { class: "sb-m", style: "flex:1" }, gh.app.slug), h("span", { class: "sb-pill ok" }, `${repos.length} ${plural(repos.length, "репозиторий", "репозитория", "репозиториев")}`), gh.install ? h("a", { class: "sb-b", href: gh.install, target: "_blank", rel: "noopener" }, "Доступ на GitHub ↗") : null),
          repos.length
            ? h(
                "div",
                { class: "sb-opts", style: "flex-wrap:nowrap" },
                search,
                h("button", { class: "sb-b", "aria-pressed": used ? "false" : "true", onclick: () => ((used = false), redraw()) }, `все ${repos.length}`),
                h("button", { class: "sb-b", "aria-pressed": used ? "true" : "false", onclick: () => ((used = true), redraw()) }, `используются ${nUsed}`),
              )
            : null,
          repos.length
            ? h(
                "div",
                { class: "st-repos" },
                shown.length
                  ? shown.map((r) => h("div", { class: "st-repo", "data-repo": r }, h("span", { class: "sb-m", style: "flex:1" }, r), used_.has(r) ? h("span", { class: "sb-note" }, `профили · ${used_.get(r)!.map((x) => x.m).join(", ")}`) : null))
                  : h("div", { class: "st-repo sb-note" }, "Таких нет"),
              )
            : null,
        ];
      } else {
        let org = "";
        const orgIn = h("input", { class: "sb-in m", "data-f": "org", placeholder: "организация", "aria-label": "Организация" }) as HTMLInputElement;
        orgIn.addEventListener("input", () => (org = orgIn.value));
        body = [h("div", { class: "sb-opts" }, orgIn, h("button", { class: "sb-b pri", onclick: () => void create(org.trim()) }, "Создать приложение GitHub"))];
      }
      return h("section", { class: "sb-sec", "data-github": "" }, h("b", null, "Приложение GitHub флота"), ...body, noteEl("gh"));
    }
    function profilesH(): HTMLElement | null {
      const repos = profileRepos();
      const errs = [...profs].filter(([, p]) => "error" in p) as Array<[string, Err]>;
      if (!repos.size && !errs.length) return null;
      return h(
        "section",
        { class: "sb-sec", "data-profiles": "" },
        h("div", { class: "sb-ph" }, h("b", { style: "flex:1" }, "Репозитории профилей"), h("button", { class: "sb-b", onclick: () => void loadProfiles(true).then(() => app.toast("Профили сведены с репозиториями", "ok")) }, "Синхронизировать")),
        ...[...repos].map(([repo, ms]) =>
          h(
            "div",
            { class: "sb-row", "data-repo": repo },
            h("span", { class: "sb-m" }, repo),
            h("span", null, ms.map((x) => h("span", { class: x.state === "ok" ? "" : "sb-note bad" }, `@${x.m}${x.state === "ok" ? "" : " · " + (x.state === "conflict" ? "конфликт" : "ошибка")} `))),
          ),
        ),
        ...errs.map(([m, e]) => h("div", { class: "sb-note bad" }, `@${m}: machine.profiles: ${e.error}`)),
      );
    }
    function deviceH(): HTMLElement {
      const ps = passes && !("error" in passes) ? passes : [];
      const me = ps.find((p) => p.role === "client" && p.name === app.name);
      const push = app.mark("alerts.state") as string | undefined;
      const pw: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };
      return h(
        "section",
        { class: "sb-sec", "data-device": "" },
        h("b", null, "Это устройство"),
        h("div", { class: "sb-row" }, h("span", null, "адрес"), h("span", { class: "sb-m" }, me?.addr ?? app.name)),
        h(
          "div",
          { class: "sb-row" },
          h("span", null, "пропуск"),
          h("span", null, me ? (me.state === "ok" ? "действует" : me.state === "wait" ? "ждёт приёма" : "отозван") : "—", app.wide ? h("button", { class: "sb-b", style: "margin-left:8px", onclick: () => app.open("settings", { tab: "passes" }) }, "Пропуска") : null),
        ),
        h("div", { class: "sb-row" }, h("span", null, "уведомления"), h("span", { "data-push": push ?? "" }, pw[push ?? ""] ?? "—")),
      );
    }

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const t = tab();
      add(box, h("div", { class: "sb-ph" }, h("h2", null, "Настройки"), tabs()));
      if (t === "releases") add(box, ...releasesH());
      else if (t === "passes")
        add(
          box,
          h("div", { class: "sb-opts" }, inviting || invited ? null : h("button", { class: "sb-b pri", onclick: () => ((inviting = { kind: "device", name: "", person: "" }), redraw()) }, "Пригласить")),
          ...passesH(),
        );
      else if (app.wide) add(box, h("div", { class: "st-two" }, h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ghH(), deviceH()), profilesH() ?? h("span")));
      else add(box, deviceH());
      if (keep) {
        const el2 = box.querySelector<HTMLInputElement>(`[data-f="${keep}"]`);
        el2?.focus();
        el2?.setSelectionRange(el2.value.length, el2.value.length);
      }
    }

    screens.add(draw);
    ghCode = new URLSearchParams(location.search).get("code") ?? "";
    draw();
    const t = tab();
    const want = t === "releases" ? "releases" : t === "general" && app.wide ? "general" : null;
    if (want) open[want]++;
    // при открытии — ответы владельцев своей вкладки
    if (t === "releases") void loadReleases();
    if (t === "passes" || t === "general") void loadPasses();
    if (t === "general" && app.wide) {
      void loadGithub();
      void loadProfiles();
    }
    return {
      head: () => ({ title: "Настройки" }),
      refresh: draw,
      close: () => {
        screens.delete(draw);
        if (want) open[want]--;
      },
    };
  }

  return {
    on: {
      roster(r: Roster) {
        // машина пришла (или вернулась) при открытой вкладке — её keeper и профили; закрытая вкладка спросит сама
        for (const m of r.machines.map((x) => x.machine)) {
          if (open.releases && !kst.has(m)) void loadKeeper(m);
          if (open.general && !profs.has(m) && can(m, "machine.profiles")) void app.request<Profiles>("machine.profiles", { machine: m }).then((x) => (profs.set(m, x.ok ? x.result : { error: x.error }), redraw()));
        }
        redraw();
      },
    },
    screens: {
      settings: {
        nav: "Настройки",
        group: "Флот",
        label: "Настройки",
        mount,
        find: (q: string) =>
          [
            ["releases", "Выпуски"],
            ["passes", "Пропуска"],
            ["general", "GitHub и устройство"],
          ]
            .filter(([, l]) => !q || l.toLowerCase().includes(q))
            .map(([tab, l]) => ({ label: `Настройки: ${l.toLowerCase()}`, hint: "Флот", screen: "settings", params: { tab } })),
      },
    },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
