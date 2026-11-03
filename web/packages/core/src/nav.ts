// Разделы приложения: порядок, группы, метки-счётчики, поиск Ctrl K и шапка экрана. Читает реестр, состояния не держит.
import type { ScreenEntry } from "./mod.ts";
import type { Registry } from "./registry.ts";
import type { Head, Params, Screen } from "./types.ts";

export type Hit = { label: string; hint?: string; dot?: string; screen: string; params: Params };
export type Nav = ReturnType<typeof createNav>;

export function createNav(registry: Registry, o: { wide: boolean; sections?: string[] }) {
  const { screens, call, usesRef } = registry;
  const groupOf = (d: Screen) => (o.wide ? d.group : (d.narrowGroup ?? d.group));

  /** Разделы по порядку: сначала по sections оболочки, остальные — следом в порядке списка модулей. */
  function sections(): Array<[string, ScreenEntry]> {
    const rank = (n: string) => {
      const i = o.sections?.indexOf(n) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...screens].filter(([, s]) => s.def.nav && s.def.place !== "top").sort(([a], [b]) => rank(a) - rank(b));
  }

  /** Поиск: разделы и то, что экраны отдают в find. */
  function hits(q: string): Hit[] {
    const ql = q.trim().toLowerCase();
    const out: Hit[] = [];
    for (const [n, s] of screens) {
      if (s.owner.failed || s.def.place === "top") continue;
      if (s.def.nav && (!ql || s.def.nav.toLowerCase().includes(ql))) out.push({ label: s.def.nav, hint: groupOf(s.def) ?? "раздел", screen: n, params: {} });
      if (!s.def.find) continue;
      for (const x of call(s.owner, `экране ${n}`, () => s.def.find!(ql)) ?? []) {
        // строка ведёт на экран своего модуля или экран из его uses
        if (s.owner.mod.screens?.[x.screen] === undefined && !usesRef(s.owner, x.screen)) continue;
        out.push({ label: x.label, hint: x.hint, dot: x.dot, screen: x.screen, params: x.params ?? {} });
      }
    }
    return out.slice(0, 40);
  }

  return {
    groupOf,
    sections,
    /** Домашний раздел: первый раздел или первый экран. */
    home: (): string => sections()[0]?.[0] ?? [...screens.keys()][0] ?? "",
    hits,
    /** Счёт метки раздела: число > 0 или null. */
    countOf(s: ScreenEntry): number | null {
      const c = s.def.mark && !s.owner.failed ? call(s.owner, `метке ${s.def.mark}`, () => s.owner.mod.marks![s.def.mark!]()) : undefined;
      return typeof c === "number" && c > 0 ? c : null;
    },
    head(screen: string, params: Params): Head {
      const s = screens.get(screen);
      return (s?.def.head && call(s.owner, `экране ${screen}`, () => s.def.head!(params))) || { title: s?.def.nav ?? s?.def.label ?? "" };
    },
  };
}
