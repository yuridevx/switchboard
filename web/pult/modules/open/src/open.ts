// pult-open — новая сессия по прототипу «Пульт и телефон»: имя — первым полем (позывной под ним), профиль, папка,
// машина, слот, первое сообщение — необязательно; модель, усилие и «точки в R2» — в деталях.
// Проект — последнее имя папки (поле roster dir); его профиль, папки и машины — из сессий проекта в roster.
// Своих данных нет: слоты и профили — ответы владельцев на выбранной машине, папки — machine.dirs по шагу.
// «Открыть» = session.open; включено «в R2» — session.r2; есть сообщение — session.prompt; затем карточка.
import { add, h, pickOne, type App, type AppModule, type Params, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Slots = Record<string, { account: string | null; wait?: number | null; sessions: string[] }>;
type Profiles = Record<string, { model?: string | null; effort?: string | null }>;

const CSS = `
.op{flex:1;min-height:0;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:12px;max-width:680px}
.op h2{margin:0;font:600 19px var(--body)}
.op.sheet{max-width:none;margin-top:auto;flex:none;max-height:92%;background:var(--surface);border-radius:18px 18px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.25);padding:6px 16px calc(16px + env(safe-area-inset-bottom,0px))}
.op.sheet::before{content:"";align-self:center;width:40px;height:4px;border-radius:2px;background:var(--line);margin:4px 0 2px;flex:none}
.sb-screen:has(> .op.sheet){background:rgba(10,15,12,.38);justify-content:flex-end}
.op-fs{display:flex;flex-direction:column;gap:6px}
.op-fs>.lb{font:600 12px var(--body);color:var(--muted)}
.op-name{font:600 17px var(--body);padding:9px 12px}
.op-at{font:400 12px var(--mono);color:var(--muted)}
.op-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.op-chips .sb-b{border-radius:999px}
.op-chips .m{font-family:var(--mono)}
.op-dirs{border:1px solid var(--line2);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--surface)}
.op-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-family:var(--mono)}
.op-crumbs .sb-b{border-color:transparent;background:transparent;font-family:var(--mono)}
.op-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px;max-height:180px;overflow-y:auto}
.op-list .sb-b{justify-content:flex-start;border-color:transparent;background:transparent;font:500 13px var(--mono)}
.op-err{font:500 12.5px var(--mono);color:var(--bad)}
.op-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;border-top:1px solid var(--line2);padding-top:12px}
.op textarea{resize:vertical;font:14px var(--body)}
`;

/** Проект сессии — последнее имя папки (поле roster dir). */
export const projectOf = (dir: unknown) => (typeof dir === "string" ? (dir === "~" ? "~" : (dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "").toLowerCase()) : "");
/** Путь на шаг вверх: «~/Projects» → «~», «C:/x» → «C:/». */
export function up(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts.length <= 1) return p.startsWith("/") ? "/" : p;
  parts.pop();
  const out = parts.join("/");
  return out === "" ? "/" : /^[A-Za-z]:$/.test(out) ? out + "/" : out;
}
export const join = (p: string, n: string) => `${p.replace(/[\\/]+$/, "")}/${n}`;
/** Время сброса слота: секунды или миллисекунды эпохи → ЧЧ:ММ. */
const hm = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createOpen(): AppModule {
  let app: App;

  function mount(el: HTMLElement, params: Params): ScreenHandle {
    // телефон: форма — лист снизу поверх затемнения (прототип «Пульт и телефон»)
    const box = h("div", { class: app.wide ? "op" : "op sheet" });
    el.append(box);
    const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
    const machines = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.["session.open"] !== undefined).map((m) => m.machine);
    const src = params.from ? sessions().find((s) => s.callsign === params.from) : undefined;
    const project = params.project ?? (src ? projectOf(src.dir) : "");
    const inProject = (s: SessionRecord) => !!project && projectOf(s.dir) === project;
    /** машины проекта: машины его сессий; первая на связи — по умолчанию */
    const projMachines = () => [...new Set(sessions().filter(inProject).map((s) => machineOf(s.callsign) ?? ""))].filter((m) => machines().includes(m));
    const pickMachine = () => (params.machine && machines().includes(params.machine) ? params.machine : src ? (machineOf(src.callsign) ?? "") : (projMachines()[0] ?? machines()[0] ?? ""));
    let machine = pickMachine();
    // машина из адреса может прийти своим соединением позже первого roster: выбрать её, пока человек не выбрал другую
    let chosen = !!machine && (!params.machine || machine === params.machine);
    let slots: Slots | null = null;
    let profiles: Profiles | null = null;
    let refused: Record<string, string> = {};
    let slot = "";
    let profile = "";
    let dir = "";
    let dirAuto = true;
    let name = "";
    let text = "";
    let model = "";
    let effort = "";
    let r2 = true;
    let more = false;
    let browse: { path: string; dirs: string[]; err: string } | null = null;
    let nameErr = "";
    let err = "";
    let sending = false;

    const can = (n: string) => app.provides(machine)?.[n] !== undefined;
    const refuse = (m: string, n: string, r: { ok: boolean; error?: string }) => {
      if (!r.ok && m === machine) refused[n] = String(r.error);
    };
    const refusal = (n: string) => (refused[n] ? h("span", { class: "sb-note bad", role: "alert" }, `${n}: ${refused[n]}`) : null);
    /** папки проекта на машине: последние — первыми */
    const recentDirs = () => [...new Set(sessions().filter((s) => inProject(s) && machineOf(s.callsign) === machine && typeof s.dir === "string").map((s) => s.dir as string))];
    /** имя по умолчанию — папка; занятое на машине — с номером */
    const baseName = () => (name || projectOf(dir) || project || "task").replace(/[^A-Za-z0-9._-]/g, "").toLowerCase() || "task";
    const callsignFor = () => {
      const taken = new Set(sessions().map((s) => s.callsign));
      const base = baseName();
      if (name) return `${base}@${machine}`;
      let cs = `${base}@${machine}`;
      for (let n = 2; taken.has(cs); n++) cs = `${base}-${n}@${machine}`;
      return cs;
    };

    /** профиль по умолчанию: профиль сессий проекта на этой машине, если он у машины есть */
    function defaultProfile() {
      const have = profiles ?? {};
      const used = sessions().find((s) => inProject(s) && machineOf(s.callsign) === machine && (s.profile as { id?: string } | null)?.id && have[(s.profile as { id: string }).id]);
      profile = used ? (used.profile as { id: string }).id : (Object.keys(have).find((id) => id.split("/").at(-1) === project) ?? "");
    }

    async function loadMachine() {
      slots = profiles = null;
      refused = {};
      slot = profile = "";
      if (dirAuto) dir = src && machineOf(src.callsign) === machine && typeof src.dir === "string" ? src.dir : (recentDirs()[0] ?? "");
      const m = machine;
      const jobs: Array<Promise<void>> = [];
      if (can("machine.slots"))
        jobs.push(
          app.request<{ slots: Slots }>("machine.slots", { machine: m }).then((r) => {
            refuse(m, "machine.slots", r);
            if (r.ok && m === machine) {
              slots = r.result.slots ?? {};
              slot ||= Object.keys(slots)[0] ?? "";
            }
          }),
        );
      if (can("machine.profiles"))
        jobs.push(
          app.request<{ profiles: Profiles }>("machine.profiles", { machine: m }).then((r) => {
            refuse(m, "machine.profiles", r);
            if (r.ok && m === machine) {
              profiles = r.result.profiles ?? {};
              defaultProfile();
            }
          }),
        );
      draw();
      await Promise.all(jobs);
      draw();
    }

    async function dirs(path: string) {
      const r = await app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine, path });
      browse = r.ok ? { path: r.result.path, dirs: r.result.dirs.filter((d) => !d.startsWith(".")), err: "" } : { path, dirs: [], err: `machine.dirs: ${r.error}` };
      draw();
    }

    async function open() {
      nameErr = err = "";
      if (name && !NAME.test(name)) {
        nameErr = "имя — латиница, цифры, точка, - и _";
        return draw();
      }
      if (!dir) {
        err = "Выберите папку";
        return draw();
      }
      sending = true;
      draw();
      const cs = callsignFor();
      const body: Record<string, unknown> = { machine, name: cs.slice(0, cs.indexOf("@")), dir };
      if (slot) body.slot = slot;
      if (profile) body.profile = profile;
      if (model) body.model = model;
      if (effort) body.effort = effort;
      const r = await app.request<{ callsign: string }>("session.open", body);
      if (!r.ok) {
        sending = false;
        if (r.error === "name_taken") nameErr = `name_taken — на ${machine} уже есть ${cs}`;
        else err = `session.open: ${r.error}`;
        return draw();
      }
      const callsign = r.result.callsign;
      // пометку «в R2» держит host-points машины новой сессии; manage о ней не знает
      if (r2 && can("session.r2")) {
        const m = await app.request("session.r2", { callsign, on: true });
        if (!m.ok) app.toast(`${callsign}: «в R2» не включилось — ${m.error}`);
      }
      // первое сообщение — необязательно: без него сессия открыта и ждёт ввода
      if (text.trim()) {
        const p = await app.request("session.prompt", { callsign, text: text.trim(), attachments: [] });
        if (!p.ok) app.toast(`${callsign}: сообщение не ушло — ${p.error}`);
      }
      sending = false;
      app.open("card", { callsign });
    }

    function draw() {
      const ae = document.activeElement as HTMLElement | null;
      const keep = ae && box.contains(ae) ? ae.dataset.f : undefined;
      const pos = keep && (ae as HTMLInputElement).selectionStart;
      box.textContent = "";
      const ms = machines();
      const pm = projMachines();
      const nameIn = h("input", { class: "sb-in op-name", "data-f": "name", placeholder: baseName(), value: name, autocomplete: "off", "aria-label": "Имя сессии" }) as HTMLInputElement;
      const at = h("span", { class: "op-at" }, `→ ${callsignFor()}`);
      nameIn.addEventListener("input", () => {
        name = nameIn.value;
        nameErr = "";
        at.textContent = `→ ${callsignFor()}`;
      });
      const msg = h("textarea", { class: "sb-in", "data-f": "text", rows: 2, "aria-label": "Первое сообщение" }, text) as HTMLTextAreaElement;
      msg.addEventListener("input", () => (text = msg.value));
      msg.addEventListener("keydown", (e) => {
        const k = e as KeyboardEvent;
        if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) {
          k.preventDefault();
          void open();
        }
      });
      const chip = (label: string, pressed: boolean, attrs: Record<string, string>, onclick: () => void, cls = "") =>
        h("button", { class: `sb-b ${cls}`, "aria-pressed": pressed ? "true" : "false", ...attrs, onclick }, label);
      const recent = recentDirs();
      if (dir && !recent.includes(dir)) recent.unshift(dir);
      const prof = profiles ? Object.keys(profiles) : [];
      const pr = profile ? profiles?.[profile] : undefined;
      const sumModel = model || pr?.model || "";
      const sumEffort = effort || pr?.effort || "";
      add(
        box,
        h("h2", null, "Новая сессия"),
        h("div", { class: "op-fs" }, h("span", { class: "lb" }, "Имя сессии"), nameIn, at, nameErr ? h("div", { class: "op-err", role: "alert" }, nameErr) : null),
        can("machine.profiles")
          ? h(
              "div",
              { class: "op-fs" },
              h("span", { class: "lb" }, "Профиль"),
              h("div", { class: "op-chips" }, [...prof, ""].map((id) => chip(id ? (id.split("/").at(-1) ?? id) : "без профиля", profile === id, { "data-profile": id }, () => ((profile = id), draw()))), refusal("machine.profiles")),
            )
          : null,
        h(
          "div",
          { class: "op-fs" },
          h("span", { class: "lb" }, "Папка"),
          h(
            "div",
            { class: "op-chips" },
            recent.map((d) => chip(d, dir === d && !browse, { "data-dir-pick": d }, () => ((dir = d), (dirAuto = false), (browse = null), draw()), "m")),
            can("machine.dirs") ? h("button", { class: "sb-b dash", "aria-expanded": browse ? "true" : "false", onclick: () => (browse ? ((browse = null), draw()) : void dirs(dir ? up(dir) : "~")) }, "другая папка…") : null,
          ),
          browse ? drawBrowse() : null,
        ),
        h(
          "div",
          { class: "op-fs" },
          h("span", { class: "lb" }, "Машина"),
          ms.length
            ? h("div", { class: "op-chips" }, pickOne(ms, pm, machine, pickM, { select: { "aria-label": "Другая машина", "data-f": "machine-more" }, button: (m) => ({ "data-machine": m }) }))
            : h("span", { class: "sb-note" }, "Нет машин на связи"),
        ),
        // слотов на машине нет — строки нет
        can("machine.slots") && (refused["machine.slots"] || Object.keys(slots ?? {}).length)
          ? h(
              "div",
              { class: "op-fs" },
              h("span", { class: "lb" }, "Слот"),
              h(
                "div",
                { class: "op-chips" },
                refusal("machine.slots"),
                Object.entries(slots ?? {}).map(([n, sl]) => chip(sl.wait ? `${n} · ждёт сброса ${hm(sl.wait)}` : n, slot === n, { "data-slot": n }, () => ((slot = n), draw()))),
              ),
            )
          : null,
        h("div", { class: "op-fs" }, h("span", { class: "lb" }, "Первое сообщение"), msg),
        h("button", { class: "sb-b dash", style: "align-self:flex-start", "aria-expanded": more ? "true" : "false", "data-act": "more", onclick: () => ((more = !more), draw()) }, `${more ? "▾" : "▸"} ${[sumModel, EFFORTS.find(([k]) => k === sumEffort)?.[1] ?? sumEffort, r2 && can("session.r2") ? "точки в R2" : ""].filter(Boolean).join(" · ") || "детали"}`),
        ...(more
          ? [
              h("div", { class: "op-fs" }, h("span", { class: "lb" }, "Модель"), h("div", { class: "op-chips" }, MODELS.map((m) => chip(m, (model || pr?.model) === m, { "data-model": m }, () => ((model = m), draw()))))),
              h("div", { class: "op-fs" }, h("span", { class: "lb" }, "Усилие"), h("div", { class: "op-chips" }, EFFORTS.map(([k, l]) => chip(l, (effort || pr?.effort) === k, { "data-effort": k }, () => ((effort = k), draw()))))),
              can("session.r2")
                ? h("div", { class: "op-fs" }, h("span", { class: "lb" }, "Точки в R2"), h("div", { class: "op-chips" }, chip("выкл", !r2, { "data-r2": "off" }, () => ((r2 = false), draw())), chip("вкл", r2, { "data-r2": "on" }, () => ((r2 = true), draw()))))
                : null,
            ]
          : []
        ).filter((x): x is HTMLElement => x !== null),
        err ? h("div", { class: "op-err", role: "alert" }, err) : null,
        h(
          "div",
          { class: "op-foot" },
          h("button", { class: "sb-b", onclick: () => app.back() }, "Отмена"),
          h("button", { class: "sb-b pri", "data-act": "open", disabled: sending || !machine, onclick: () => void open() }, sending ? "Открываю…" : "Открыть"),
        ),
      );
      if (keep) {
        const e = box.querySelector<HTMLInputElement>(`[data-f="${keep}"]`);
        e?.focus();
        if (e && typeof pos === "number") e.setSelectionRange(pos, pos);
      }
    }

    function pickM(m: string) {
      machine = m;
      chosen = true;
      browse = null;
      void loadMachine();
    }

    function drawBrowse(): HTMLElement {
      const b = browse!;
      const segs = b.path.split("/");
      return h(
        "div",
        { class: "op-dirs" },
        h(
          "div",
          { class: "op-crumbs" },
          segs.flatMap((x, i) => [i ? h("span", { class: "sb-note" }, "/") : null, h("button", { class: "sb-b", "data-crumb": segs.slice(0, i + 1).join("/"), onclick: () => void dirs(segs.slice(0, i + 1).join("/") || "/") }, x || "/")]),
          h("span", { class: "sb-note", style: "margin-left:auto" }, `@${machine}`),
        ),
        b.err ? h("div", { class: "op-err" }, b.err) : null,
        h("div", { class: "op-list" }, b.dirs.length ? b.dirs.map((d) => h("button", { class: "sb-b", "data-dir": d, onclick: () => void dirs(join(b.path, d)) }, `▸ ${d}`)) : b.err ? null : h("span", { class: "sb-note" }, "Вложенных папок нет")),
        h(
          "div",
          { class: "op-chips", style: "justify-content:flex-end" },
          h("button", { class: "sb-b", onclick: () => ((browse = null), draw()) }, "Отмена"),
          h("button", { class: "sb-b pri", "data-act": "pick", onclick: () => ((dir = b.path), (dirAuto = false), (browse = null), draw()) }, `Выбрать ${b.path.split("/").pop() || b.path}`),
        ),
      );
    }

    void loadMachine();
    return {
      head: () => ({ title: "Новая сессия" }),
      refresh: () => {
        if (chosen) return;
        const m = pickMachine();
        if (!m) return;
        machine = m;
        chosen = !params.machine || m === params.machine;
        void loadMachine();
      },
    };
  }

  return {
    screens: {
      open: { label: "Новая сессия", mount },
      // пункт меню ⋯ карточки: новая сессия рядом — тот же проект и машина, что у сессии карточки
      "open.near": { place: "card.menu", label: "Новая задача рядом", path: "open-near", show: (p) => !!p.callsign, mount },
    },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
