// Манифест модуля, ссылка на чужое имя и порядок зависимостей.
export type Manifest = {
  name: string;
  type: string;
  version: string;
  provides: Record<string, number>;
  /** Ключ — ссылка `имя@владелец`, значение — версия имени. */
  uses: Record<string, number>;
  config: Record<string, "secret" | "var" | "binding">;
  /** Корни сборки, в которые модуль входит. */
  into?: string[];
  pkg?: string;
  // Факты кода; их кладёт loadRepo, манифест из каталога или сборки их не несёт.
  /** Пакеты @switchboard, которые импортирует код. */
  imports?: string[];
  /** Чужие файлы, куда код идёт относительным путём: `модуль/путь`. */
  reach?: string[];
  /** Чужие файлы, куда тест или стенд идёт мимо контракта: `модуль/путь`. */
  testReach?: string[];
  /** Вызовы привязок Worker: `env.GATE.verify()` — `gate.verify`. */
  rpc?: string[];
};

const at = (ref: string) => {
  const i = ref.lastIndexOf("@");
  return i < 0 ? ref.length : i;
};
export const nameOf = (ref: string) => ref.slice(0, at(ref));
export const ownerOf = (ref: string) => ref.slice(at(ref) + 1);

/** Модули набора, чьими именами пользуется этот. */
export const needs = (m: Manifest, set: { has(name: string): boolean }) => Object.keys(m.uses).map(ownerOf).filter((o) => o !== m.name && set.has(o));

/** Владелец раньше, из готовых первым по имени. В цикле готовых нет: берётся первый, а цикл называет check. */
export function order<T extends Manifest>(mods: T[]): T[] {
  const names = new Set(mods.map((m) => m.name));
  const rest = [...mods].sort((a, b) => (a.name < b.name ? -1 : 1));
  const done = new Set<string>();
  const out: T[] = [];
  while (rest.length) {
    const ready = rest.findIndex((m) => needs(m, names).every((o) => done.has(o)));
    const [m] = rest.splice(Math.max(ready, 0), 1);
    done.add(m.name);
    out.push(m);
  }
  return out;
}
