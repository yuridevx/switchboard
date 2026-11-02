// Гейт набора экранов при старте приложения: у экрана, метки, принимаемого кадра и раздела
// хранилища один модуль; каждое uses к модулю выпуска есть в provides владельца той же версии.
// Правила владельцев и версий — общий гейт манифестов монорепо; здесь к ним добавлено устройство кода.
import { check, nameOf, ownerOf, type Manifest as GateManifest } from "@switchboard/manifest-gate";
import core from "../module.json" with { type: "json" };
import type { AppPart, Manifest } from "./types.ts";

/** Манифест ядра: модули пользуются им через "app@web-core". */
export const CORE: Manifest = core;

/** Разделы хранилища ядра: key — ключ флота устройства (его читает и обработчик пушей). */
export const CORE_STORE = ["key"];

export { nameOf, ownerOf };
const stores = (names: string[]) => Object.fromEntries(names.map((s) => [`store.${s}`, 1]));

/** Проверить набор модулей выпуска. Пустой список — годен; иначе — причины словами. */
export function appGate(parts: AppPart[]): string[] {
  const errors: string[] = [];
  const inSet = new Set([CORE.name, ...parts.map((p) => p.manifest.name)]);
  const set: GateManifest[] = [{ ...CORE, uses: {}, config: {}, provides: { ...CORE.provides, ...stores(CORE_STORE) } }];

  for (const { manifest: m, module: mod } of parts) {
    const own = (kind: string, names: string[]) => {
      for (const n of names) if (m.provides[n] === undefined) errors.push(`модуль ${m.name}: ${kind} ${n} нет в provides`);
    };
    own("экрана", Object.keys(mod.screens ?? {}));
    own("метки", Object.keys(mod.marks ?? {}));
    for (const [s, def] of Object.entries(mod.screens ?? {})) {
      if (def.mark && !mod.marks?.[def.mark]) errors.push(`модуль ${m.name}: экран ${s} — метки ${def.mark} нет в marks`);
    }
    // принимаемый кадр — имя чужого владельца из uses; у кадра один принимающий модуль
    const accepts: Record<string, number> = {};
    for (const t of Object.keys(mod.frames ?? {})) {
      const ref = Object.keys(m.uses).find((r) => nameOf(r) === t);
      if (!ref) errors.push(`модуль ${m.name}: кадр ${t} нет в uses`);
      else accepts[t] = m.uses[ref];
    }
    if (mod.on?.roster && m.uses["roster@relay"] === undefined) errors.push(`модуль ${m.name}: on.roster без roster@relay в uses`);
    set.push({
      name: m.name,
      type: m.type,
      version: m.version,
      provides: { ...m.provides, ...accepts, ...stores(mod.store ?? []) },
      // владельцы вне выпуска (Host, Worker-модули) проверяются на связи — по contract в roster
      uses: Object.fromEntries(Object.entries(m.uses).filter(([r]) => inSet.has(ownerOf(r)))),
      config: {},
    });
  }
  return [...errors, ...check(set)];
}
