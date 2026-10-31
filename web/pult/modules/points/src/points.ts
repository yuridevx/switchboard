// pult-points — точки сессий с пометкой «в R2»: обзор реестра, вкладка «Точки» карточки, перенос, копия,
// смена папки, откат и «пожар». Своих данных не хранит: линия, ветки, срок и хозяин — от реестра points,
// подъём и точки — host-points машины. Шаги ведёт страница: каждый запрос — после ответа предыдущего.
import { h, hhmm, plural, type App, type AppModule, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import type { CardTab } from "@switchboard/web-card";
import { machineOf } from "@switchboard/protocol";

type FleetSession = { sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number };
type Fleet = { sessions: FleetSession[]; r2: { bytes: number; blocks: number }; sweep: { at: number; blocks: number; bytes: number } | null };
type Git = { state?: string; files?: number; branch?: string };
type LPoint = { id: number; at: number; machine: string; why: string; base: number | null; callsign?: string; dir?: string; msgs?: number; bytes?: number; git?: Git; line: boolean; until: number | null };
type Line = { owner: string | null; head: number | null; points: LPoint[] };
type Full = { id: number; last?: unknown[] };
type Check = { folder: string; files?: number; branch?: string | null; sessions?: string[] };
type Dlg = {
  kind: "move" | "copy" | "dir" | "rb";
  target: string;
  from: "fresh" | number;
  slot: string;
  slots: string[] | null;
  dir: string;
  name: string;
  files: "point" | "keep";
  interrupt: boolean;
  check: Check | { error: string } | null;
  phase: "" | "run" | "done" | "err";
  msg: string;
};

const CSS = `
.pt-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;border-top:1px solid var(--line2);padding-top:7px;font-size:13px}
.pt-row b{font:600 13px var(--mono)}
.pt-day{font:600 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding-top:6px}
.pt-pt{display:grid;grid-template-columns:52px 14px minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:8px;padding:5px 6px;font-size:13px}
.pt-pt:hover{border-color:var(--line)}
.pt-pt[aria-pressed="true"]{background:var(--accent-weak)}
.pt-pt i{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.pt-pt.br{padding-left:26px}
.pt-pt.br i{background:transparent;border:2px solid var(--wait)}
.pt-pt span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pt-pt em{font:600 12px var(--mono);font-style:normal;color:var(--muted)}
`;

const r2Of = (s: SessionRecord | undefined) => s?.r2 as { error?: string; at?: number } | undefined;
const nameOf = (callsign: string) => callsign.split("@")[0];
const mb = (b: number) => `${Math.round(b / 1048576)} МБ`;
const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr} ч ${m % 60} мин назад` : day(t);
}
/** Слова отказа host-points и points → строка на экране. */
function say(w: string, cs = "", target = "", src = ""): string {
  const t: Record<string, string> = {
    waiting: `${cs || "Сессия"} ждёт ответа человека — после ответа или с «прервать»`,
    bad_dir: "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»",
    bad_point: "Точка не открылась — причина в журнале машины",
    not_owner: "Сессию уже подняли на другой машине",
    open_failed: target ? `Не поднялась на ${target}${src && src !== target ? ` — снова идёт на ${src}` : ""}` : "Не поднялась",
    not_r2: "Сессия не в R2",
    running: "Сессия ещё идёт — сначала точка со стопом",
    name_taken: "Имя занято на этой машине",
    offline: "Машины нет на связи",
  };
  return t[w] ?? w;
}
/** Что будет с папкой на целевой машине — ответ points.raise с dryRun. */
function folderText(c: Check, m: string): string {
  switch (c.folder) {
    case "same":
      return "тот же репозиторий, своих правок нет — правки точки применятся";
    case "dirty":
      return `тот же репозиторий, но в нём свои правки (${c.files ?? "?"} ${plural(c.files ?? 0, "файл", "файла", "файлов")}): правки точки НЕ применятся, ваши файлы останутся`;
    case "empty":
      return `нет на ${m} — будет клон репозитория и правки точки поверх`;
    case "shared":
      return `здесь же ${(c.sessions ?? []).join(", ")} — в этой папке будут ${(c.sessions?.length ?? 0) + 1} сессии`;
    case "nogit":
      return "в точке нет git — файлы останутся как есть";
    case "other":
      return "Другой репозиторий — выберите другую папку";
    default:
      return c.folder;
  }
}

/** Новый модуль со своей памятью; tab — вкладка «Точки» для карточки сессии. */
export function createPoints(): AppModule & { tab: CardTab } {
  let app: App;
  let fleet: Fleet | null = null;
  const lines = new Map<string, Line>();
  const full = new Map<number, Full>();
  const left = new Map<string, number>();
  const screens = new Set<() => void>();
  const redraw = () => {
    screens.forEach((d) => d());
    app.changed();
  };

  const can = (m: string, n: string) => app.provides(m)?.[n] !== undefined;
  const online = () => new Set((app.roster()?.machines ?? []).map((m) => m.machine));
  const live = () => new Set((app.roster()?.sessions ?? []).map((s) => s.callsign));
  const raisers = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.["points.raise"] !== undefined).map((m) => m.machine);

  async function loadFleet() {
    const r = await app.request<Fleet>("points.list", {});
    if (r.ok) fleet = r.result;
    // «пожар»: машины хозяина нет в roster — когда ушла, скажет журнал флота
    const on = online();
    const fire = new Set((fleet?.sessions ?? []).filter((s) => !on.has(s.owner)).map((s) => s.owner));
    await Promise.all(
      [...fire].map(async (m) => {
        const j = await app.request<{ events: Array<{ t: number; ev: string }> }>("ledger.read", { machine: m, limit: 1 });
        const e = j.ok ? j.result.events.find((x) => x.ev === "machine.left") : undefined;
        if (e) left.set(m, e.t);
      }),
    );
    redraw();
  }

  async function slotsOf(m: string): Promise<string[]> {
    if (!can(m, "machine.slots")) return [];
    const r = await app.request<{ slots: Record<string, unknown> }>("machine.slots", { machine: m });
    return r.ok ? Object.keys(r.result.slots ?? {}) : [];
  }

  async function dry(m: string, sid: string, point: number, dir: string): Promise<Check | { error: string }> {
    const r = await app.request<Check>("points.raise", { machine: m, sid, point, dir, files: "point", dryRun: true });
    return r.ok ? r.result : { error: r.error };
  }

  const checkLine = (d: Dlg) =>
    d.check
      ? "error" in d.check
        ? h("div", { class: "sb-note bad", "data-check": "error" }, say(d.check.error))
        : h("div", { class: `sb-note ${d.check.folder === "other" ? "bad" : d.check.folder === "dirty" ? "wait" : "ok"}`, "data-check": d.check.folder }, folderText(d.check, d.target))
      : null;

  // ───── обзор ─────
  function mountOverview(el: HTMLElement): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let q = "";
    let del: { sid: string; name: string; typed: string } | null = null;
    let done = "";
    let fire: { from: string; target: string; rows: Array<{ s: FleetSession; dir: string; slot: string; check: Check | { error: string } | null; st: string }>; slots: string[]; run: boolean; k: number } | null = null;
    let move: { s: FleetSession } & Dlg | null = null;

    async function save(callsign: string) {
      const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
      app.toast(r.ok ? `${callsign}: точка №${r.result.point}${r.result.same ? " — та же" : ""}` : `${callsign}: ${say(r.error, callsign)}`, r.ok ? "ok" : "bad");
      if (r.ok) await loadFleet();
    }

    async function remove() {
      if (!del) return;
      const d = del;
      const r = await app.request<{ points: number }>("points.delete", { sid: d.sid });
      if (!r.ok) {
        done = `points.delete: ${r.error}`;
        return draw();
      }
      del = null;
      done = `${d.name} удалена — ${r.result.points} ${plural(r.result.points, "точка", "точки", "точек")}`;
      if (fleet) fleet.sessions = fleet.sessions.filter((s) => s.sid !== d.sid);
      draw();
      void loadFleet();
    }

    async function openFire(from: string) {
      const target = raisers()[0] ?? "";
      const rows = (fleet?.sessions ?? []).filter((s) => s.owner === from).map((s) => ({ s, dir: s.dir ?? "~", slot: "", check: null, st: "" }));
      fire = { from, target, rows, slots: [], run: false, k: 0 };
      draw();
      await fireTarget(target);
    }
    async function fireTarget(target: string) {
      if (!fire) return;
      fire.target = target;
      fire.slots = await slotsOf(target);
      for (const r of fire.rows) r.slot = fire.slots[0] ?? "";
      draw();
      await Promise.all(fire.rows.map(async (r) => (r.check = await dry(target, r.s.sid, r.s.head.id, r.dir))));
      draw();
    }
    /** Перенос сессий пропавшей машины: по одной, следующая — после ответа на предыдущую; points.save не шлётся. */
    async function runFire() {
      if (!fire) return;
      const f = fire;
      f.run = true;
      for (const r of f.rows) {
        r.st = "поднимается…";
        draw();
        const x = await app.request<{ callsign: string }>("points.raise", { machine: f.target, sid: r.s.sid, point: r.s.head.id, dir: r.dir, ...(r.slot ? { slot: r.slot } : {}), files: "point" });
        r.st = x.ok ? `готова — ${x.result.callsign}` : x.error === "not_owner" ? "уже подняли на другой машине" : `не поднялась: ${say(x.error)}`;
        if (x.ok) f.k++;
        draw();
      }
      void loadFleet();
    }

    async function runMove() {
      if (!move) return;
      const d = move;
      d.phase = "run";
      d.msg = `${d.target} поднимает сессию из точки…`;
      draw();
      const x = await app.request<{ callsign: string }>("points.raise", { machine: d.target, sid: d.s.sid, point: d.s.head.id, dir: d.dir, ...(d.slot ? { slot: d.slot } : {}), files: "point" });
      d.phase = x.ok ? "done" : "err";
      d.msg = x.ok ? `${nameOf(d.s.callsign ?? "")} поднята: ${x.result.callsign}` : say(x.error, "", d.target);
      draw();
      if (x.ok) void loadFleet();
    }
    async function openMove(s: FleetSession) {
      const target = raisers()[0] ?? "";
      move = { s, kind: "move", target, from: s.head.id, slot: "", slots: null, dir: s.dir ?? "~", name: "", files: "point", interrupt: false, check: null, phase: "", msg: "" };
      draw();
      await moveTarget(target);
    }
    async function moveTarget(target: string) {
      if (!move) return;
      move.target = target;
      move.slots = await slotsOf(target);
      move.slot = move.slots[0] ?? "";
      move.check = await dry(target, move.s.sid, move.s.head.id, move.dir);
      draw();
    }

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      box.append(h("div", { class: "sb-ph" }, h("h2", null, "Точки"), h("span", { class: "sb-note" }, "сохранённые состояния сессий — из них сессию поднимают на любой машине")));
      if (!fleet) {
        box.append(h("div", { class: "sb-note" }, "…"));
        return;
      }
      const on = online();
      const lv = live();
      const fires = new Map<string, FleetSession[]>();
      const only: FleetSession[] = [];
      const inR2: FleetSession[] = [];
      for (const s of fleet.sessions) {
        if (!on.has(s.owner)) fires.set(s.owner, [...(fires.get(s.owner) ?? []), s]);
        else if (s.callsign && lv.has(s.callsign)) inR2.push(s);
        else only.push(s);
      }
      for (const [m, list] of fires) {
        const t = left.get(m);
        box.append(
          h(
            "section",
            { class: "sb-sec bad", "data-fire": m },
            h("b", null, `${m} не на связи${t ? ` с ${hhmm(t)}` : ""} · ${list.length} ${plural(list.length, "сессия ждёт", "сессии ждут", "сессий ждут")} на последних точках`),
            h("span", { class: "sb-note" }, `Что ${m} допишет после точек, вернётся веткой, если он появится.`),
            !fire && raisers().length ? h("div", { class: "sb-opts" }, h("button", { class: "sb-b pri", onclick: () => void openFire(m) }, "Перенести на другую машину…")) : null,
          ),
        );
      }
      if (fire) box.append(drawFire());
      const total = app.roster()?.sessions.length ?? 0;
      box.append(
        h(
          "div",
          { class: "sb-opts", "data-summary": "" },
          h("b", null, `${inR2.length} ${plural(inR2.length, "сессия", "сессии", "сессий")} в R2 из ${total} на машинах`),
          ...[...fires].map(([m, l]) => h("span", { class: "sb-note bad" }, `· ${l.length} на ${m} — нет связи`)),
          h("span", { class: "sb-note" }, `· ${only.length} только в R2`),
        ),
      );
      inR2.sort((a, b) => a.head.at - b.head.at);
      box.append(
        h(
          "section",
          { class: "sb-sec" },
          h("h4", { class: "sb-h4" }, "Последняя точка — давнее всех сверху"),
          inR2.map((s) =>
            h(
              "div",
              { class: "pt-row", "data-sid": s.sid },
              h("span", null, h("b", null, s.callsign), ` ${ago(s.head.at)} · №${s.head.id}`),
              can(s.owner, "points.save") ? h("button", { class: "sb-b", onclick: () => void save(s.callsign!) }, "Сохранить сейчас") : null,
            ),
          ),
          inR2.length ? null : h("div", { class: "sb-note" }, "Сессий в R2 на связи нет."),
        ),
      );
      const outside = (app.roster()?.sessions ?? []).filter((s) => !r2Of(s)).map((s) => s.callsign);
      if (outside.length) box.append(h("div", { class: "sb-note" }, `${outside.join(", ")} не в R2 — точек и переноса у них нет; включить — вкладка «Точки» сессии.`));
      const qi = h("input", { class: "sb-in", "data-f": "q", placeholder: "⌕ имя, папка или месяц…", value: q }) as HTMLInputElement;
      qi.addEventListener("input", () => ((q = qi.value), draw()));
      const shown = only.filter((s) => !q || [s.callsign, s.dir, day(s.head.at)].some((x) => x?.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => b.head.at - a.head.at);
      box.append(
        h(
          "section",
          { class: "sb-sec", "data-only": "" },
          h("div", { class: "sb-ph" }, h("h4", { class: "sb-h4" }, `Только в R2 · ${only.length}`), qi),
          shown.map((s) => {
            const name = nameOf(s.callsign ?? s.sid);
            const typed = del?.sid === s.sid ? del.typed : "";
            const inp = h("input", { class: "sb-in m", "data-f": `del:${s.sid}`, placeholder: name, value: typed }) as HTMLInputElement;
            inp.addEventListener("input", () => {
              if (del) del.typed = inp.value;
              draw();
            });
            return h(
              "div",
              { class: "pt-row", "data-sid": s.sid },
              h("span", null, h("b", null, name), ` ${s.dir ?? ""} · последняя точка ${day(s.head.at)}`),
              h(
                "span",
                { class: "sb-opts" },
                h("button", { class: "sb-b bad", onclick: () => ((del = { sid: s.sid, name, typed: "" }), (done = ""), draw()) }, "Удалить…"),
                raisers().length ? h("button", { class: "sb-b", onclick: () => void openMove(s) }, "Перенести на машину…") : null,
              ),
              del?.sid === s.sid
                ? h(
                    "div",
                    { class: "sb-sec dlg", "data-dlg": "delete" },
                    h("b", null, `Удалить точки «${name}» насовсем`),
                    h("span", { class: "sb-note" }, "Строки точек и блоки без ссылок уйдут из R2 сразу, в том же запросе; блоки, нужные копиям, останутся. Отменить нельзя — отмены у удаления нет."),
                    h("div", { class: "sb-opts" }, h("span", null, `Введите имя сессии: ${name}`), inp),
                    h(
                      "div",
                      { class: "sb-opts" },
                      h("button", { class: "sb-b", onclick: () => ((del = null), draw()) }, "Отмена"),
                      h("button", { class: "sb-b bad", "data-act": "delete", disabled: typed !== name, onclick: () => void remove() }, "Удалить насовсем"),
                    ),
                  )
                : null,
              move?.s.sid === s.sid ? drawMove() : null,
            );
          }),
          done ? h("div", { class: "sb-sec ok", role: "status" }, h("b", null, done), h("span", { class: "sb-note" }, "Запись — в «Журнале флота».")) : null,
        ),
      );
      box.append(
        h(
          "div",
          { class: "sb-note" },
          `В R2 ${mb(fleet.r2.bytes)}`,
          fleet.sweep ? ` · уборка ${day(fleet.sweep.at)} ${hhmm(fleet.sweep.at)} — удалено ${fleet.sweep.blocks} блоков, ${mb(fleet.sweep.bytes)}` : "",
        ),
      );
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLInputElement | null)?.focus();
    }

    function drawFire(): HTMLElement {
      const f = fire!;
      const ms = raisers();
      const ready = f.rows.every((r) => r.check && !("error" in r.check) && r.check.folder !== "other");
      return h(
        "section",
        { class: "sb-sec dlg", "data-dlg": "fire" },
        h("h4", { class: "sb-h4" }, `Перенести сессии ${f.from} на другую машину`),
        f.run
          ? h("div", { class: f.k === f.rows.length ? "sb-sec ok" : "sb-sec wait", role: "status", "data-progress": `${f.k}/${f.rows.length}` }, h("b", null, `Перенос с ${f.from} на ${f.target}: ${f.k} из ${f.rows.length} готовы${f.k < f.rows.length && f.rows.some((r) => !r.st || r.st.endsWith("…")) ? " — не закрывайте страницу" : ""}`))
          : h("div", { class: "sb-row" }, h("span", null, "Куда"), h("div", { class: "sb-opts" }, ms.map((m) => h("button", { class: "sb-b", "aria-pressed": m === f.target ? "true" : "false", onclick: () => void fireTarget(m) }, m)))),
        f.rows.map((r) =>
          h(
            "div",
            { class: "sb-sec", "data-row": nameOf(r.s.callsign ?? r.s.sid) },
            h("b", null, nameOf(r.s.callsign ?? r.s.sid)),
            h("span", { class: "sb-note" }, `точка ${hhmm(r.s.head.at)} · №${r.s.head.id}`),
            f.run ? h("span", { class: "sb-note" }, r.st) : h("div", { class: "sb-opts" }, h("span", { class: "sb-note" }, `Слот на ${f.target}: ${r.slot || "без слота"}`), h("span", { class: "sb-m" }, r.dir)),
            f.run ? null : r.check ? ("error" in r.check ? h("div", { class: "sb-note bad" }, say(r.check.error)) : h("div", { class: "sb-note" }, folderText(r.check, f.target))) : h("div", { class: "sb-note" }, "проверяю папку…"),
          ),
        ),
        h("span", { class: "sb-note" }, "Каждая поднимется из своей последней точки, по одной, пока страница открыта. Закроете — оставшиеся ждут на точках, плашка останется."),
        f.run
          ? h("div", { class: "sb-opts" }, h("button", { class: "sb-b", onclick: () => ((fire = null), draw()) }, "Закрыть"))
          : h(
              "div",
              { class: "sb-opts" },
              h("button", { class: "sb-b", onclick: () => ((fire = null), draw()) }, "Отмена"),
              h("button", { class: "sb-b pri", disabled: !ready || !f.target, onclick: () => void runFire() }, `Перенести ${f.rows.length} из ${f.rows.length} на ${f.target}`),
            ),
      );
    }

    function drawMove(): HTMLElement {
      const d = move!;
      return h(
        "div",
        { class: "sb-sec dlg", "data-dlg": "raise" },
        h("b", null, `Поднять ${nameOf(d.s.callsign ?? "")} из точки №${d.s.head.id}`),
        h("div", { class: "sb-row" }, h("span", null, "Машина"), h("div", { class: "sb-opts" }, raisers().map((m) => h("button", { class: "sb-b", "aria-pressed": m === d.target ? "true" : "false", onclick: () => void moveTarget(m) }, m)))),
        h("div", { class: "sb-row" }, h("span", null, "Слот"), h("span", null, d.slot || "без слота")),
        h("div", { class: "sb-row" }, h("span", null, "Папка"), h("span", { class: "sb-m" }, d.dir)),
        checkLine(d),
        d.msg ? h("div", { class: `sb-note ${d.phase === "err" ? "bad" : d.phase === "done" ? "ok" : ""}`, role: "status" }, d.msg) : null,
        h(
          "div",
          { class: "sb-opts" },
          h("button", { class: "sb-b", onclick: () => ((move = null), draw()) }, d.phase === "done" ? "Закрыть" : "Отмена"),
          d.phase !== "done" ? h("button", { class: "sb-b pri", disabled: d.phase === "run" || !d.check || "error" in d.check || d.check.folder === "other", onclick: () => void runMove() }, `Поднять на ${d.target}`) : null,
        ),
      );
    }

    screens.add(draw);
    draw();
    void loadFleet();
    return { head: () => ({ title: "Точки" }), refresh: draw, close: () => screens.delete(draw) };
  }

  // ───── вкладка «Точки» сессии ─────
  function mountSession(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    const callsign = params.callsign ?? "";
    const machine = machineOf(callsign) ?? "";
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let sid = "";
    let note = { text: "", tone: "" };
    let picked: number | null = null;
    let unmark: string | null = null;
    let dlg: Dlg | null = null;
    let loaded = false;
    let wasR2 = !!r2Of(session());

    function session() {
      return app.roster()?.sessions.find((s) => s.callsign === callsign);
    }
    const line = () => (sid ? lines.get(sid) : undefined);
    const dirOf = () => line()?.points.find((p) => p.id === line()?.head)?.dir ?? fleet?.sessions.find((s) => s.sid === sid)?.dir ?? "~";

    async function load() {
      loaded = true;
      if (!fleet?.sessions.some((s) => s.callsign === callsign)) await loadFleet();
      sid = fleet?.sessions.find((s) => s.callsign === callsign)?.sid ?? "";
      if (!sid) return draw();
      const r = await app.request<Line>("points.list", { sid });
      if (r.ok) lines.set(sid, r.result);
      // первые слова — поле last точек на экране; машина для этого не нужна
      const ids = (r.ok ? r.result.points : []).slice(0, 12).map((p) => p.id).filter((id) => !full.has(id));
      if (ids.length) {
        const g = await app.request<{ points: Full[] }>("points.get", { ids });
        if (g.ok) for (const p of g.result.points) full.set(p.id, p);
      }
      draw();
    }

    async function mark(on: boolean) {
      note = { text: on ? "Включаю…" : "Удаляю точки…", tone: "" };
      draw();
      const r = await app.request<{ point?: number; deleted?: number }>("session.r2", { callsign, on });
      if (!r.ok) note = { text: say(r.error, callsign), tone: "bad" };
      else if (on) note = { text: `Первая точка — №${r.result.point}, только что; дальше Host кладёт их сам.`, tone: "ok" };
      else {
        unmark = null;
        if (sid) lines.delete(sid);
        sid = "";
        note = { text: `${r.result.deleted ?? 0} ${plural(r.result.deleted ?? 0, "точка удалена", "точки удалено", "точек удалено")} из R2 — сразу, без отмены. Сессия на ${machine} работает дальше, без точек.`, tone: "ok" };
      }
      draw();
    }

    async function saveNow() {
      note = { text: "Сохраняю точку…", tone: "" };
      draw();
      const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
      note = r.ok ? { text: `Точка №${r.result.point}${r.result.same ? " — та же, файлы не менялись" : ""}`, tone: "ok" } : { text: say(r.error, callsign), tone: "bad" };
      if (r.ok) await load();
      else draw();
    }

    async function open(kind: Dlg["kind"], from: "fresh" | number = "fresh") {
      const name = nameOf(callsign);
      const target = kind === "dir" || kind === "rb" ? machine : (raisers().find((m) => m !== machine) ?? machine);
      dlg = {
        kind,
        target,
        from,
        slot: "",
        slots: null,
        dir: kind === "copy" ? `${dirOf()}-copy` : kind === "dir" ? `${dirOf()}-v2` : dirOf(),
        name: kind === "copy" ? `${name}-copy` : kind === "dir" ? `${name}-v2` : name,
        files: kind === "dir" || kind === "rb" ? "keep" : "point",
        interrupt: false,
        check: null,
        phase: "",
        msg: "",
      };
      draw();
      if (kind === "move" || kind === "copy") await target_(target);
    }
    async function target_(m: string) {
      if (!dlg) return;
      dlg.target = m;
      dlg.slots = await slotsOf(m);
      dlg.slot = dlg.slots.includes(String((session()?.slot as { name?: string } | undefined)?.name)) ? String((session()?.slot as { name?: string }).name) : (dlg.slots[0] ?? "");
      await check();
    }
    async function check() {
      if (!dlg || (dlg.kind !== "move" && dlg.kind !== "copy")) return draw();
      const head = line()?.head;
      const point = dlg.from === "fresh" ? head : dlg.from;
      dlg.check = typeof point === "number" ? await dry(dlg.target, sid, point, dlg.dir) : { error: "bad_point" };
      draw();
    }

    /** Шаги диалога: точка (со стопом, кроме копии), затем подъём; смена папки — ещё «Забыть» прежнюю. */
    async function run() {
      if (!dlg) return;
      const d = dlg;
      const step = (msg: string) => {
        d.phase = "run";
        d.msg = msg;
        draw();
      };
      const fail = (w: string) => {
        d.phase = "err";
        d.msg = d.kind === "dir" && w === "open_failed" ? `Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной` : say(w, nameOf(callsign), d.target, machine);
        draw();
      };
      let point = typeof d.from === "number" ? d.from : 0;
      const stop = d.kind !== "copy";
      if (stop || d.from === "fresh") {
        step(stop ? `${machine} дожидается конца ответа, останавливает сессию и кладёт точку…` : `${machine} кладёт свежую точку…`);
        const s = await app.request<{ point: number; same: boolean }>("points.save", { callsign, ...(stop ? { stop: true } : {}), ...(d.interrupt ? { interrupt: true } : {}) });
        if (!s.ok) return fail(s.error);
        if (d.from === "fresh") point = s.result.point;
      }
      step(`${d.target} поднимает сессию из точки №${point}…`);
      const body: Record<string, unknown> = { machine: d.target, sid, point, dir: d.dir, files: d.files };
      if (d.kind === "copy" || d.kind === "dir") Object.assign(body, { copy: true, name: d.name });
      if (d.slot && (d.kind === "move" || d.kind === "copy")) body.slot = d.slot;
      const r = await app.request<{ callsign: string; point: number; folder: string; branch: string | null }>("points.raise", body);
      if (!r.ok) return fail(r.error);
      if (d.kind === "dir") {
        step(`«Забыть» ${callsign}…`);
        const rm = await app.request("session.remove", { callsign });
        if (!rm.ok) return fail(rm.error);
      }
      d.phase = "done";
      d.msg =
        d.kind === "move"
          ? `${nameOf(callsign)} перенесена на ${d.target}: ${r.result.callsign}. ${machine} её отпустил.`
          : d.kind === "copy"
            ? `Копия поднята: ${r.result.callsign}. Исходная сессия не менялась.`
            : d.kind === "dir"
              ? `Копия в новой папке: ${r.result.callsign}; ${callsign} забыта, её точки остались в R2.`
              : `Откат: ${callsign} поднята из точки №${point}; нынешнее — веткой «до отката»${r.result.branch ? `, папка на ветке git ${r.result.branch}` : ""}. Новая ссылка claude.ai придёт в roster.`;
      draw();
      void load();
    }

    function drawDlg(d: Dlg): HTMLElement {
      const titles = { move: `Перенести ${callsign}`, copy: `Скопировать ${callsign}`, dir: `Сменить папку ${callsign}`, rb: `Откатить ${callsign} к ${typeof d.from === "number" ? `точке №${d.from}` : "точке"}` };
      const dirIn = h("input", { class: "sb-in m", "data-f": "dir", value: d.dir }) as HTMLInputElement;
      dirIn.addEventListener("change", () => ((d.dir = dirIn.value), void check()));
      dirIn.addEventListener("input", () => (d.dir = dirIn.value));
      const nameIn = h("input", { class: "sb-in m", "data-f": "name", value: d.name }) as HTMLInputElement;
      nameIn.addEventListener("input", () => (d.name = nameIn.value));
      const busy = d.phase === "run";
      const blocked = (d.kind === "move" || d.kind === "copy") && (!d.check || "error" in d.check || d.check.folder === "other");
      const head = line()?.head;
      const label = { move: `Перенести на ${d.target}`, copy: `Скопировать на ${d.target}`, dir: "Скопировать и забыть", rb: `Откатить к ${typeof d.from === "number" ? `№${d.from}` : "точке"}` }[d.kind];
      return h(
        "section",
        { class: "sb-sec dlg", "data-dlg": d.kind },
        h("h4", { class: "sb-h4" }, titles[d.kind]),
        d.kind === "move" || d.kind === "copy"
          ? h("div", { class: "sb-row" }, h("span", null, "Машина"), h("div", { class: "sb-opts" }, raisers().map((m) => h("button", { class: "sb-b", "aria-pressed": m === d.target ? "true" : "false", disabled: busy, onclick: () => void target_(m) }, m))))
          : h("div", { class: "sb-row" }, h("span", null, "Машина"), h("span", null, `${machine} — та же`)),
        d.kind === "move" || d.kind === "copy"
          ? h(
              "div",
              { class: "sb-row" },
              h("span", null, "Из точки"),
              h(
                "div",
                { class: "sb-opts" },
                h("button", { class: "sb-b", "aria-pressed": d.from === "fresh" ? "true" : "false", onclick: () => ((d.from = "fresh"), void check()) }, "сейчас — сохранится свежая"),
                typeof d.from === "number" ? h("button", { class: "sb-b", "aria-pressed": "true" }, `№${d.from}`) : null,
              ),
            )
          : null,
        (d.kind === "move" || d.kind === "copy") && d.slots
          ? h("div", { class: "sb-row" }, h("span", null, `Слот на ${d.target}`), h("div", { class: "sb-opts" }, [...d.slots, ""].map((x) => h("button", { class: "sb-b", "aria-pressed": d.slot === x ? "true" : "false", onclick: () => ((d.slot = x), draw()) }, x || "без слота"))))
          : null,
        d.kind !== "rb" ? h("div", { class: "sb-row" }, h("span", null, d.kind === "dir" ? "Новая папка" : `Папка на ${d.target}`), dirIn) : h("div", { class: "sb-row" }, h("span", null, "Папка"), h("span", { class: "sb-m" }, dirOf())),
        d.kind === "copy" || d.kind === "dir" ? h("div", { class: "sb-row" }, h("span", null, d.kind === "copy" ? "Имя копии" : "Имя"), h("div", { class: "sb-opts" }, nameIn, h("span", { class: "sb-note" }, `→ ${d.name}@${d.target}`))) : null,
        checkLine(d),
        d.kind === "dir" ? h("span", { class: "sb-note" }, "папка — как есть: правки точки не применяются. Папку живой сессии не меняют: claude держит её с запуска. Не поднялась копия — «Забыть» не шлётся.") : null,
        d.kind === "rb"
          ? h(
              "div",
              { class: "sb-opts" },
              h("button", { class: "sb-b", "aria-pressed": d.files === "keep" ? "true" : "false", onclick: () => ((d.files = "keep"), draw()) }, "Оставить как есть"),
              h("button", { class: "sb-b", "aria-pressed": d.files === "point" ? "true" : "false", onclick: () => ((d.files = "point"), draw()) }, "Вернуть к папке точки"),
            )
          : null,
        d.kind === "rb" ? h("span", { class: "sb-note" }, "Нынешнее сначала сохранится веткой «до отката» — из неё можно скопировать или продолжить ею.") : null,
        d.kind === "rb" && (session()?.remote as { url?: string } | undefined)?.url
          ? h("div", { class: "sb-sec wait", "data-remote": "" }, h("b", null, "Привязка к claude.ai снимется"), h("span", { class: "sb-note" }, "После отката в claude.ai — новая сессия без прежней истории, кнопка «В claude.ai» поведёт на неё. Прежняя сессия в claude.ai останется как была."))
          : null,
        d.kind !== "copy"
          ? h("label", { class: "sb-opts" }, h("input", { type: "checkbox", checked: d.interrupt, onchange: (e: Event) => (d.interrupt = (e.target as HTMLInputElement).checked) }), d.kind === "rb" ? "прервать идущий ответ и откатить сразу (иначе — после конца ответа)" : "прервать ответ и сделать сразу")
          : null,
        d.kind === "move" ? h("span", { class: "sb-note" }, `Сначала ${machine} остановит сессию и снимет точку, потом ${d.target} поднимет её. Сорвётся подъём — сессия снова пойдёт на ${machine}.`) : null,
        d.kind === "copy" ? h("span", { class: "sb-note" }, "Исходная сессия не меняется. У копии своё имя и своя сессия в claude.ai.") : null,
        d.msg ? h("div", { class: `sb-note ${d.phase === "err" ? "bad" : d.phase === "done" ? "ok" : "wait"}`, role: "status", "data-phase": d.phase }, d.msg) : null,
        h(
          "div",
          { class: "sb-opts" },
          h("button", { class: "sb-b", onclick: () => ((dlg = null), draw()) }, d.phase === "done" ? "Закрыть" : "Отмена"),
          d.phase !== "done" ? h("button", { class: "sb-b pri", "data-act": "run", disabled: busy || blocked || typeof head !== "number", onclick: () => void run() }, label) : null,
        ),
      );
    }

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const s = session();
      const r2 = r2Of(s);
      const noteEl = note.text ? h("div", { class: `sb-note ${note.tone}`, role: "status", "data-note": "" }, note.text) : null;
      if (!r2) {
        box.append(
          h(
            "section",
            { class: "sb-sec", "data-r2": "off" },
            h("b", null, `${callsign} не в R2`),
            h("span", { class: "sb-note" }, "Точек нет: перенос, копия, откат, смена папки и «пожар» — только у сессий в R2."),
            can(machine, "session.r2") ? h("label", { class: "sb-opts" }, h("input", { type: "checkbox", "data-act": "r2", onchange: () => void mark(true) }), "Хранить в R2") : null,
            h("span", { class: "sb-note" }, "Включите — Host сразу положит первую точку."),
            noteEl,
          ),
        );
        return;
      }
      const ln = line();
      const head = ln?.points.find((p) => p.id === ln.head);
      const name = nameOf(callsign);
      const typed = h("input", { class: "sb-in m", "data-f": "unmark", placeholder: name, value: unmark ?? "" }) as HTMLInputElement;
      typed.addEventListener("input", () => ((unmark = typed.value), draw()));
      box.append(
        h(
          "section",
          { class: "sb-sec", "data-r2": "on" },
          h(
            "div",
            { class: "sb-ph" },
            h("b", null, head ? `Точка ${ago(head.at)} · №${head.id}${head.bytes ? ` · ${(head.bytes / 1048576).toFixed(1).replace(".", ",")} МБ` : ""}` : sid ? "…" : "Точек ещё нет"),
            can(machine, "points.save") ? h("button", { class: "sb-b", onclick: () => void saveNow() }, "Сохранить точку") : null,
            can(machine, "points.raise") || raisers().length ? h("button", { class: "sb-b", disabled: !head, onclick: () => void open("move") }, "Перенести…") : null,
            raisers().length ? h("button", { class: "sb-b", disabled: !head, onclick: () => void open("copy") }, "Скопировать…") : null,
            can(machine, "points.raise") ? h("button", { class: "sb-b", disabled: !head, "data-act": "dir", onclick: () => void open("dir") }, "Сменить папку…") : null,
          ),
          h("span", { class: "sb-note" }, "сохраняются сами: в разговоре новое и ответ кончился — Host кладёт точку сам"),
          r2.error ? h("div", { class: "sb-note bad" }, `последняя точка не удалась: ${r2.error}`) : null,
          noteEl,
        ),
      );
      if (dlg) box.append(drawDlg(dlg));
      if (ln) {
        const pts = [...ln.points].sort((a, b) => b.at - a.at);
        const list = h("section", { class: "sb-sec", "data-points": "" }, h("h4", { class: "sb-h4" }, "Линия и ветки"));
        let lastDay = "";
        for (const p of pts) {
          const d = day(p.at);
          if (d !== lastDay) list.append(h("div", { class: "pt-day" }, d));
          lastDay = d;
          const last = full.get(p.id)?.last?.[0] as unknown[] | undefined;
          const words = typeof last?.[0] === "string" ? `«${last[0]}»` : p.why;
          list.append(
            h(
              "button",
              { class: "pt-pt" + (p.line ? "" : " br"), "aria-pressed": picked === p.id ? "true" : "false", "data-point": p.id, onclick: () => ((picked = picked === p.id ? null : p.id), draw()) },
              h("span", null, hhmm(p.at)),
              h("i"),
              h("span", null, words),
              h("em", null, p.line ? `№${p.id}` : `ветка · №${p.id}`),
            ),
          );
          if (picked === p.id) list.append(pointCard(p, ln));
        }
        box.append(list);
      }
      box.append(
        h(
          "section",
          { class: "sb-sec" },
          h("label", { class: "sb-opts" }, h("input", { type: "checkbox", checked: unmark === null, "data-act": "r2", onchange: () => ((unmark = unmark === null ? "" : null), draw()) }), "Хранить в R2"),
          h("span", { class: "sb-note" }, "Снять — точки сессии удалятся из R2 сразу, без отмены."),
          unmark !== null
            ? h(
                "div",
                { class: "sb-sec dlg", "data-dlg": "unmark" },
                h("b", null, `Убрать ${callsign} из R2`),
                h("span", { class: "sb-note" }, `Точки и ветки сессии удалятся из R2 сразу; отменить нельзя. Сессия на ${machine} продолжит работу — без точек и переноса.`),
                h("div", { class: "sb-opts" }, h("span", null, `Введите имя сессии: ${name}`), typed),
                h(
                  "div",
                  { class: "sb-opts" },
                  h("button", { class: "sb-b", onclick: () => ((unmark = null), draw()) }, "Отмена"),
                  h("button", { class: "sb-b bad", "data-act": "unmark", disabled: unmark !== name, onclick: () => void mark(false) }, "Убрать из R2"),
                ),
              )
            : null,
        ),
      );
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLInputElement | null)?.focus();
    }

    function pointCard(p: LPoint, ln: Line): HTMLElement {
      const last = (full.get(p.id)?.last ?? []) as unknown[][];
      return h(
        "div",
        { class: "sb-sec", "data-card": p.id },
        h("div", { class: "sb-row" }, h("span", null, "когда"), h("span", null, `${day(p.at)} ${hhmm(p.at)} · №${p.id}${p.id === ln.head ? " · последняя" : ""}`)),
        h("div", { class: "sb-row" }, h("span", null, "почему"), h("span", null, p.why)),
        p.msgs !== undefined ? h("div", { class: "sb-row" }, h("span", null, "разговор"), h("span", null, `${p.msgs} ${plural(p.msgs, "сообщение", "сообщения", "сообщений")}`)) : null,
        h("div", { class: "sb-row" }, h("span", null, "с машины"), h("span", null, p.machine)),
        p.git ? h("div", { class: "sb-row" }, h("span", null, "папка"), h("span", null, `git: ${p.git.state === "dirty" ? `${p.git.files} файла не закоммичено` : "чисто"}${p.git.branch ? ` · ${p.git.branch}` : ""}`)) : null,
        h("div", { class: "sb-row" }, h("span", null, "срок"), h("span", null, p.until ? `хранится до ${day(p.until)} ${new Date(p.until).getFullYear()}` : "хранится, пока есть сессия")),
        last.length ? h("div", { class: "sb-note" }, last.map((x) => x.filter((y) => typeof y === "string").join(" → ")).join(" · ")) : null,
        h(
          "div",
          { class: "sb-opts" },
          raisers().length ? h("button", { class: "sb-b", onclick: () => void open("copy", p.id) }, "Скопировать из этой точки…") : null,
          p.id !== ln.head && can(machine, "points.raise") ? h("button", { class: "sb-b", "data-act": "rb", onclick: () => void open("rb", p.id) }, "Откатить к этой точке…") : null,
        ),
      );
    }

    const redrawMe = () => {
      // пометку поставили (roster принёс r2) — загрузить линию
      const now = !!r2Of(session());
      if (now && (!wasR2 || !loaded)) void load();
      wasR2 = now;
      draw();
    };
    screens.add(redrawMe);
    draw();
    if (wasR2) void load();
    return { refresh: redrawMe, close: () => screens.delete(redrawMe) };
  }

  const fireCount = () => {
    const on = online();
    return (fleet?.sessions ?? []).filter((s) => !on.has(s.owner)).length;
  };

  const mod: AppModule & { tab: CardTab } = {
    screens: {
      points: { nav: "Точки", mark: "fire", label: "Точки", mount: mountOverview },
      "session.points": { label: "Точки сессии", path: "session-points", mount: mountSession },
    },
    marks: { fire: fireCount },
    css: CSS,
    start(a) {
      app = a;
    },
    tab: {
      key: "points",
      label: "Точки",
      show: (callsign) => can(machineOf(callsign) ?? "", "session.r2"),
      mount: (callsign, place) => app.open("session.points", { callsign }, place),
    },
  };
  return mod;
}
