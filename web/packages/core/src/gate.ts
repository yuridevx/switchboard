// Гейт набора модулей страницы: то, что общий гейт манифестов не видит, — устройство кода модуля.
// У экрана, метки, принимаемого кадра и раздела хранилища один модуль; каждое uses к модулю выпуска есть у владельца той же версии.
import { check, nameOf, ownerOf, type Manifest as GateManifest } from "@switchboard/manifest-gate";
import core from "../module.json" with { type: "json" };
import type { AppModule, DefinedPart, Manifest } from "./types.ts";

/** Манифест ядра: модули пользуются им через "app@web-core". */
export const CORE: Manifest = core;

/** Раздел хранилища ядра: пропуск устройства; его читает и обработчик пушей. */
const CORE_SECTIONS = ["key"];

export { nameOf, ownerOf };

const sections = (names: string[]) => Object.fromEntries(names.map((s) => [`store.${s}`, 1]));

/** Что в коде модуля не сходится с его манифестом. */
function mismatches(m: Manifest, mod: AppModule): string[] {
  const errors: string[] = [];
  const inUses = (name: string) => Object.keys(m.uses).some((ref) => nameOf(ref) === name);
  for (const [word, names] of [["экрана", mod.screens], ["команды", mod.commands], ["метки", mod.marks]] as const) {
    for (const n of Object.keys(names ?? {})) if (m.provides[n] === undefined) errors.push(`модуль ${m.name}: ${word} ${n} нет в provides`);
  }
  for (const [s, def] of Object.entries(mod.screens ?? {})) {
    if (def.mark && !mod.marks?.[def.mark]) errors.push(`модуль ${m.name}: экран ${s} — метки ${def.mark} нет в marks`);
    if (def.place && !inUses(def.place)) errors.push(`модуль ${m.name}: экран ${s} — места ${def.place} нет в uses`);
  }
  for (const [c, def] of Object.entries(mod.commands ?? {})) {
    if (def.place && !inUses(def.place)) errors.push(`модуль ${m.name}: команда ${c} — места ${def.place} нет в uses`);
  }
  for (const t of Object.keys(mod.frames ?? {})) if (!inUses(t)) errors.push(`модуль ${m.name}: кадр ${t} нет в uses`);
  if (mod.on?.roster && m.uses["roster@relay"] === undefined) errors.push(`модуль ${m.name}: on.roster без roster@relay в uses`);
  return errors;
}

/** Манифест для общего гейта: принимаемый кадр и раздел хранилища — имена во владении; владельцы вне набора проверяются на связи. */
function asGateManifest(m: Manifest, mod: AppModule, inSet: Set<string>): GateManifest {
  const accepted: Record<string, number> = {};
  for (const t of Object.keys(mod.frames ?? {})) {
    const ref = Object.keys(m.uses).find((r) => nameOf(r) === t);
    if (ref) accepted[t] = m.uses[ref];
  }
  return {
    name: m.name,
    type: m.type,
    version: m.version,
    provides: { ...m.provides, ...accepted, ...sections(mod.store ?? []) },
    uses: Object.fromEntries(Object.entries(m.uses).filter(([ref]) => inSet.has(ownerOf(ref)))),
    config: {},
  };
}

/** Проверить набор: пустой список — годен, иначе причины словами. */
export function appGate(parts: DefinedPart[]): string[] {
  const inSet = new Set([CORE.name, ...parts.map((p) => p.manifest.name)]);
  const coreManifest: GateManifest = { name: CORE.name, type: CORE.type, version: CORE.version, uses: {}, config: {}, provides: { ...CORE.provides, ...sections(CORE_SECTIONS) } };
  return [...parts.flatMap((p) => mismatches(p.manifest, p.module)), ...check([coreManifest, ...parts.map((p) => asGateManifest(p.manifest, p.module, inSet))])];
}
