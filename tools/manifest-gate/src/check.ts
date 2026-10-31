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
  /** пакеты @switchboard/*, которые импортирует код модуля (без тестов) — заполняет loadRepo */
  imports?: string[];
  /** имя npm-пакета модуля — заполняет loadRepo */
  pkg?: string;
};

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
      const at = ref.lastIndexOf("@");
      if (at <= 0) {
        errors.push(`модуль ${m.name}: uses «${ref}» — нужно имя@владелец`);
        continue;
      }
      const n = ref.slice(0, at);
      const o = byName.get(ref.slice(at + 1));
      if (!o) errors.push(`модуль ${m.name}: uses ${ref} — владельца нет в наборе`);
      else if (o.provides[n] === undefined) errors.push(`модуль ${m.name}: uses ${ref} — ${o.name} не отдаёт ${n}`);
      else if (o.provides[n] !== v) errors.push(`модуль ${m.name}: uses ${ref} v${v} — у владельца v${o.provides[n]}`);
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
