// Зависимости внутри набора: список сборки и циклы. Стрелка — от модуля к владельцам его uses.
import { ownerOf, type Manifest } from "./manifest.ts";

/** Владельцы uses модуля из набора, кроме него самого. */
const ownersIn = (m: Manifest, names: Set<string>) => [...new Set(Object.keys(m.uses).map(ownerOf))].filter((o) => o !== m.name && names.has(o));

/**
 * Список сборки: модуль — после владельцев своих uses из набора; из готовых — первым по имени.
 * Цикл упорядочить нельзя: его модули встают по имени, а cycles называет цикл.
 */
export function order<T extends Manifest>(mods: T[]): T[] {
  const names = new Set(mods.map((m) => m.name));
  const left = [...mods].sort((a, b) => (a.name < b.name ? -1 : 1));
  const placed = new Set<string>();
  const out: T[] = [];
  while (left.length) {
    const ready = left.findIndex((m) => ownersIn(m, names).every((o) => placed.has(o)));
    const [next] = left.splice(Math.max(ready, 0), 1);
    out.push(next);
    placed.add(next.name);
  }
  return out;
}

/** Пути по uses из модуля обратно в него: каждый цикл — один раз. */
export function cycles(mods: Manifest[]): string[][] {
  const byName = new Map(mods.map((m) => [m.name, m]));
  const names = new Set(byName.keys());
  const found: string[][] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const walk = (name: string): void => {
    const at = path.indexOf(name);
    if (at >= 0) return void found.push([...path.slice(at), name]);
    if (done.has(name)) return;
    path.push(name);
    for (const o of ownersIn(byName.get(name)!, names)) walk(o);
    path.pop();
    done.add(name);
  };
  for (const m of mods) walk(m.name);
  return found;
}
