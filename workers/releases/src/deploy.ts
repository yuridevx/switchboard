// releases.deploy: stable на версию. Модуль сборки и корень — новая сборка; части машины — stable и планы keeper'ам; Worker — выкладка его версии.
import { isBuild, isVersion } from "@switchboard/release";
import type { Frame } from "@switchboard/protocol";
import type { Deployed } from "../contract.ts";
import { rebuild } from "./builds.ts";
import { type Catalog, NAME, newest } from "./catalog.ts";
import { deploy as deployVersion } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { readFleet, writeFleet } from "./fleet.ts";
import { EVERY_MACHINE, journal, plansAfterMove } from "./plans.ts";
import { Refusal } from "./refusal.ts";

type Moved = { result: Deployed; plans: Frame[] };

/** Поле кадра со списком имён; нет поля — пусто. */
function names(x: unknown, field: string): string[] {
  if (x === undefined) return [];
  if (!Array.isArray(x) || x.some((n) => typeof n !== "string" || !NAME.test(n))) throw new Refusal("bad_frame", `${field} — список имён`);
  return x as string[];
}

export async function deploy(env: Env, cat: Catalog, f: Frame, by: string): Promise<Moved> {
  const { part, version, latest } = f;
  if (typeof part !== "string" || (part !== "*" && !NAME.test(part))) throw new Refusal("bad_frame", "part — имя части или *");
  if (version !== undefined && version !== null && (typeof version !== "string" || !isVersion(version))) throw new Refusal("bad_version", "версия — три числа, сборка «+n» или null — снять модуль");
  if (part === "*" && version !== undefined) throw new Refusal("bad_frame", "у * версии нет: каждая часть — на свою edge");
  const without = names(f.without, "without");
  const checkWith = names(f.check_with, "check_with");
  if (without.length + checkWith.length && latest !== true) throw new Refusal("bad_frame", "without и check_with — только вместе с latest: true");
  const want = (version ?? undefined) as string | undefined;
  const kind = part === "*" ? undefined : (await cat.parts()).get(part);
  const entry = part === "*" ? undefined : (await cat.all()).get(part);
  const top = entry?.versions.at(-1);
  // latest: корень и его модули — на новейшие одной сборкой: смена, которую нельзя выложить по модулю;
  // у модуля — все приложения его into сразу, одной проверкой: смену контракта, общего для приложений, порознь не выложить
  if (latest !== undefined) {
    const apps = kind?.app ? [part] : (entry?.manifest?.into ?? []);
    if (latest !== true || want !== undefined || !apps.length) throw new Refusal("bad_frame", "latest: true — только у корня сборки или модуля сборки и без version");
    return rebuild(env, cat, { apps, change: { name: part, version: top! }, by, latest: true, without, checkWith });
  }
  if (part === "*") return moveAll(env, cat, by);
  // модуль сборки: новая сборка каждого приложения из его into; version: null — сборки без него
  if (!kind && entry?.manifest?.into?.length) {
    if (want && isBuild(want)) throw new Refusal("bad_version", `${part} — модуль: версия каталога, без «+»`);
    return rebuild(env, cat, { apps: entry.manifest.into, change: { name: part, version: version === null ? null : (want ?? top!) }, by });
  }
  if (version === null) throw new Refusal("bad_frame", `${part} — не модуль сборки: снимать нечего`);
  // корень сборки: версия ядра в каталоге — сборка с этим ядром; сборка «+n» или прежний архив без манифеста — откат на него
  if (kind?.app && !(want && (isBuild(want) || !(await cat.manifest(part, want))))) return rebuild(env, cat, { apps: [part], change: { name: part, version: want ?? top! }, by });
  return moveParts(env, cat, [part], by, want);
}

/** Вся сборка: части машины и Worker'ы, каждая на свою edge; relay — последним: его выкладка рвёт соединения флота. */
async function moveAll(env: Env, cat: Catalog, by: string): Promise<Moved> {
  const workers = [...(await cat.parts())].filter(([, p]) => p.where === "cloud" && !p.app).map(([name]) => name);
  const inOrder = workers.toSorted((a, b) => Number(a === "relay") - Number(b === "relay") || (a < b ? -1 : 1));
  return moveParts(env, cat, [...EVERY_MACHINE, ...inOrder], by);
}

/**
 * Сдвинуть части на версию или на edge. Worker выкладывается сразу и сразу в журнал: отказ дальше его не отменяет.
 * stable частей машины пишется после цикла: отказ посреди не оставляет stable без rev и планов.
 */
async function moveParts(env: Env, cat: Catalog, targets: string[], by: string, want?: string): Promise<Moved> {
  const fleet = await readFleet(env);
  const parts = await cat.parts();
  const result: Deployed = { parts: {} };
  const moved = new Map<string, string>();
  for (const name of targets) {
    const part = parts.get(name);
    if (part?.where === "cloud") {
      const { tags, id, tag } = await cat.live(part.script);
      const to = want ?? newest(tags.keys());
      if (!to || !tags.has(to)) throw new Refusal("no_release", `у ${name} нет версии ${to ?? "с меткой"}`);
      if (id !== tags.get(to)) await deployVersion(env, part.script, tags.get(to)!);
      if (tag !== to) await journal(env, `${name} ${tag ?? "—"} → ${to}`, by);
      result.parts[name] = { from: tag, to };
    } else {
      const to = want ?? newest(await cat.machineVersions(name));
      if (!to || !(await cat.sha(name, to))) throw new Refusal("no_release", `у ${name} нет версии ${to ?? ""}`.trim());
      const from = fleet.stable[name] ?? null;
      if (from !== to) moved.set(name, to);
      result.parts[name] = { from, to };
    }
  }
  if (!moved.size) return { result, plans: [] };
  const next = await writeFleet(env, fleet, { stable: { ...fleet.stable, ...Object.fromEntries(moved) } });
  for (const [name, to] of moved) await journal(env, `${name} ${fleet.stable[name] ?? "—"} → ${to}`, by);
  return { result, plans: await plansAfterMove(env, cat, next, [...moved.keys()]) };
}
