export type ConfigKind = "secret" | "var" | "binding";

export type Manifest = {
  name: string;
  type: string;
  version: string;
  /** имя контракта → версия */
  provides: Record<string, number>;
  /** "имя@владелец" → версия */
  uses: Record<string, number>;
  config: Record<string, ConfigKind>;
  /** приложения, в которые модуль входит: корни сборок — ядро Host или оболочка страницы */
  into?: string[];
  /** пакеты @switchboard/*, которые импортирует код модуля (без тестов) — заполняет loadRepo */
  imports?: string[];
  /** имя npm-пакета модуля — заполняет loadRepo */
  pkg?: string;
};

/** Ссылка манифеста «имя@владелец»: имя и владелец. Одно правило для гейта, ядра Host и ядра веба. */
export const nameOf = (ref: string) => ref.slice(0, ref.lastIndexOf("@"));
export const ownerOf = (ref: string) => ref.slice(ref.lastIndexOf("@") + 1);

/** Тип модуля → тип корня приложения, в которое он входит. Другие типы ни во что не входят. */
const ROOT: Record<string, string> = { sdk: "sdk-core", web: "web-app" };

/** Проверить набор модулей. Пустой список — набор годен; иначе — причины словами. */
export function check(mods: Manifest[]): string[] {
  const errors: string[] = [];
  const byName = new Map<string, Manifest>();
  for (const m of mods) {
    if (byName.has(m.name)) errors.push(`модуль ${m.name}: имя уже занято`);
    byName.set(m.name, m);
  }

  // у имени контракта один владелец
  const owner = new Map<string, string>();
  for (const m of mods) {
    for (const n of Object.keys(m.provides)) {
      const o = owner.get(n);
      if (o && o !== m.name) errors.push(`имя ${n}: два владельца — ${o} и ${m.name}`);
      else owner.set(n, m.name);
    }
  }

  // uses: владелец есть и отдаёт имя той же версии
  for (const m of mods) {
    for (const [ref, v] of Object.entries(m.uses)) {
      if (ref.lastIndexOf("@") <= 0) {
        errors.push(`модуль ${m.name}: uses «${ref}» — нужно имя@владелец`);
        continue;
      }
      const n = nameOf(ref);
      const o = byName.get(ownerOf(ref));
      if (!o) errors.push(`модуль ${m.name}: uses ${ref} — владельца нет в наборе`);
      else if (o.provides[n] === undefined) errors.push(`модуль ${m.name}: uses ${ref} — ${o.name} не отдаёт ${n}`);
      else if (o.provides[n] !== v) errors.push(`модуль ${m.name}: uses ${ref} v${v} — у владельца v${o.provides[n]}`);
    }
  }

  // into: каждое приложение — корень сборки типа модуля в наборе
  for (const m of mods) {
    for (const app of m.into ?? []) {
      const o = byName.get(app);
      if (!ROOT[m.type]) errors.push(`модуль ${m.name}: into у типа ${m.type} не бывает`);
      else if (!o) errors.push(`модуль ${m.name}: into ${app} — такого приложения нет в наборе`);
      else if (o.type !== ROOT[m.type]) errors.push(`модуль ${m.name}: into ${app} — ${app} не ${ROOT[m.type]}`);
    }
  }

  // импорт — только контракта и только из uses (protocol — общий у всех)
  const byPkg = new Map<string, Manifest>();
  for (const m of mods) if (m.pkg) byPkg.set(m.pkg, m);
  for (const m of mods) {
    const allowed = new Set(Object.keys(m.uses).map((r) => r.slice(r.lastIndexOf("@") + 1)));
    for (const spec of m.imports ?? []) {
      const pkg = spec.split("/").slice(0, 2).join("/");
      if (pkg === "@switchboard/protocol" && spec === pkg) continue;
      const o = byPkg.get(pkg);
      if (!o) {
        errors.push(`модуль ${m.name}: импорт ${spec} — такого модуля нет`);
        continue;
      }
      if (o.name === m.name) continue;
      if (!allowed.has(o.name)) errors.push(`модуль ${m.name}: импорт ${spec} — ${o.name} нет в uses`);
      else if (spec !== pkg) errors.push(`модуль ${m.name}: импорт ${spec} — мимо контракта ${pkg}`);
    }
  }

  // секрет — в config одного модуля
  const secretOf = new Map<string, string>();
  for (const m of mods) {
    for (const [k, kind] of Object.entries(m.config)) {
      if (kind !== "secret") continue;
      const o = secretOf.get(k);
      if (o) errors.push(`секрет ${k}: в config двух модулей — ${o} и ${m.name}`);
      else secretOf.set(k, m.name);
    }
  }
  return errors;
}
