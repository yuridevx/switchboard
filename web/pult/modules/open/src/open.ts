// pult-open — новая сессия: пустой разговор. Сверху — где: «Недавние» (места сессий на машинах на связи) или «Папка на машине»
// (машины и папки по частоте из roster, пресеты, путь, machine.dirs). Снизу — поле ввода: имя обязательно и подставлено из папки,
// чипы «Профиль» и модель · усилие · слот, «Точки в R2» (выключены), задача — необязательно.
// «Открыть» = session.open; включено «в R2» — session.r2; есть задача — session.prompt; затем карточка. Своих данных нет.
import { h, plural, projectOf, type App, type AppModule, type Params, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Slots = Record<string, { account: string | null; wait?: number | null; sessions: string[] }>;
type Profiles = Record<string, { model?: string | null; effort?: string | null; about?: string }>;
type Shown = { text: string; human: boolean };
type Browse = { m: string; path: string; dirs: string[]; err: string; mq: string; dq: string; step: "m" | "d" };

const CSS = `
.op{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg)}
.op-h{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 10px 16px;background:var(--surface);border-bottom:1px solid var(--line2)}
.op-h b{flex:1;font:600 19px/1.2 var(--body)}
.op-x{border:0;background:transparent;color:var(--muted);font-size:15px;border-radius:8px;padding:4px 9px}
.op-x:hover{background:var(--accent-weak)}
.op-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:6px}
.op-where{flex:none;display:flex;gap:2px;align-self:flex-start;background:var(--surface2);border:1px solid var(--line2);border-radius:10px;padding:2px}
.op-where button{border:0;background:transparent;border-radius:8px;padding:5px 12px;font:500 13px var(--body);color:var(--muted)}
.op-where button[aria-selected="true"]{background:var(--surface);color:var(--ink);font-weight:600;box-shadow:0 0 0 1px var(--line)}
.op-flt{flex:none;font:400 14px var(--body);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px;width:100%;box-sizing:border-box;min-width:0}
.op-g{font:600 11.5px var(--body);color:var(--muted);padding:8px 2px 2px}
.op-plc{flex:none;display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--line2);color:var(--ink)}
.op-plc:hover{border-color:var(--muted)}
.op-plc[aria-checked="true"]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.op-plc .rd{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--line);flex:none}
.op-plc[aria-checked="true"] .rd{border:4px solid var(--accent)}
.op-plc .m{font:600 13px var(--mono);white-space:nowrap;flex:none}
.op-plc .m.hum{font-family:var(--body)}
.op-plc .p{font:400 12.5px var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.op-none{font-size:12.5px;color:var(--muted);padding:8px 4px}
.op-brw{flex:1;min-height:0;display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr);gap:10px}
.op-brw.one{display:block;flex:none}
.op-bm{display:flex;flex-direction:column;gap:6px;min-height:0}
.op-bl{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
.op-bl button{flex:none;display:flex;align-items:center;gap:8px;border:0;background:transparent;border-radius:8px;padding:6px 8px;text-align:left;color:var(--ink)}
.op-bl button:hover{background:var(--accent-weak)}
.op-bl button[aria-selected="true"]{background:var(--accent);color:var(--on-accent)}
.op-bl b{font:600 13px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.op-bl b.hum{font-family:var(--body)}
.op-bl .k{margin-left:auto;font-size:11.5px;color:var(--muted);white-space:nowrap}
.op-bl button[aria-selected="true"] .k{color:inherit;opacity:.75}
.op-bf{display:flex;flex-direction:column;gap:8px;min-height:0;min-width:0;border:1px solid var(--line2);border-radius:12px;padding:10px;background:var(--surface)}
.op-bk{align-self:flex-start;border:0;background:transparent;padding:4px 8px;font:600 13px var(--mono);color:var(--ink);border-radius:8px}
.op-pre{flex:none;display:flex;flex-wrap:wrap;gap:4px}
.op-pre button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:3px 10px;font:500 12px var(--mono)}
.op-pre .n{font-size:11px;color:var(--muted)}
.op-pre button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.op-pre button[aria-pressed="true"] .n{color:inherit;opacity:.75}
.op-bf input{font:500 13px var(--mono);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 9px;min-width:0;width:100%;box-sizing:border-box;flex:none}
.op-cr{flex:none;display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-family:var(--mono)}
.op-cr button{border:0;background:transparent;color:var(--ink);font:500 12.5px var(--mono);padding:2px 6px;border-radius:6px}
.op-cr button:hover{background:var(--accent-weak)}
.op-cr span{color:var(--muted)}
.op-cr input{margin-left:auto;width:120px;padding:3px 8px;font:400 12px var(--body)}
.op-dl{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
.op-dl button{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;text-align:left;font:500 12.5px var(--mono);padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--ink)}
.op-dl button:hover{background:var(--surface2)}
.op-dl .n{font-size:11px;color:var(--muted)}
.op-bfoot{flex:none;display:flex;align-items:center;gap:8px;border-top:1px solid var(--line2);padding-top:8px}
.op-bfoot .w{flex:1;min-width:0;font:500 12.5px var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op-err{font:500 12.5px var(--mono);color:var(--bad)}
.op-cmp{position:relative;flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));background:var(--surface);border-top:1px solid var(--line2)}
.op-nm{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:2px 10px;background:var(--surface)}
.op-nm label{font:600 12.5px var(--body);color:var(--muted);flex:none}
.op-nm input{border:0;outline:0;padding:7px 0;font:600 15px var(--mono);background:transparent;color:var(--ink);flex:1;min-width:0}
.op-nm:focus-within{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.op-nm.bad{border-color:var(--bad);box-shadow:0 0 0 1px var(--bad)}
.op-nm .at{font:500 13px var(--mono);color:var(--muted);flex:none;white-space:nowrap}
.op-nm .at.hum{font-family:var(--body)}
.op-ctx{display:flex;flex-wrap:wrap;gap:6px}
.op-cx{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line2);background:var(--surface2);color:var(--ink);border-radius:999px;padding:4px 10px;font:500 12.5px var(--body)}
.op-cx .k{color:var(--muted)}
.op-cx b{font-weight:600}
.op-cx[aria-expanded="true"]{border-color:var(--accent)}
.op-cx:disabled{opacity:.45;cursor:default}
.op-cmp textarea{resize:none;font:400 14px/1.45 var(--body);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px;box-sizing:border-box;width:100%}
.op-foot{display:flex;justify-content:flex-end;gap:8px}
.op-pop{position:absolute;left:12px;bottom:calc(100% + 6px);width:min(380px,calc(100% - 24px));max-height:380px;overflow-y:auto;z-index:6;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.18);padding:8px;display:flex;flex-direction:column;gap:4px}
.op-pop .lb{font:600 11.5px var(--body);color:var(--muted);padding:4px 8px 0}
.op-pr{display:flex;flex-direction:column;gap:2px;text-align:left;width:100%;border:1px solid transparent;background:transparent;border-radius:9px;padding:8px 10px;color:var(--ink);flex:none}
.op-pr:hover{background:var(--surface2)}
.op-pr[aria-checked="true"]{background:var(--accent-weak);border-color:var(--line)}
.op-pr .r1{display:flex;justify-content:space-between;gap:10px;font-size:13px}
.op-pr .sp{font-size:12px;color:var(--muted);white-space:nowrap}
.op-pr .r2{font-size:12px;color:var(--muted)}
.op-opts{display:flex;flex-wrap:wrap;gap:4px;padding:2px 8px}
.op-opts button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:3px 10px;font:500 12.5px var(--body)}
.op-opts button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.op-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;font-size:13px}
.op-sw button{width:34px;height:20px;border-radius:999px;background:var(--line);border:0;padding:0;position:relative;flex:none}
.op-sw button::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--surface);transition:left .15s}
.op-sw button[aria-checked="true"]{background:var(--ok)}
.op-sw button[aria-checked="true"]::after{left:16px}
.sb-app:not(.wide) .op-pop{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;max-height:70%;border-radius:18px 18px 0 0;border-width:1px 0 0;z-index:20;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
.op-shade{position:fixed;inset:0;z-index:19;background:rgba(10,15,12,.38)}
.sb-app:not(.wide) .op-brw.one .op-bf{padding:10px}
.sb-app:not(.wide) .op-pre{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.sb-app:not(.wide) .op-pre button{flex:none}
.sb-app:not(.wide) .op-dl{flex:none;overflow:visible}
.sb-app:not(.wide) .op-bfoot{position:sticky;bottom:-12px;background:var(--surface);padding-bottom:10px;z-index:1}
`;

/** Путь на шаг вверх: «~/Projects» → «~», «C:/x» → «C:/». */
export function up(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts.length <= 1) return p.startsWith("/") ? "/" : p;
  parts.pop();
  const out = parts.join("/");
  return out === "" ? "/" : /^[A-Za-z]:$/.test(out) ? out + "/" : out;
}
export const join = (p: string, n: string) => `${p.replace(/[\\/]+$/, "")}/${n}`;
const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const under = (dir: string, path: string) => {
  const d = slash(dir);
  const q = slash(path);
  return d === q || d.startsWith(`${q}/`);
};
/** Время сброса слота: секунды или миллисекунды эпохи → ЧЧ:ММ. */
const hm = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const effName = (e: string) => EFFORTS.find(([k]) => k === e)?.[1] ?? e;
const short = (id: string) => id.split("/").at(-1) ?? id;

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createOpen(): AppModule {
  let app: App;

  function mount(el: HTMLElement, params: Params): ScreenHandle {
    const box = h("div", { class: "op" });
    el.append(box);
    const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
    const machines = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.["session.open"] !== undefined).map((m) => m.machine);
    const mLabel = (m: string) => (app.mark("label.machine", m) as Shown | undefined) ?? { text: `@${m}`, human: false };
    const dirOf = (s: SessionRecord) => (typeof s.dir === "string" && s.dir ? s.dir : "~");

    let machine = "";
    let dir = "";
    let name = "";
    let nameSet = false;
    let nameErr = "";
    let err = "";
    let profile: string | null = null;
    let model = "";
    let effort = "";
    let modelSet = false;
    let slot = "";
    let r2 = false;
    let text = "";
    let sending = false;
    let where: "recent" | "browse" = "recent";
    let q = "";
    let pq = "";
    let pop: "" | "prof" | "model" = "";
    let brw: Browse | null = null;
    let slots: Slots | null = null;
    let profiles: Profiles | null = null;
    let refused: Record<string, string> = {};

    const can = (m: string, n: string) => app.provides(m)?.[n] !== undefined;
    const taken = (cs: string) => sessions().some((s) => s.callsign === cs);

    /** частота — из roster: сессий на машине и под папкой, включая остановленные */
    const machineUse = (m: string) => sessions().filter((s) => machineOf(s.callsign) === m).length;
    const folderUse = (m: string, path: string) => sessions().filter((s) => machineOf(s.callsign) === m && under(dirOf(s), path)).length;
    /** пресеты: папки сессий машины и папки над ними — по частоте, потом короче; дом — последним: под ним всё */
    function presetsOf(m: string): string[] {
      const c = new Set<string>();
      for (const s of sessions()) {
        if (machineOf(s.callsign) !== m) continue;
        const d = dirOf(s);
        if (d === "~") continue;
        c.add(d);
        const parent = up(d);
        if (parent !== d && parent !== "~") c.add(parent);
      }
      return [...[...c].sort((a, b) => folderUse(m, b) - folderUse(m, a) || a.length - b.length || a.localeCompare(b)).slice(0, 7), "~"];
    }

    /** имя — главное и обязательное: подставлено из папки, пока человек его не правил; занятое на машине — с номером */
    function suggestName(): string {
      const base = projectOf(dir).replace(/[^A-Za-z0-9._-]/g, "").toLowerCase() || "task";
      let n = base;
      for (let i = 2; taken(`${n}@${machine}`); i++) n = `${base}-${i}`;
      return n;
    }

    function setProfile(id: string | null) {
      profile = id;
      if (modelSet) return;
      const p = id ? profiles?.[id] : undefined;
      model = p?.model ?? "";
      effort = p?.effort ?? "";
    }
    /** профиль по умолчанию: профиль сессии этого места, иначе одноимённый проекту, если он у машины есть */
    function defaultProfile() {
      const have = profiles ?? {};
      if (profile && have[profile]) return setProfile(profile);
      const used = sessions().find((s) => machineOf(s.callsign) === machine && dirOf(s) === dir && (s.profile as { id?: string } | null)?.id && have[(s.profile as { id: string }).id]);
      setProfile(used ? (used.profile as { id: string }).id : (Object.keys(have).find((id) => short(id) === projectOf(dir)) ?? null));
    }

    async function loadMachine() {
      const m = machine;
      slots = profiles = null;
      refused = {};
      slot = "";
      const jobs: Array<Promise<void>> = [];
      if (can(m, "machine.slots"))
        jobs.push(
          app.request<{ slots: Slots }>("machine.slots", { machine: m }).then((r) => {
            if (m !== machine) return;
            if (!r.ok) refused["machine.slots"] = r.error;
            else {
              slots = r.result.slots ?? {};
              slot ||= Object.keys(slots)[0] ?? "";
            }
          }),
        );
      if (can(m, "machine.profiles"))
        jobs.push(
          app.request<{ profiles: Profiles }>("machine.profiles", { machine: m }).then((r) => {
            if (m !== machine) return;
            if (!r.ok) refused["machine.profiles"] = r.error;
            else {
              profiles = r.result.profiles ?? {};
              defaultProfile();
            }
          }),
        );
      draw();
      await Promise.all(jobs);
      draw();
    }

    function pickPlace(m: string, d: string) {
      const same = m === machine;
      machine = m;
      dir = d;
      brw = null;
      where = "recent";
      err = "";
      pop = "";
      q = "";
      if (!nameSet) name = suggestName();
      if (same) {
        defaultProfile();
        draw();
      } else void loadMachine();
    }

    async function browseTo(path: string) {
      const b = brw;
      if (!b) return;
      b.path = path;
      b.dq = "";
      b.err = "";
      b.dirs = [];
      draw();
      const r = await app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine: b.m, path });
      if (brw !== b || b.path !== path) return;
      if (r.ok) {
        b.path = r.result.path;
        b.dirs = r.result.dirs.filter((d) => !d.startsWith("."));
      } else b.err = `machine.dirs: ${r.error}`;
      draw();
    }

    function openBrowse() {
      where = "browse";
      if (brw) return draw();
      // обзор открывается на машине места или самой частой, в самой частой её папке
      const m = machine || [...machines()].sort((a, b) => machineUse(b) - machineUse(a) || a.localeCompare(b))[0];
      if (!m) return draw();
      brw = { m, path: machine ? dir : presetsOf(m)[0], dirs: [], err: "", mq: "", dq: "", step: machine ? "d" : "m" };
      void browseTo(brw.path);
    }

    async function start() {
      nameErr = err = "";
      if (!name) nameErr = "нужно имя";
      else if (!NAME.test(name)) nameErr = "латиница, цифры, точка, - и _";
      if (nameErr) return draw();
      sending = true;
      draw();
      const body: Record<string, unknown> = { machine, name: name.toLowerCase(), dir };
      if (slot) body.slot = slot;
      if (profile) body.profile = profile;
      if (modelSet && model) body.model = model;
      if (modelSet && effort) body.effort = effort;
      const r = await app.request<{ callsign: string }>("session.open", body);
      if (!r.ok) {
        sending = false;
        if (r.error === "name_taken") nameErr = `name_taken: на ${machine} уже есть ${name.toLowerCase()}@${machine}`;
        else err = `session.open: ${r.error}`;
        return draw();
      }
      const callsign = r.result.callsign;
      // пометку «в R2» держит host-points машины новой сессии; manage о ней не знает
      if (r2 && can(machine, "session.r2")) {
        const m = await app.request("session.r2", { callsign, on: true });
        if (!m.ok) app.toast(`${callsign}: «в R2» не включилось — ${m.error}`);
      }
      // задача — необязательно: без неё сессия открыта и ждёт ввода
      if (text.trim()) {
        const p = await app.request("session.prompt", { callsign, text: text.trim(), attachments: [] });
        if (!p.ok) app.toast(`${callsign}: задача не ушла — ${p.error}`);
      }
      sending = false;
      app.open("card", { callsign });
    }

    // ───── где ─────
    function recentPane(): Array<HTMLElement | null> {
      const ql = q.trim().toLowerCase();
      const online = new Set(machines());
      const seen = new Map<string, { project: string; m: string; dir: string }>();
      for (const s of sessions()) {
        const m = machineOf(s.callsign) ?? "";
        if (!online.has(m)) continue;
        seen.set(`${m}|${dirOf(s)}`, { project: projectOf(dirOf(s)), m, dir: dirOf(s) });
      }
      const all = [...seen.values()].sort((a, b) => a.project.localeCompare(b.project) || a.m.localeCompare(b.m));
      const plc = (x: { m: string; dir: string }, on: boolean) => {
        const l = mLabel(x.m);
        return h("button", { class: "op-plc", role: "radio", "aria-checked": String(on), "data-machine": x.m, "data-dir-pick": x.dir, onclick: () => pickPlace(x.m, x.dir) }, h("span", { class: "rd" }), h("span", { class: "m" + (l.human ? " hum" : "") }, l.text), h("span", { class: "p" }, x.dir));
      };
      const out: Array<HTMLElement | null> = [h("input", { class: "op-flt", "data-f": "q", value: q, placeholder: `Проект, машина или папка · ${all.length}`, autocomplete: "off", "aria-label": "Найти место", oninput: (e) => ((q = (e.target as HTMLInputElement).value), draw()) })];
      // выбранное место — первым, чтобы при длинном списке его было видно
      if (machine && !ql) out.push(h("div", { class: "op-g" }, `выбрано · ${projectOf(dir)}`), plc({ m: machine, dir }, true));
      let group = "";
      let shown = 0;
      for (const x of all) {
        if (ql ? !`${x.project} ${x.m} ${mLabel(x.m).text} ${x.dir}`.toLowerCase().includes(ql) : x.m === machine && x.dir === dir) continue;
        if (x.project !== group) out.push(h("div", { class: "op-g" }, (group = x.project)));
        out.push(plc(x, x.m === machine && x.dir === dir));
        shown++;
      }
      if (!all.length || (ql && !shown)) out.push(h("div", { class: "op-none" }, "мест нет"));
      return out;
    }

    function machinesPane(b: Browse): HTMLElement {
      const ql = b.mq.trim().toLowerCase();
      const ms = machines()
        .filter((m) => !ql || `${m} ${mLabel(m).text}`.toLowerCase().includes(ql))
        .sort((x, y) => machineUse(y) - machineUse(x) || x.localeCompare(y));
      return h(
        "div",
        { class: "op-bm" },
        h("input", { class: "op-flt", "data-f": "mq", value: b.mq, placeholder: `Машина · ${machines().length}`, autocomplete: "off", "aria-label": "Найти машину", oninput: (e) => ((b.mq = (e.target as HTMLInputElement).value), draw()) }),
        h(
          "div",
          { class: "op-bl", role: "listbox", "aria-label": "Машины" },
          ms.length
            ? ms.map((m) => {
                const n = machineUse(m);
                const l = mLabel(m);
                return h(
                  "button",
                  {
                    role: "option",
                    "aria-selected": String(b.m === m),
                    "data-machine": m,
                    onclick: () => {
                      b.m = m;
                      b.step = "d";
                      void browseTo(presetsOf(m)[0]);
                    },
                  },
                  h("b", { class: l.human ? "hum" : null }, l.text),
                  h("span", { class: "k" }, n ? `${n} ${plural(n, "сессия", "сессии", "сессий")}` : ""),
                );
              })
            : h("span", { class: "op-none" }, "машин нет"),
        ),
      );
    }

    function foldersPane(b: Browse): HTMLElement {
      const segs = b.path.split("/");
      const dq = b.dq.trim().toLowerCase();
      const dirs = b.dirs.filter((d) => !dq || d.toLowerCase().includes(dq)).sort((x, y) => folderUse(b.m, join(b.path, y)) - folderUse(b.m, join(b.path, x)) || x.localeCompare(y));
      const pathIn = h("input", { "data-f": "path", value: b.path, autocomplete: "off", spellcheck: "false", "aria-label": `Путь на ${mLabel(b.m).text}` }) as HTMLInputElement;
      pathIn.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && void browseTo(pathIn.value.trim() || "~"));
      pathIn.addEventListener("change", () => pathIn.value.trim() !== b.path && void browseTo(pathIn.value.trim() || "~"));
      return h(
        "div",
        { class: "op-bf" },
        app.wide ? null : h("button", { class: "op-bk", onclick: () => ((b.step = "m"), draw()) }, `‹ ${mLabel(b.m).text}`),
        h(
          "div",
          { class: "op-pre" },
          presetsOf(b.m).map((p) => {
            const n = folderUse(b.m, p);
            return h("button", { "aria-pressed": String(b.path === p), "data-preset": p, onclick: () => void browseTo(p) }, p, n ? h("span", { class: "n" }, String(n)) : null);
          }),
        ),
        pathIn,
        h(
          "div",
          { class: "op-cr" },
          segs.flatMap((x, i) => [i ? h("span", null, "/") : null, h("button", { "data-crumb": segs.slice(0, i + 1).join("/"), onclick: () => void browseTo(segs.slice(0, i + 1).join("/") || "/") }, x || "/")]),
          h("input", { "data-f": "dq", value: b.dq, placeholder: "фильтр", autocomplete: "off", "aria-label": "Фильтр папок", oninput: (e) => ((b.dq = (e.target as HTMLInputElement).value), draw()) }),
        ),
        b.err ? h("div", { class: "op-err", role: "alert" }, b.err) : null,
        h(
          "div",
          { class: "op-dl" },
          dirs.map((d) => {
            const n = folderUse(b.m, join(b.path, d));
            return h("button", { "data-dir": d, onclick: () => void browseTo(join(b.path, d)) }, h("span", null, `▸ ${d}`), n ? h("span", { class: "n" }, String(n)) : null);
          }),
          !dirs.length && !b.err ? h("span", { class: "op-none" }, "пусто") : null,
        ),
        h("div", { class: "op-bfoot" }, h("span", { class: "w" }, `${mLabel(b.m).text} ${b.path}`), h("button", { class: "sb-b pri", "data-act": "pick", onclick: () => pickPlace(b.m, b.path) }, `Выбрать ${segs.at(-1) || b.path}`)),
      );
    }

    /** пульт — машины и папки рядом; телефон — сначала машина, потом папки */
    function browsePane(): HTMLElement {
      const b = brw;
      if (!b) return h("div", { class: "op-none" }, "машин нет");
      if (!app.wide) return h("div", { class: "op-brw one" }, b.step === "m" ? machinesPane(b) : foldersPane(b));
      return h("div", { class: "op-brw" }, machinesPane(b), foldersPane(b));
    }

    // ───── окна чипов ─────
    function profPop(): Array<HTMLElement | null> {
      const ql = pq.trim().toLowerCase();
      const ids = Object.keys(profiles ?? {});
      return [
        h("div", { class: "lb" }, `Профиль · ${mLabel(machine).text} · ${ids.length}`),
        h("input", { class: "op-flt", "data-f": "pq", value: pq, placeholder: "Найти профиль", autocomplete: "off", "aria-label": "Найти профиль", oninput: (e) => ((pq = (e.target as HTMLInputElement).value), draw()) }),
        refused["machine.profiles"] ? h("div", { class: "op-err", role: "alert" }, `machine.profiles: ${refused["machine.profiles"]}`) : null,
        ...ids
          .filter((id) => !ql || `${id} ${profiles![id].about ?? ""}`.toLowerCase().includes(ql))
          .map((id) => {
            const p = profiles![id];
            return h(
              "button",
              { class: "op-pr", role: "radio", "aria-checked": String(profile === id), "data-profile": id, onclick: () => (setProfile(id), (pop = ""), draw()) },
              h("span", { class: "r1" }, h("b", null, short(id)), h("span", { class: "sp" }, [p.model, p.effort ? effName(p.effort) : null].filter(Boolean).join(" · "))),
              p.about ? h("span", { class: "r2" }, p.about) : null,
            );
          }),
        h("button", { class: "op-pr", role: "radio", "aria-checked": String(profile === null), "data-profile": "", onclick: () => (setProfile(null), (pop = ""), draw()) }, h("span", { class: "r1" }, h("b", null, "без профиля"))),
      ];
    }

    function modelPop(): Array<HTMLElement | null> {
      const opt = (attr: string, v: string, label: string, on: boolean, act: () => void) => h("button", { [attr]: v, "aria-pressed": String(on), onclick: () => (act(), draw()) }, label);
      return [
        h("div", { class: "lb" }, "Модель"),
        h("div", { class: "op-opts" }, MODELS.map((m) => opt("data-model", m, m, model === m, () => ((model = m), (modelSet = true))))),
        h("div", { class: "lb" }, "Усилие"),
        h("div", { class: "op-opts" }, EFFORTS.map(([k, l]) => opt("data-effort", k, l, effort === k, () => ((effort = k), (modelSet = true))))),
        Object.keys(slots ?? {}).length ? h("div", { class: "lb" }, "Слот") : null,
        Object.keys(slots ?? {}).length ? h("div", { class: "op-opts" }, Object.entries(slots!).map(([n, sl]) => opt("data-slot", n, sl.wait ? `${n} · ждёт сброса ${hm(sl.wait)}` : n, slot === n, () => (slot = n)))) : null,
        refused["machine.slots"] ? h("div", { class: "op-err", role: "alert" }, `machine.slots: ${refused["machine.slots"]}`) : null,
        can(machine, "session.r2") || !machine ? h("div", { class: "op-sw" }, h("span", null, "Точки в R2"), h("button", { role: "switch", "aria-label": "Точки в R2", "aria-checked": String(r2), "data-r2": "1", onclick: () => ((r2 = !r2), draw()) })) : null,
      ];
    }

    function composer(): HTMLElement {
      const l = machine ? mLabel(machine) : null;
      const nm = h("input", { id: "op-name", "data-f": "name", value: name, required: true, "aria-required": "true", autocomplete: "off", spellcheck: "false", placeholder: machine ? "нужно имя" : "сначала место", disabled: !machine }) as HTMLInputElement;
      const task = h("textarea", { "data-f": "text", rows: 3, "aria-label": "Задача", placeholder: "Что сделать?" }, text) as HTMLTextAreaElement;
      const go = h("button", { class: "sb-b pri", "data-act": "open", disabled: sending || !machine || !name, onclick: () => void start() }, text.trim() ? "Начать" : "Открыть") as HTMLButtonElement;
      const row = h("div", { class: "op-nm" + (nameErr ? " bad" : "") }, h("label", { for: "op-name" }, "Имя"), nm, l ? h("span", { class: "at" + (l.human ? " hum" : "") }, l.text) : null);
      nm.addEventListener("input", () => {
        name = nm.value.trim();
        nameSet = true;
        nameErr = "";
        go.disabled = sending || !machine || !name;
        row.classList.remove("bad");
      });
      task.addEventListener("input", () => {
        text = task.value;
        go.textContent = text.trim() ? "Начать" : "Открыть";
      });
      task.addEventListener("keydown", (e) => {
        const k = e as KeyboardEvent;
        if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) {
          k.preventDefault();
          if (!go.disabled) void start();
        }
      });
      const chip = (kind: "prof" | "model", disabled: boolean, ...kids: HTMLElement[]) => h("button", { class: "op-cx", "data-pop": kind, "aria-expanded": String(pop === kind), disabled, onclick: () => ((pop = pop === kind ? "" : kind), (pq = ""), draw()) }, kids);
      const close = () => ((pop = ""), draw());
      return h(
        "div",
        { class: "op-cmp" },
        pop && !app.wide ? h("div", { class: "op-shade", onclick: close }) : null,
        pop ? h("div", { class: "op-pop", role: "dialog", "aria-label": "Выбор" }, pop === "prof" ? profPop() : modelPop(), app.wide ? null : h("button", { class: "sb-b pri", style: "margin:8px;justify-content:center", onclick: close }, "Готово")) : null,
        row,
        nameErr ? h("span", { class: "op-err", role: "alert" }, nameErr) : null,
        h(
          "div",
          { class: "op-ctx" },
          chip("prof", !machine, h("span", { class: "k" }, "Профиль"), h("b", null, profile ? short(profile) : "без профиля")),
          chip("model", false, h("b", null, model || "модель"), h("span", { class: "k" }, [effort ? effName(effort) : null, slot, r2 ? "R2" : null].filter(Boolean).join(" · "))),
        ),
        task,
        err ? h("span", { class: "op-err", role: "alert" }, err) : null,
        h("div", { class: "op-foot" }, go),
      );
    }

    function draw() {
      const ae = document.activeElement as HTMLElement | null;
      const keep = ae && box.contains(ae) ? ae.dataset.f : undefined;
      const pos = keep && (ae as HTMLInputElement).selectionStart;
      const kept = [...box.querySelectorAll(".op-body, .op-bl, .op-dl, .op-pop")].map((x) => [x.className, x.scrollTop] as const);
      const tab = (k: "recent" | "browse", label: string) => h("button", { role: "tab", "aria-selected": String(where === k), "data-where": k, onclick: () => (k === "browse" ? openBrowse() : ((where = "recent"), draw())) }, label);
      box.replaceChildren(
        app.wide ? h("div", { class: "op-h" }, h("b", null, "Новая сессия"), h("button", { class: "op-x", "aria-label": "Закрыть", onclick: () => app.back() }, "✕")) : "",
        h("div", { class: "op-body" }, h("div", { class: "op-where", role: "tablist", "aria-label": "Где" }, tab("recent", "Недавние"), tab("browse", "Папка на машине")), where === "browse" ? browsePane() : recentPane()),
        composer(),
      );
      for (const [cls, top] of kept) {
        const x = box.querySelector(`.${cls.split(" ")[0]}`);
        if (x) x.scrollTop = top;
      }
      if (keep) {
        const e = box.querySelector<HTMLInputElement>(`[data-f="${keep}"]`);
        e?.focus();
        if (e && typeof pos === "number") e.setSelectionRange(pos, pos);
      }
    }

    /** место из адреса: машина может прийти своим соединением позже первого roster */
    function fromParams() {
      if (machine || !params.machine || !machines().includes(params.machine)) return false;
      pickPlace(params.machine, params.dir || "~");
      return true;
    }

    if (!fromParams()) draw();
    if (!params.machine) queueMicrotask(() => box.querySelector<HTMLInputElement>('[data-f="q"]')?.focus());
    return {
      head: () => ({ title: "Новая сессия" }),
      refresh: () => void fromParams(),
    };
  }

  return {
    screens: { open: { label: "Новая сессия", mount } },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
