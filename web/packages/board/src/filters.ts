// Окно фильтра: имя, одна строка поиска на все поля, поля «Чьи · Проекты · Машины · Профили · Состояние». Совпадения поиска — в каждом поле;
// выбранное видно всегда; поле без совпадений свёрнуто. Снизу — сколько подходит. Хранит список модуль, здесь — только правка копии.
import { h, plural, projectOf, type SessionRecord } from "@switchboard/web-core";
import { FIELDS, profileOf, type Field, type Filter } from "./rules.ts";
import { machineOf } from "@switchboard/protocol";

const STATES: Array<[string, string]> = [
  ["waiting", "ждёт вас"],
  ["busy", "работает"],
  ["idle", "свободна"],
  ["failed", "не запустилась"],
  ["stopped", "остановлена"],
];

export type EditorCtx = {
  sessions(): SessionRecord[];
  machines(): string[];
  mName(machine: string): string;
  owners(): string[];
  match(f: Filter, s: SessionRecord): boolean;
};

/** Варианты поля: значение и подпись. */
function options(ctx: EditorCtx, k: Field): Array<[string, string]> {
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  if (k === "who") return [["mine", "моё"], ...ctx.owners().map((o): [string, string] => [o, o.slice(1)])];
  if (k === "projects") return uniq(ctx.sessions().map((s) => projectOf(s.dir))).map((x) => [x, x]);
  if (k === "machines") return uniq([...ctx.machines(), ...ctx.sessions().map((s) => machineOf(s.callsign) ?? "")]).map((m) => [m, ctx.mName(m)]);
  if (k === "profiles") return uniq(ctx.sessions().map(profileOf)).map((x) => [x, x]);
  return STATES;
}

/** Окно фильтра: base — правка своего, null — новый; save и remove закрывают сами. */
export function filterEditor(ctx: EditorCtx, base: Filter | null, o: { save(f: Filter): void; remove(id: string): void; close(): void }): HTMLElement {
  const f: Filter = { id: base?.id ?? "", name: base?.name ?? "", who: [...(base?.who ?? [])], projects: [...(base?.projects ?? [])], machines: [...(base?.machines ?? [])], profiles: [...(base?.profiles ?? [])], states: [...(base?.states ?? [])] };
  let q = "";
  const name = h("input", { class: "fe-name", "data-f": "name", value: f.name, placeholder: "Имя фильтра", autocomplete: "off", "aria-label": "Имя фильтра" }) as HTMLInputElement;
  const find = h("input", { class: "fe-q", "data-f": "q", placeholder: "Найти: люди, проекты, машины…", autocomplete: "off", "aria-label": "Найти в фильтре" }) as HTMLInputElement;
  const fields = h("div", { class: "fe-fs" });
  const count = h("span", { class: "fe-n" });
  const saveB = h("button", { class: "sb-b pri", "data-act": "fsave", onclick: () => save() }, "Сохранить") as HTMLButtonElement;

  function save() {
    const clean: Filter = { id: f.id || `f${Date.now().toString(36)}`, name: f.name.trim() };
    for (const [k] of FIELDS) if (f[k]?.length) clean[k] = f[k];
    o.save(clean);
  }

  function foot() {
    const hit = ctx.sessions().filter((s) => ctx.match(f, s));
    const np = new Set(hit.map((s) => projectOf(s.dir))).size;
    count.textContent = `подходит ${hit.length} ${plural(hit.length, "сессия", "сессии", "сессий")} · ${np} ${plural(np, "проект", "проекта", "проектов")}`;
    saveB.disabled = !f.name.trim();
  }

  function draw() {
    const ql = q.trim().toLowerCase();
    const scroll = fields.scrollTop;
    fields.textContent = "";
    let found = 0;
    for (const [k, label] of FIELDS) {
      const sel = f[k] ?? [];
      const shown = options(ctx, k).filter(([v, l]) => sel.includes(v) || !ql || l.toLowerCase().includes(ql));
      found += shown.filter(([v]) => !sel.includes(v)).length;
      if (ql && !shown.length) continue;
      fields.append(
        h(
          "div",
          { class: "fe-f", "data-field": k },
          h("div", { class: "fe-l" }, h("b", null, label), sel.length ? h("span", null, String(sel.length)) : null),
          h(
            "div",
            { class: "fe-c" },
            shown.map(([v, l]) =>
              h(
                "button",
                {
                  "aria-pressed": String(sel.includes(v)),
                  "data-v": v,
                  onclick: () => {
                    f[k] = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v];
                    draw();
                  },
                },
                l,
              ),
            ),
          ),
        ),
      );
    }
    if (ql && !found) fields.append(h("div", { class: "fe-none" }, "ничего"));
    fields.scrollTop = scroll;
    foot();
  }

  name.addEventListener("input", () => {
    f.name = name.value;
    foot();
  });
  find.addEventListener("input", () => {
    q = find.value;
    draw();
  });
  const veil = h(
    "div",
    { class: "bd-veil", "data-editor": "1" },
    h(
      "div",
      { class: "bd-dlg", role: "dialog", "aria-label": "Фильтр" },
      h("div", { class: "fe-h" }, h("b", null, base ? "Фильтр" : "Новый фильтр")),
      h("div", { class: "fe-b" }, name, find, fields),
      h(
        "div",
        { class: "fe-ft" },
        count,
        base ? h("button", { class: "sb-b bad", "data-act": "fdel", onclick: () => o.remove(f.id) }, "Удалить") : null,
        h("button", { class: "sb-b", onclick: o.close }, "Отмена"),
        saveB,
      ),
    ),
  );
  veil.addEventListener("click", (e) => e.target === veil && o.close());
  veil.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Escape" && o.close());
  draw();
  if (!base) queueMicrotask(() => name.focus());
  return veil;
}
