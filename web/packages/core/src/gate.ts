// Гейт набора модулей страницы: определения модулей против манифестов, затем общий гейт манифестов.
import { check, nameOf, ownerOf } from "@switchboard/manifest-gate";
import core from "../module.json" with { type: "json" };
import type { AppModule, DefinedPart, Manifest } from "./types.ts";

/** Раздел ядра: пропуск. */
const CORE_SECTION = "key";

/** Что нарушает определение одного модуля. */
function definitionErrors(m: Manifest, d: AppModule): string[] {
  const provided = (name: string) => Object.hasOwn(m.provides, name);
  const used = new Set(Object.keys(m.uses).map(nameOf));
  const who = `модуль ${m.name}:`;
  return [
    ...Object.entries(d.screens ?? {}).flatMap(([name, s]) => [
      ...(provided(name) ? [] : [`${who} экрана ${name} нет в provides`]),
      ...(s.mark && !Object.hasOwn(d.marks ?? {}, s.mark) ? [`${who} экран ${name} — метки ${s.mark} нет в marks`] : []),
      ...(s.place && !used.has(s.place) ? [`${who} экран ${name} — места ${s.place} нет в uses`] : []),
    ]),
    ...Object.keys(d.frames ?? {}).flatMap((name) => (used.has(name) ? [] : [`${who} кадр ${name} нет в uses`])),
    ...Object.entries(d.commands ?? {}).flatMap(([name, c]) => [
      ...(provided(name) ? [] : [`${who} команды ${name} нет в provides`]),
      ...(c.place && !used.has(c.place) ? [`${who} команда ${name} — места ${c.place} нет в uses`] : []),
    ]),
    ...Object.keys(d.marks ?? {}).flatMap((name) => (provided(name) ? [] : [`${who} метки ${name} нет в provides`])),
    ...(d.on?.roster && !m.uses["roster@relay"] ? [`${who} on.roster без roster@relay в uses`] : []),
  ];
}

/** У кадра и раздела хранилища — один модуль. */
function secondOwners(parts: DefinedPart[], namesOf: (d: AppModule) => string[], first: Array<[string, string]> = []): string[] {
  const owners = new Map(first);
  return parts.flatMap(({ manifest: m, module: d }) =>
    namesOf(d).flatMap((name) => {
      const was = owners.get(name);
      if (!was) owners.set(name, m.name);
      return was && was !== m.name ? [`имя ${name}: два владельца — ${was} и ${m.name}`] : [];
    }),
  );
}

/** Проверить набор: пустой список — годен, иначе причины словами. */
export function appGate(parts: DefinedPart[]): string[] {
  const inSet = new Set([core.name, ...parts.map((p) => p.manifest.name)]);
  // владельца вне набора гейт не знает: это Host и Worker-модули, их сверяет получатель
  const manifests = [{ ...core, uses: {} }, ...parts.map((p) => p.manifest)].map(({ name, type, version, provides, uses, config }) => ({ name, type, version, provides, config: config ?? {}, uses: Object.fromEntries(Object.entries(uses).filter(([ref]) => inSet.has(ownerOf(ref)))) }));
  return [
    ...parts.flatMap((p) => definitionErrors(p.manifest, p.module)),
    ...secondOwners(parts, (d) => Object.keys(d.frames ?? {})),
    ...secondOwners(parts, (d) => (d.store ?? []).map((s) => `store.${s}`), [[`store.${CORE_SECTION}`, core.name]]),
    ...check(manifests as Parameters<typeof check>[0]),
  ];
}
