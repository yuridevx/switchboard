// Суд над набором манифестов: ссылка на чужое имя, порядок зависимостей, нарушения словами. Файлов не читает: идёт и на странице, и в Worker.
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
  /** Модуль-контракт, чьи имена этот модуль исполняет: владелец имён — контракт, во флоте стоит одна его реализация. */
  implements?: string;
  /**
   * Инструменты MCP: запрос из provides виден инструментом с именем запроса через _ вместо точки. type — тип запроса в contract.ts,
   * схему входа input из него строит упаковка; omit — поля типа, которых в схеме нет.
   */
  tools?: Record<string, Tool>;
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
  /** Типы, которые отдаёт contract.ts модуля. */
  types?: string[];
};

export type Tool = { about: string; type: string; omit?: string[]; input?: Record<string, unknown> };

/** Тип модуля, который входит в сборку, → тип её корня. */
const ROOT: Record<string, string> = { sdk: "sdk-core", web: "web-app" };
/** Конверт кадра знают все: пакет протокола идёт без uses. */
const PROTOCOL = "@switchboard/protocol";

export const nameOf = (ref: string) => ref.replace(/@[^@]*$/, "");
export const ownerOf = (ref: string) => /@([^@]*)$/.exec(ref)?.[1] ?? "";
/** Чужие владельцы имён из uses и исполняемый контракт: своё имя зависимостью не бывает. */
const ownersOf = (m: Manifest) => [...Object.keys(m.uses).map(ownerOf), ...(m.implements ? [m.implements] : [])].filter((owner) => owner !== m.name);
/** Модуль-контракт: только имена и типы, без кода и выкладки; исполняют его модули с implements. */
const CONTRACT = "contract";

/** Владелец раньше того, кто им пользуется; из готовых — первый по имени. Цикл не чинит: его называет check. */
export function order<T extends Manifest>(mods: T[]): T[] {
  const left = [...mods].sort((a, b) => a.name.localeCompare(b.name));
  const out: T[] = [];
  while (left.length) {
    const waiting = new Set(left.map((m) => m.name));
    const ready = left.findIndex((m) => !ownersOf(m).some((owner) => waiting.has(owner)));
    out.push(...left.splice(Math.max(ready, 0), 1));
  }
  return out;
}

/** Имя модуля, имя контракта и секрет — у одного владельца. */
function claims(mods: Manifest[]): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  const owners = new Map<string, string>();
  const secrets = new Map<string, string>();
  const claim = (seen: Map<string, string>, key: string, who: string, word: (first: string) => string) => {
    const first = seen.get(key) ?? who;
    seen.set(key, first);
    if (first !== who) out.push(word(first));
  };
  for (const m of mods) {
    if (names.has(m.name)) out.push(`модуль ${m.name}: имя уже занято`);
    names.add(m.name);
    for (const name of Object.keys(m.provides)) claim(owners, name, m.name, (first) => `имя ${name}: два владельца — ${first} и ${m.name}`);
    for (const [key, kind] of Object.entries(m.config)) if (kind === "secret") claim(secrets, key, m.name, (first) => `секрет ${key}: в config двух модулей — ${first} и ${m.name}`);
  }
  return out;
}

function cycles(byName: Map<string, Manifest>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (m: Manifest, path: string[]) => {
    const from = path.indexOf(m.name);
    if (from >= 0) return void out.push(`цикл зависимостей: ${[...path.slice(from), m.name].join(" → ")}`);
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const owner of ownersOf(m)) {
      const next = byName.get(owner);
      if (next) walk(next, [...path, m.name]);
    }
  };
  for (const m of byName.values()) walk(m, []);
  return out;
}

/** Что не так в одном модуле: манифест против набора, факты кода против манифеста. */
function faults(m: Manifest, byName: Map<string, Manifest>, byPkg: Map<string | undefined, Manifest>): (string | undefined)[] {
  const uses = ([ref, version]: [string, number]) => {
    const name = nameOf(ref);
    const owner = ownerOf(ref);
    if (!name || !owner) return `uses «${ref}» — нужно имя@владелец`;
    const target = byName.get(owner);
    if (!target) return `uses ${ref} — владельца нет в наборе`;
    const has = target.provides[name];
    if (!has) return `uses ${ref} — ${owner} не отдаёт ${name}`;
    return has === version ? undefined : `uses ${ref} v${version} — у владельца v${has}`;
  };
  const entered = (spec: string, owner: string, entry: boolean, front: string) => {
    if (!ownersOf(m).includes(owner)) return `импорт ${spec} — ${owner} нет в uses`;
    return entry ? undefined : `импорт ${spec} — мимо контракта ${front}`;
  };
  const imported = (spec: string) => {
    const pkg = spec.split("/").slice(0, 2).join("/");
    const owner = byPkg.get(pkg);
    if (spec === PROTOCOL || owner?.name === m.name) return undefined;
    return owner ? entered(spec, owner.name, spec === pkg, pkg) : `импорт ${spec} — такого модуля нет`;
  };
  const reached = (spec: string) => {
    const owner = spec.split("/")[0];
    return entered(spec, owner, spec === `${owner}/contract.ts`, owner);
  };
  /** Вызов привязки владелец.метод — имя контракта владельца с последним словом «метод»: env.GATE.list — keys.list у gate. */
  const called = (call: string) => {
    const [owner, method] = call.split(".");
    const provides = owner !== m.name ? byName.get(owner)?.provides : undefined;
    const name = provides && Object.keys(provides).find((n) => n === call || n.endsWith(`.${method}`));
    return name && !m.uses[`${name}@${owner}`] ? `зовёт ${name} — нет в uses` : undefined;
  };
  const into = (root: string) => {
    const want = ROOT[m.type];
    if (!want) return `into у типа ${m.type} не бывает`;
    const target = byName.get(root);
    if (!target) return `into ${root} — такого приложения нет в наборе`;
    return target.type === want ? undefined : `into ${root} — ${root} не ${want}`;
  };
  /** Реализация отвечает ровно на имена контракта: код берёт CONTRACT его пакета, полноту ключей держит тип. */
  const implemented = () => {
    if (m.type === CONTRACT) return Object.keys(m.config).length || Object.keys(m.uses).length || m.implements ? "у модуля-контракта нет config, uses и implements" : undefined;
    if (!m.implements) return undefined;
    const target = byName.get(m.implements);
    if (!target) return `implements ${m.implements} — такого модуля нет в наборе`;
    if (target.type !== CONTRACT) return `implements ${m.implements} — не модуль-контракт`;
    if (Object.keys(m.provides).length) return `implements ${m.implements} — своих provides у реализации нет`;
    return m.imports && !m.imports.includes(target.pkg ?? "") ? `implements ${m.implements} — код не берёт контракт ${target.pkg}` : undefined;
  };
  const tooled = ([name, t]: [string, Tool]) => {
    if (!m.provides[name]) return `tool у ${name} — такого запроса в provides нет`;
    if (typeof t?.about !== "string" || !t.about.trim() || typeof t.type !== "string") return `tool у ${name} — нужны about и type`;
    return m.types && !m.types.includes(t.type) ? `tool у ${name} — типа ${t.type} нет в contract.ts` : undefined;
  };
  return [
    implemented(),
    ...Object.entries(m.tools ?? {}).map(tooled),
    ...Object.entries(m.uses).map(uses),
    ...(m.imports ?? []).map(imported),
    ...(m.reach ?? []).map(reached),
    ...(m.testReach ?? []).map((spec) => `тест импортирует ${spec} — мимо контракта ${spec.split("/")[0]}`),
    ...(m.rpc ?? []).map(called),
    ...(m.into ?? []).map(into),
  ];
}

/** Годный набор — пустой список; иначе причины словами. */
export function check(mods: Manifest[]): string[] {
  const byName = new Map(mods.map((m) => [m.name, m]));
  const byPkg = new Map(mods.map((m) => [m.pkg, m]));
  const inModules = mods.flatMap((m) => faults(m, byName, byPkg).flatMap((word) => (word ? [`модуль ${m.name}: ${word}`] : [])));
  return [...claims(mods), ...inModules, ...cycles(byName)];
}

/** Суд над частью флота, которая не видит остальных: ссылка на владельца вне mods отброшена, её сверяет получатель. */
export function checkSet(mods: Manifest[]): string[] {
  const here = new Set(mods.map((m) => m.name));
  return check(mods.map((m) => ({ ...m, uses: Object.fromEntries(Object.entries(m.uses).filter(([ref]) => here.has(ownerOf(ref)))) })));
}
