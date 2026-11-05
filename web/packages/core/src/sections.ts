// Разделы приложения: порядок, группы, счётчики, поиск и шапка экрана. Читает модули, состояния не держит.
import type { Modules, ScreenEntry } from "./modules.ts";
import type { Head, Params, Screen } from "./types.ts";

export type Hit = { label: string; hint?: string; dot?: string; screen: string; params: Params };
export type Sections = ReturnType<typeof createSections>;

const MAX_HITS = 40;

export function createSections(modules: Modules, o: { wide: boolean; order?: string[] }) {
  const { screens, call, usesRef } = modules;
  const groupOf = (d: Screen) => (o.wide ? d.group : (d.narrowGroup ?? d.group));

  /** Разделы по порядку оболочки, остальные — следом в порядке списка модулей. */
  function all(): Array<[string, ScreenEntry]> {
    const rank = (n: string) => {
      const i = o.order?.indexOf(n) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...screens].filter(([, s]) => s.def.nav && s.def.place !== "top").sort(([a], [b]) => rank(a) - rank(b));
  }

  /** Строки поиска одного экрана: своя и то, что он отдал в find; строка ведёт на его экран или экран из uses. */
  function hitsOf(name: string, s: ScreenEntry, q: string): Hit[] {
    const out: Hit[] = [];
    if (s.def.nav && (!q || s.def.nav.toLowerCase().includes(q))) out.push({ label: s.def.nav, hint: groupOf(s.def) ?? "раздел", screen: name, params: {} });
    if (!s.def.find) return out;
    for (const x of call(s.owner, `экране ${name}`, () => s.def.find!(q)) ?? []) {
      if (s.owner.mod.screens?.[x.screen] !== undefined || usesRef(s.owner, x.screen)) out.push({ label: x.label, hint: x.hint, dot: x.dot, screen: x.screen, params: x.params ?? {} });
    }
    return out;
  }

  return {
    all,
    groupOf,
    /** Домашний раздел: первый раздел или первый экран. */
    home: (): string => all()[0]?.[0] ?? [...screens.keys()][0] ?? "",
    hits(query: string): Hit[] {
      const q = query.trim().toLowerCase();
      return [...screens]
        .filter(([, s]) => !s.owner.failed && s.def.place !== "top")
        .flatMap(([n, s]) => hitsOf(n, s, q))
        .slice(0, MAX_HITS);
    },
    /** Счёт метки раздела: число больше нуля или null. */
    countOf(s: ScreenEntry): number | null {
      if (!s.def.mark || s.owner.failed) return null;
      const n = call(s.owner, `метке ${s.def.mark}`, () => s.owner.mod.marks![s.def.mark!]());
      return typeof n === "number" && n > 0 ? n : null;
    },
    head(screen: string, params: Params): Head {
      const s = screens.get(screen);
      return (s?.def.head && call(s.owner, `экране ${screen}`, () => s.def.head!(params))) || { title: s?.def.nav ?? s?.def.label ?? "" };
    },
  };
}
