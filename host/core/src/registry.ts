// Реестр «имя → владелец» и гейт старта Host: тот же check гейта монорепо над списком модулей,
// плюс устройство кода: обработчики, решения по инструменту (decide.<инструмент>) и формы MCP (elicit) — имена provides,
// calls — методы закреплённого SDK. Один владелец у решения — то же правило имён гейта.
import { check, nameOf, ownerOf } from "@switchboard/manifest-gate";
import type { Manifest } from "../contract.ts";
import { CORE_ONLY, isCallable } from "./calls.ts";
import type { ModuleEntry } from "./release.ts";

/** Поля записи сессии, которые держит ядро. */
export const CORE_FIELDS = new Set(["callsign", "state", "failed", "sdk"]);

export { nameOf, ownerOf };

/** Итог гейта: fatal — Host не стартует (имена набора); down — модуль → причины: он выключен, остальные работают. */
export type GateResult = { fatal: string[]; down: Map<string, string[]> };

/**
 * Гейт набора модулей Host. Ошибки набора (два владельца имени, uses без владельца, нет relay) — fatal;
 * ошибки устройства кода одного модуля (импорт, обработчик не из provides, calls мимо SDK) — только этот модуль.
 * Имя из uses, чей владелец не модуль Host и не ядро, — имя участника рации (Worker-модуля или keeper машины): идёт через relay.
 */
export function gate(core: Manifest, entries: ModuleEntry[], relay: boolean): GateResult {
  const errors: string[] = [];
  const down = new Map<string, string[]>();
  const off = (m: string, why: string) => down.set(m, [...(down.get(m) ?? []), why]);
  const local = new Set([core.name, ...entries.map((e) => e.manifest.name)]);
  // uses ядра сверяет гейт монорепо: его владельцы — вне процесса Host
  const manifests: Manifest[] = [{ ...core, uses: {} }];
  for (const { manifest: m } of entries) {
    const uses: Record<string, number> = {};
    for (const [ref, v] of Object.entries(m.uses ?? {})) {
      const o = ownerOf(ref);
      if (local.has(o)) uses[ref] = v;
      if (!local.has(o) && !relay) errors.push(`${m.name}: ${ref} — нет relay в списке сборки`);
    }
    manifests.push({ ...m, provides: m.provides ?? {}, uses, config: m.config ?? {} });
  }
  errors.push(...check(manifests).map((e) => e.replace(/^имя /, "")));

  for (const { manifest: m, module: mod, error } of entries) {
    const provides = m.provides ?? {};
    if (error) off(m.name, `${m.name}: ${error}`);
    for (const kind of ["requests", "frames", "fields"] as const) {
      for (const n of Object.keys(mod[kind] ?? {})) {
        if (provides[n] === undefined) off(m.name, `${m.name}: ${kind}.${n} — нет в provides`);
        if (kind === "fields" && CORE_FIELDS.has(n)) off(m.name, `${m.name}: поле ${n} — имя ядра`);
      }
    }
    for (const c of m.calls ?? []) {
      if (CORE_ONLY.has(c)) off(m.name, `${m.name}: calls ${c} — метод держит ядро`);
      else if (!isCallable(c)) off(m.name, `${m.name}: calls ${c} — такого метода нет в SDK`);
    }
    for (const tool of Object.keys(mod.decide ?? {})) if (provides[`decide.${tool}`] === undefined) off(m.name, `${m.name}: decide.${tool} — нет в provides`);
    if (mod.elicit && provides.elicit === undefined) off(m.name, `${m.name}: elicit — нет в provides`);
  }
  return { fatal: errors, down };
}
