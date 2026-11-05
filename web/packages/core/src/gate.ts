// Гейт набора: у экрана, команды, метки, принимаемого кадра и раздела хранилища — один модуль; всё названное есть в манифесте.
import type { DefinedPart } from "./types.ts";

const SELF = "web-core";
/** Имя из uses: "имя@владелец". */
const split = (use: string) => [use.slice(0, use.lastIndexOf("@")), use.slice(use.lastIndexOf("@") + 1)];

export function appGate(parts: DefinedPart[]): string[] {
  const errors: string[] = [];
  const owners = new Map<string, string>([["store.key", SELF]]);
  const claim = (name: string, who: string) => {
    const was = owners.get(name);
    if (was && was !== who) errors.push(`имя ${name}: два владельца — ${was} и ${who}`);
    owners.set(name, who);
  };
  const seen = new Set<string>();

  for (const { manifest: m, module: d } of parts) {
    const bad = (text: string) => errors.push(`модуль ${m.name}: ${text}`);
    if (seen.has(m.name)) bad("имя уже занято");
    seen.add(m.name);
    const provided = (name: string) => Object.hasOwn(m.provides, name);
    const used = (name: string) => Object.keys(m.uses).some((u) => split(u)[0] === name);
    const inPlace = (kind: string, name: string, place?: string) => {
      if (place && !used(place)) bad(`${kind} ${name} — места ${place} нет в uses`);
    };

    for (const [name, s] of Object.entries(d.screens ?? {})) {
      if (!provided(name)) bad(`экрана ${name} нет в provides`);
      if (s.mark && !d.marks?.[s.mark]) bad(`экран ${name} — метки ${s.mark} нет в marks`);
      inPlace("экран", name, s.place);
      claim(name, m.name);
    }
    for (const [name, c] of Object.entries(d.commands ?? {})) {
      if (!provided(name)) bad(`команды ${name} нет в provides`);
      inPlace("команда", name, c.place);
      claim(name, m.name);
    }
    for (const name of Object.keys(d.marks ?? {})) {
      if (!provided(name)) bad(`метки ${name} нет в provides`);
      claim(name, m.name);
    }
    for (const type of Object.keys(d.frames ?? {})) {
      if (!used(type)) bad(`кадр ${type} нет в uses`);
      claim(type, m.name);
    }
    if (d.on?.roster && !used("roster")) bad("on.roster без roster@relay в uses");
    for (const section of d.store ?? []) claim(`store.${section}`, m.name);
  }

  for (const { manifest: m } of parts) {
    for (const [use, v] of Object.entries(m.uses)) {
      const [name, owner] = split(use);
      const have = parts.find((p) => p.manifest.name === owner)?.manifest.provides[name];
      if (have !== undefined && have !== v) errors.push(`модуль ${m.name}: uses ${use} v${v} — у владельца v${have}`);
    }
  }
  return errors;
}
