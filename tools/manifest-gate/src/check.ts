// Правила набора модулей. Каждое правило смотрит на весь набор и называет нарушения словами.
import { cycles } from "./graph.ts";
import { nameOf, ownerOf, type Manifest } from "./manifest.ts";

type Rule = (mods: Manifest[], byName: Map<string, Manifest>) => string[];

/** Тип модуля → тип корня приложения, в которое он входит. Другие типы ни во что не входят. */
const ROOT: Record<string, string> = { sdk: "sdk-core", web: "web-app" };
/** Конверт кадра общий у всех: его можно импортировать без uses. */
const PROTOCOL = "@switchboard/protocol";

const uniqueNames: Rule = (mods) => {
  const seen = new Set<string>();
  return mods.flatMap((m) => {
    const taken = seen.has(m.name);
    seen.add(m.name);
    return taken ? [`модуль ${m.name}: имя уже занято`] : [];
  });
};

const oneOwner: Rule = (mods) => {
  const owner = new Map<string, string>();
  return mods.flatMap((m) =>
    Object.keys(m.provides).flatMap((n) => {
      const o = owner.get(n);
      if (o && o !== m.name) return [`имя ${n}: два владельца — ${o} и ${m.name}`];
      owner.set(n, m.name);
      return [];
    }),
  );
};

const usesMatch: Rule = (mods, byName) =>
  mods.flatMap((m) =>
    Object.entries(m.uses).flatMap(([ref, version]) => {
      if (ref.lastIndexOf("@") <= 0) return [`модуль ${m.name}: uses «${ref}» — нужно имя@владелец`];
      const name = nameOf(ref);
      const owner = byName.get(ownerOf(ref));
      if (!owner) return [`модуль ${m.name}: uses ${ref} — владельца нет в наборе`];
      if (owner.provides[name] === undefined) return [`модуль ${m.name}: uses ${ref} — ${owner.name} не отдаёт ${name}`];
      if (owner.provides[name] !== version) return [`модуль ${m.name}: uses ${ref} v${version} — у владельца v${owner.provides[name]}`];
      return [];
    }),
  );

const noCycles: Rule = (mods) => cycles(mods).map((path) => `цикл зависимостей: ${path.join(" → ")}`);

const intoRoot: Rule = (mods, byName) =>
  mods.flatMap((m) =>
    (m.into ?? []).flatMap((app) => {
      const root = ROOT[m.type];
      if (!root) return [`модуль ${m.name}: into у типа ${m.type} не бывает`];
      const target = byName.get(app);
      if (!target) return [`модуль ${m.name}: into ${app} — такого приложения нет в наборе`];
      return target.type === root ? [] : [`модуль ${m.name}: into ${app} — ${app} не ${root}`];
    }),
  );

/** Импорт — только контракта и только из uses. */
const importsDeclared: Rule = (mods) => {
  const byPkg = new Map(mods.flatMap((m) => (m.pkg ? [[m.pkg, m] as const] : [])));
  return mods.flatMap((m) => {
    const declared = new Set(Object.keys(m.uses).map(ownerOf));
    return (m.imports ?? []).flatMap((spec) => {
      if (spec === PROTOCOL) return [];
      const pkg = spec.split("/").slice(0, 2).join("/");
      const target = byPkg.get(pkg);
      if (!target) return [`модуль ${m.name}: импорт ${spec} — такого модуля нет`];
      if (target.name === m.name) return [];
      if (!declared.has(target.name)) return [`модуль ${m.name}: импорт ${spec} — ${target.name} нет в uses`];
      return spec === pkg ? [] : [`модуль ${m.name}: импорт ${spec} — мимо контракта ${pkg}`];
    });
  });
};

/** Вызов через привязку Worker'а виден только в коде: Host и страница проверяют uses сами при вызове, Worker — нет. */
const callsDeclared: Rule = (mods, byName) =>
  mods.flatMap((m) =>
    (m.calls ?? []).flatMap((name) => {
      const owner = byName.get(name.slice(0, name.indexOf(".")));
      if (!owner || owner.name === m.name || owner.provides[name] === undefined) return [];
      return m.uses[`${name}@${owner.name}`] === undefined ? [`модуль ${m.name}: зовёт ${name} — нет в uses`] : [];
    }),
  );

const TEST_MAY_REACH = (path: string) => path === "contract.ts" || path === "module.json" || path.startsWith("stand/");

/** Импорт в чужую папку: коду — контракт из uses; тесту и стенду — контракт, манифест и стенд без uses. */
const reachThroughContract: Rule = (mods) =>
  mods.flatMap((m) => {
    const declared = new Set(Object.keys(m.uses).map(ownerOf));
    return (m.reach ?? []).flatMap(({ to, path, test }) => {
      if (test) return TEST_MAY_REACH(path) ? [] : [`модуль ${m.name}: тест импортирует ${to}/${path} — мимо контракта ${to}`];
      if (!declared.has(to)) return [`модуль ${m.name}: импорт ${to}/${path} — ${to} нет в uses`];
      return path === "contract.ts" ? [] : [`модуль ${m.name}: импорт ${to}/${path} — мимо контракта ${to}`];
    });
  });

const secretOneOwner: Rule = (mods) => {
  const owner = new Map<string, string>();
  return mods.flatMap((m) =>
    Object.entries(m.config).flatMap(([key, kind]) => {
      if (kind !== "secret") return [];
      const o = owner.get(key);
      if (o) return [`секрет ${key}: в config двух модулей — ${o} и ${m.name}`];
      owner.set(key, m.name);
      return [];
    }),
  );
};

const RULES = [uniqueNames, oneOwner, usesMatch, noCycles, intoRoot, importsDeclared, callsDeclared, reachThroughContract, secretOneOwner];

/** Проверить набор модулей. Пустой список — набор годен; иначе — причины словами. */
export function check(mods: Manifest[]): string[] {
  const byName = new Map(mods.map((m) => [m.name, m]));
  return RULES.flatMap((rule) => rule(mods, byName));
}
