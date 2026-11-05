// Правила набора модулей: пустой список — годен, иначе причины словами. Файлов не читает: идёт и в браузере.
import { needs, nameOf, ownerOf, type Manifest } from "./manifest.ts";

/** Конверт кадра общий у всех: его импортируют без uses. */
const PROTOCOL = "@switchboard/protocol";
/** Какого типа корень сборки у модуля этого типа. */
const ROOT_OF: Record<string, string> = { sdk: "sdk-core", web: "web-app" };

/** Первый занявший ключ остаётся; второй — причина. */
function claim(held: Map<string, string>, key: string, who: string, word: string, out: string[]) {
  const first = held.get(key);
  if (first === undefined) held.set(key, who);
  else out.push(`${word} — ${first} и ${who}`);
}

function cycles(byName: Map<string, Manifest>): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (name: string) => {
    const seen = path.indexOf(name);
    if (seen >= 0) out.push(`цикл зависимостей: ${[...path.slice(seen), name].join(" → ")}`);
    if (seen >= 0 || done.has(name)) return;
    path.push(name);
    needs(byName.get(name)!, byName).forEach(visit);
    path.pop();
    done.add(name);
  };
  [...byName.keys()].forEach(visit);
  return out;
}

export function check(mods: Manifest[]): string[] {
  const out: string[] = [];
  const byName = new Map<string, Manifest>();
  const owners = new Map<string, string>();
  const secrets = new Map<string, string>();
  for (const m of mods) {
    if (byName.has(m.name)) {
      out.push(`модуль ${m.name}: имя уже занято`);
      continue;
    }
    byName.set(m.name, m);
    for (const name of Object.keys(m.provides)) claim(owners, name, m.name, `имя ${name}: два владельца`, out);
    for (const [key, kind] of Object.entries(m.config)) if (kind === "secret") claim(secrets, key, m.name, `секрет ${key}: в config двух модулей`, out);
  }
  const byPkg = new Map([...byName.values()].map((m) => [m.pkg, m]));

  for (const m of byName.values()) {
    const fault = (word: string) => out.push(`модуль ${m.name}: ${word}`);
    const declared = new Set(Object.keys(m.uses).map(ownerOf));

    for (const [ref, version] of Object.entries(m.uses)) {
      const name = nameOf(ref);
      const owner = ownerOf(ref);
      const held = byName.get(owner)?.provides[name];
      if (!name || !owner) fault(`uses «${ref}» — нужно имя@владелец`);
      else if (!byName.has(owner)) fault(`uses ${ref} — владельца нет в наборе`);
      else if (held === undefined) fault(`uses ${ref} — ${owner} не отдаёт ${name}`);
      else if (held !== version) fault(`uses ${ref} v${version} — у владельца v${held}`);
    }

    for (const app of m.into ?? []) {
      const root = ROOT_OF[m.type];
      const target = byName.get(app);
      if (!root) fault(`into у типа ${m.type} не бывает`);
      else if (!target) fault(`into ${app} — такого приложения нет в наборе`);
      else if (target.type !== root) fault(`into ${app} — ${app} не ${root}`);
    }

    for (const spec of m.imports ?? []) {
      const pkg = spec.split("/").slice(0, 2).join("/");
      const owner = byPkg.get(pkg);
      if (pkg === m.pkg || spec === PROTOCOL) continue;
      if (!owner) fault(`импорт ${spec} — такого модуля нет`);
      else if (!declared.has(owner.name)) fault(`импорт ${spec} — ${owner.name} нет в uses`);
      else if (spec !== pkg) fault(`импорт ${spec} — мимо контракта ${pkg}`);
    }

    for (const file of m.reach ?? []) {
      const [owner] = file.split("/");
      if (!declared.has(owner)) fault(`импорт ${file} — ${owner} нет в uses`);
      else if (file !== `${owner}/contract.ts`) fault(`импорт ${file} — мимо контракта ${owner}`);
    }

    for (const file of m.testReach ?? []) fault(`тест импортирует ${file} — мимо контракта ${file.split("/")[0]}`);

    for (const name of m.rpc ?? []) {
      // привязка названа именем модуля; база, бакет и объект платформы модулем не называются. Host и страница сверяют uses при вызове, Worker — нет
      const owner = byName.get(name.split(".")[0]);
      if (owner && owner !== m && owner.provides[name] !== undefined && m.uses[`${name}@${owner.name}`] === undefined) fault(`зовёт ${name} — нет в uses`);
    }
  }
  out.push(...cycles(byName));
  return out;
}
