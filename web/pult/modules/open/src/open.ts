// pult-open — новая сессия: машина, слот, профиль, папка, имя, модель, усилие, «в R2» → session.open.
// Своих данных нет: слоты, лимиты и профили — ответы владельцев на выбранной машине, папки — machine.dirs.
import { h, plural, type App, type AppModule, type ScreenHandle } from "@switchboard/web-core";

const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Slots = Record<string, { account: string | null; order?: string[]; sessions: string[] }>;
type Accounts = Record<string, { limits?: Record<string, { utilization: number }> }>;
type Profiles = Record<string, { model?: string | null; effort?: string | null }>;

const CSS = `
.sb-navcol button[data-screen="open"]{border:1px dashed var(--line);color:var(--accent);margin-bottom:6px;order:-1}
.op-dirs{display:flex;flex-wrap:wrap;gap:5px}
.op-dirs button{font:500 12.5px var(--mono)}
.op-browse{border:1px dashed var(--line);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
.op-err{font:500 12.5px var(--mono);color:var(--bad)}
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

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createOpen(): AppModule {
  let app: App;

  function mount(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    const machines = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.["session.open"] !== undefined).map((m) => m.machine);
    let machine = params.machine && machines().includes(params.machine) ? params.machine : (machines()[0] ?? "");
    let slots: Slots | null = null;
    let accounts: Accounts | null = null;
    let profiles: Profiles | null = null;
    let slot = "";
    let profile = "";
    let dir = "~/";
    let name = "";
    let model = "";
    let effort = "";
    let r2 = false;
    let browse: { path: string; dirs: string[]; hidden: boolean; err: string; mk: string } | null = null;
    let nameErr = "";
    let err = "";
    let sending = false;

    const can = (n: string) => app.provides(machine)?.[n] !== undefined;

    async function loadMachine() {
      slots = accounts = profiles = null;
      slot = profile = "";
      const m = machine;
      const jobs: Array<Promise<void>> = [];
      if (can("machine.slots"))
        jobs.push(
          app.request<{ slots: Slots }>("machine.slots", { machine: m }).then((r) => {
            if (r.ok && m === machine) {
              slots = r.result.slots ?? {};
              slot ||= Object.keys(slots)[0] ?? "";
            }
          }),
        );
      if (can("machine.accounts"))
        jobs.push(
          app.request<{ accounts: Accounts }>("machine.accounts", { machine: m }).then((r) => {
            if (r.ok && m === machine) accounts = r.result.accounts ?? {};
          }),
        );
      if (can("machine.profiles"))
        jobs.push(
          app.request<{ profiles: Profiles }>("machine.profiles", { machine: m }).then((r) => {
            if (r.ok && m === machine) profiles = r.result.profiles ?? {};
          }),
        );
      draw();
      await Promise.all(jobs);
      draw();
    }

    async function dirs(path: string) {
      const r = await app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine, path });
      const hidden = browse?.hidden ?? false;
      browse = r.ok ? { path: r.result.path, dirs: r.result.dirs, hidden, err: "", mk: "" } : { path, dirs: [], hidden, err: `machine.dirs: ${r.error}`, mk: "" };
      draw();
    }

    async function mkdir() {
      if (!browse || !browse.mk.trim()) return;
      const path = join(browse.path, browse.mk.trim());
      const r = await app.request<{ path: string }>("machine.mkdir", { machine, path });
      if (!r.ok) {
        browse.err = `machine.mkdir: ${r.error}`;
        return draw();
      }
      dir = r.result.path;
      await dirs(dir);
    }

    async function open() {
      nameErr = err = "";
      if (!NAME.test(name)) {
        nameErr = "имя — латиница, цифры, точка, - и _";
        return draw();
      }
      sending = true;
      draw();
      const body: Record<string, unknown> = { machine, name, dir };
      if (slot) body.slot = slot;
      if (profile) body.profile = profile;
      if (model) body.model = model;
      if (effort) body.effort = effort;
      const r = await app.request<{ callsign: string }>("session.open", body);
      sending = false;
      if (!r.ok) {
        if (r.error === "name_taken") nameErr = `name_taken — на ${machine} уже есть ${name}@${machine}`;
        else err = `session.open: ${r.error}`;
        return draw();
      }
      const callsign = r.result.callsign;
      // пометку «в R2» держит host-points машины новой сессии; manage о ней не знает
      if (r2) {
        const m = await app.request("session.r2", { callsign, on: true });
        if (!m.ok) app.toast(`${callsign}: «в R2» не включилось — ${m.error}. Включить можно во вкладке «Точки».`);
      }
      app.open("card", { callsign });
    }

    const limitOf = (acc: string | null) => {
      const ws = Object.entries(accounts?.[acc ?? ""]?.limits ?? {});
      const w = ws.find(([k]) => k === "five_hour") ?? ws[0];
      return w ? `${w[0] === "five_hour" ? "5 ч" : w[0] === "seven_day" ? "неделя" : w[0]} ${Math.round(w[1].utilization * 100)} %` : "";
    };

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const ms = machines();
      const input = (f: string, value: string, set: (v: string) => void, attrs: Record<string, string> = {}) => {
        const e = h("input", { class: "sb-in m", "data-f": f, value, ...attrs }) as HTMLInputElement;
        e.addEventListener("input", () => {
          set(e.value);
          if (f === "name") {
            nameErr = "";
            preview.textContent = e.value ? `→ ${e.value}@${machine}` : "";
          }
        });
        return e;
      };
      const preview = h("span", { class: "sb-note" }, name ? `→ ${name}@${machine}` : "");
      const pick = (list: string[], cur: string, set: (v: string) => void, none: string) =>
        h("div", { class: "sb-opts" }, [["", none], ...list.map((x) => [x, x])].map(([v, label]) => h("button", { class: "sb-b", "aria-pressed": cur === v ? "true" : "false", "data-v": v, onclick: () => (set(v), draw()) }, label)));
      box.append(
        h("div", { class: "sb-ph" }, h("h2", null, "Новая сессия")),
        h(
          "section",
          { class: "sb-sec" },
          h(
            "div",
            { class: "sb-row" },
            h("span", null, "машина"),
            ms.length
              ? h("div", { class: "sb-opts" }, ms.map((m) => h("button", { class: "sb-b", "aria-pressed": m === machine ? "true" : "false", "data-machine": m, onclick: () => ((machine = m), (browse = null), void loadMachine()) }, m)))
              : h("span", { class: "sb-note" }, "нет машин на связи, которые открывают сессии"),
          ),
          can("machine.slots")
            ? h(
                "div",
                { class: "sb-row" },
                h("span", null, "слот"),
                h(
                  "div",
                  { class: "sb-opts" },
                  slots === null ? h("span", { class: "sb-note" }, "…") : null,
                  Object.entries(slots ?? {}).map(([n, sl]) =>
                    h(
                      "button",
                      { class: "sb-b", "aria-pressed": slot === n ? "true" : "false", "data-slot": n, onclick: () => ((slot = n), draw()) },
                      h("b", null, n),
                      h("span", { class: "sb-note" }, [sl.account, `${sl.sessions.length} ${plural(sl.sessions.length, "сессия", "сессии", "сессий")}`, limitOf(sl.account)].filter(Boolean).join(" · ")),
                    ),
                  ),
                  h("button", { class: "sb-b", "aria-pressed": slot === "" ? "true" : "false", onclick: () => ((slot = ""), draw()) }, "без слота — вход машины"),
                ),
              )
            : null,
          can("machine.profiles")
            ? h(
                "div",
                { class: "sb-row" },
                h("span", null, "профиль"),
                h(
                  "div",
                  { class: "sb-opts" },
                  Object.entries(profiles ?? {}).map(([id, p]) =>
                    h("button", { class: "sb-b", "aria-pressed": profile === id ? "true" : "false", "data-profile": id, onclick: () => ((profile = id), draw()) }, id, h("span", { class: "sb-note" }, [p.model, p.effort].filter(Boolean).join(" · "))),
                  ),
                  h("button", { class: "sb-b", "aria-pressed": profile === "" ? "true" : "false", onclick: () => ((profile = ""), draw()) }, "без профиля"),
                ),
              )
            : null,
          h(
            "div",
            { class: "sb-row" },
            h("span", null, "папка"),
            h("div", { class: "sb-opts" }, input("dir", dir, (v) => (dir = v), { size: "36" }), can("machine.dirs") ? h("button", { class: "sb-b", onclick: () => void dirs(dir) }, "Обзор") : null),
          ),
          browse ? drawBrowse() : null,
          h("div", { class: "sb-row" }, h("span", null, "имя"), h("div", { class: "sb-opts" }, input("name", name, (v) => (name = v), { placeholder: "board" }), preview)),
          nameErr ? h("div", { class: "op-err", role: "alert" }, nameErr) : null,
          h("div", { class: "sb-row" }, h("span", null, "модель"), pick(MODELS, model, (v) => (model = v), "по профилю")),
          h("div", { class: "sb-row" }, h("span", null, "усилие"), pick(EFFORTS, effort, (v) => (effort = v), "по профилю")),
          can("session.r2")
            ? h(
                "div",
                { class: "sb-row" },
                h("span", null, "в R2"),
                h(
                  "div",
                  { class: "sb-opts" },
                  h("button", { class: "sb-b", "aria-pressed": r2 ? "false" : "true", "data-r2": "off", onclick: () => ((r2 = false), draw()) }, "выкл"),
                  h("button", { class: "sb-b", "aria-pressed": r2 ? "true" : "false", "data-r2": "on", onclick: () => ((r2 = true), draw()) }, "вкл"),
                  h("span", { class: "sb-note" }, "точки и перенос — только у сессий в R2; включить можно и потом, во вкладке «Точки»"),
                ),
              )
            : null,
          err ? h("div", { class: "op-err", role: "alert" }, err) : null,
          h(
            "div",
            { class: "sb-opts" },
            h("button", { class: "sb-b", onclick: () => app.back() }, "Отмена"),
            h("button", { class: "sb-b pri", disabled: sending || !machine, onclick: () => void open() }, sending ? "Открываю…" : "Открыть сессию"),
          ),
        ),
      );
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLInputElement | null)?.focus();
    }

    function drawBrowse(): HTMLElement {
      const b = browse!;
      const mk = h("input", { class: "sb-in m", "data-f": "mk", placeholder: "новая папка", value: b.mk }) as HTMLInputElement;
      mk.addEventListener("input", () => (b.mk = mk.value));
      const list = b.dirs.filter((d) => b.hidden || !d.startsWith("."));
      return h(
        "div",
        { class: "op-browse" },
        h(
          "div",
          { class: "sb-opts" },
          h("b", { class: "sb-m" }, b.path),
          h("button", { class: "sb-b", onclick: () => void dirs("~") }, "~ Домой"),
          h("button", { class: "sb-b", onclick: () => void dirs(up(b.path)) }, "↑ Вверх"),
          h("button", { class: "sb-b", "aria-pressed": b.hidden ? "true" : "false", onclick: () => ((b.hidden = !b.hidden), draw()) }, "скрытые"),
        ),
        b.err ? h("div", { class: "op-err" }, b.err) : null,
        h("div", { class: "op-dirs" }, list.map((d) => h("button", { class: "sb-b", "data-dir": d, onclick: () => void dirs(join(b.path, d)) }, d))),
        h(
          "div",
          { class: "sb-opts" },
          can("machine.mkdir") ? [mk, h("button", { class: "sb-b", onclick: () => void mkdir() }, "Создать папку")] : null,
          h("button", { class: "sb-b pri", onclick: () => ((dir = b.path), (browse = null), draw()) }, "Выбрать эту папку"),
        ),
      );
    }

    void loadMachine();
    return { head: () => ({ title: "Новая сессия" }), refresh: () => {} };
  }

  return {
    screens: { open: { nav: "＋ Новая сессия", label: "Новая сессия", mount } },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
