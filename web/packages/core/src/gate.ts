// Гейт набора: определения модулей против манифестов; связи манифестов проверяет общий гейт.
import { check, nameOf, ownerOf } from "@switchboard/manifest-gate";
import core from "../module.json" with { type: "json" };
import type { AppModule, DefinedPart, Manifest } from "./types.ts";

function definitionErrors(m: Manifest, d: AppModule): string[] {
  const used = new Set(Object.keys(m.uses).map(nameOf));
  const provided = (name: string) => Object.hasOwn(m.provides, name);
  const errors: string[] = [];
  const bad = (when: unknown, text: string) => void (when && errors.push(`модуль ${m.name}: ${text}`));
  for (const [name, s] of Object.entries(d.screens ?? {})) {
    bad(!provided(name), `экрана ${name} нет в provides`);
    bad(s.mark && !Object.hasOwn(d.marks ?? {}, s.mark), `экран ${name} — метки ${s.mark} нет в marks`);
    bad(s.place && !used.has(s.place), `экран ${name} — места ${s.place} нет в uses`);
  }
  for (const name of Object.keys(d.frames ?? {})) bad(!used.has(name), `кадр ${name} нет в uses`);
  for (const [name, c] of Object.entries(d.commands ?? {})) {
    bad(!provided(name), `команды ${name} нет в provides`);
    bad(c.place && !used.has(c.place), `команда ${name} — места ${c.place} нет в uses`);
  }
  for (const name of Object.keys(d.marks ?? {})) bad(!provided(name), `метки ${name} нет в provides`);
  bad(d.on?.roster && !m.uses["roster@relay"], "on.roster без roster@relay в uses");
  return errors;
}

/** У кадра и раздела хранилища — один модуль; key — раздел ядра. */
function secondOwners(parts: DefinedPart[]): string[] {
  const owners = new Map([["store.key", core.name]]);
  return parts.flatMap(({ manifest: m, module: d }) =>
    [...Object.keys(d.frames ?? {}), ...(d.store ?? []).map((s) => `store.${s}`)].flatMap((name) => {
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
  return [...parts.flatMap((p) => definitionErrors(p.manifest, p.module)), ...secondOwners(parts), ...check(manifests as Parameters<typeof check>[0])];
}
