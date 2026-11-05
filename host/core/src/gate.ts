// Гейт старта: набор модулей (ошибка — Host не стартует) и устройство одного модуля (ошибка — выключен он).
import { check, ownerOf } from "@switchboard/manifest-gate";
import type { Manifest } from "../contract.ts";
import { CORE_ONLY, QUERY_METHODS, SESSION_FUNCTIONS } from "./calls.ts";
import type { ModuleEntry, Release } from "./release.ts";

/** Поля записи сессии в roster, которые держит ядро. */
const CORE_FIELDS = ["callsign", "state", "failed", "sdk", "dir", "by"];

/** Правила набора — гейта монорепо; владелец вне набора (Worker, keeper) ему не виден. */
export function setProblems(core: Manifest, modules: Manifest[]): string[] {
  const names = new Set([core.name, ...modules.map((m) => m.name)]);
  const inSet = (m: Manifest) => ({ ...m, uses: Object.fromEntries(Object.entries(m.uses).filter(([ref]) => names.has(ownerOf(ref)))) });
  return check([core, ...modules].map(inSet)).map((why) => why.replace(/^имя /, ""));
}

/** Имена, которые идут только через relay: без него в сборке им неоткуда взяться. */
export function relayProblems(core: Manifest, modules: Manifest[]): string[] {
  const names = new Set([core.name, ...modules.map((m) => m.name)]);
  return modules.flatMap((m) => Object.keys(m.uses).flatMap((ref) => (names.has(ownerOf(ref)) ? [] : [`${m.name}: ${ref} — нет relay в списке сборки`])));
}

export function moduleProblems({ manifest: m, module: x, failed }: ModuleEntry): string[] {
  if (failed) return [failed];
  const declared = (kind: string, names: string[], prefix = "") => names.filter((n) => !Object.hasOwn(m.provides, prefix + n)).map((n) => `${m.name}: ${kind}.${n} — нет в provides`);
  return [
    ...declared("requests", Object.keys(x.requests ?? {})),
    ...declared("frames", Object.keys(x.frames ?? {})),
    ...declared("fields", Object.keys(x.fields ?? {})),
    ...declared("decide", Object.keys(x.decide ?? {}), "decide."),
    ...(x.elicit && !Object.hasOwn(m.provides, "elicit") ? [`${m.name}: elicit — нет в provides`] : []),
    ...Object.keys(x.fields ?? {}).filter((n) => CORE_FIELDS.includes(n)).map((n) => `${m.name}: поле ${n} — имя ядра`),
    ...(m.calls ?? []).flatMap((c) => {
      if (CORE_ONLY.has(c)) return [`${m.name}: calls ${c} — метод держит ядро`];
      return QUERY_METHODS.has(c) || Object.hasOwn(SESSION_FUNCTIONS, c) ? [] : [`${m.name}: calls ${c} — такого метода нет в SDK`];
    }),
  ];
}

/** Гейт выпуска (--check): всё, что не даст модулю или набору работать. */
export const releaseProblems = (core: Manifest, release: Release): string[] => [...release.modules.flatMap(moduleProblems), ...setProblems(core, release.modules.map((e) => e.manifest))];
