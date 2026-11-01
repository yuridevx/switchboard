// Реестр «имя → владелец» и гейт старта Host: тот же check гейта монорепо над списком модулей,
// плюс устройство кода: обработчики — ровно имена provides, calls — методы закреплённого SDK, решения — по одному владельцу.
import { check } from "@switchboard/manifest-gate";
import type { Manifest } from "../contract.ts";
import { CORE_ONLY, isCallable } from "./calls.ts";
import type { ModuleEntry } from "./release.ts";

/** Поля записи сессии, которые держит ядро. */
export const CORE_FIELDS = new Set(["callsign", "state", "failed", "sdk"]);

export const nameOf = (ref: string) => ref.slice(0, ref.lastIndexOf("@"));
export const ownerOf = (ref: string) => ref.slice(ref.lastIndexOf("@") + 1);

/**
 * Гейт набора модулей Host. Пустой список — набор годен.
 * Имя из uses, чей владелец не модуль Host и не ядро, — имя участника рации (Worker-модуля или keeper машины): идёт через relay.
 */
export function gate(core: Manifest, entries: ModuleEntry[], relay: boolean): string[] {
  const errors: string[] = [];
  const local = new Set([core.name, ...entries.map((e) => e.manifest.name)]);
  // uses ядра сверяет гейт монорепо: его владельцы — вне процесса Host
  const manifests: Manifest[] = [{ ...core, uses: {} }];
  for (const { manifest: m } of entries) {
    const uses: Record<string, number> = {};
    for (const [ref, v] of Object.entries(m.uses ?? {})) {
      const o = ownerOf(ref);
      if (local.has(o)) uses[ref] = v;
      if (!local.has(o) && !relay) errors.push(`${m.name}: ${ref} — нет relay (SWITCHBOARD_RELAY)`);
    }
    manifests.push({ ...m, provides: m.provides ?? {}, uses, config: m.config ?? {} });
  }
  errors.push(...check(manifests).map((e) => e.replace(/^имя /, "")));

  const decideOwner = new Map<string, string>();
  let elicitOwner: string | null = null;
  for (const { manifest: m, module: mod } of entries) {
    const provides = m.provides ?? {};
    for (const kind of ["requests", "frames", "fields"] as const) {
      for (const n of Object.keys(mod[kind] ?? {})) {
        if (provides[n] === undefined) errors.push(`${m.name}: ${kind}.${n} — нет в provides`);
        if (kind === "fields" && CORE_FIELDS.has(n)) errors.push(`${m.name}: поле ${n} — имя ядра`);
      }
    }
    for (const c of m.calls ?? []) {
      if (CORE_ONLY.has(c)) errors.push(`${m.name}: calls ${c} — метод держит ядро`);
      else if (!isCallable(c)) errors.push(`${m.name}: calls ${c} — такого метода нет в SDK`);
    }
    for (const tool of Object.keys(mod.decide ?? {})) {
      const o = decideOwner.get(tool);
      if (o) errors.push(`decide ${tool}: два владельца — ${o} и ${m.name}`);
      else decideOwner.set(tool, m.name);
    }
    if (mod.elicit) {
      if (elicitOwner) errors.push(`elicit: два владельца — ${elicitOwner} и ${m.name}`);
      else elicitOwner = m.name;
    }
  }
  return errors;
}
