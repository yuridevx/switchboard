// Снесено: вход контракта отказывает словом.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

export type IncidentType = { profile?: string; dir: string; slot?: string };
export type Config = { port?: number; to?: string; types?: Record<string, IncidentType> };

export const wrap = (_type: string, _key: string | undefined, _text: string, _id: string) => "снесено";
export const rule = (_type: string, _key: string | undefined, _to: string | undefined) => "снесено";

export function make(): Module {
  return {
    requests: {
      "incident.pending"() {
        throw refuse("demolished", "снесено");
      },
    },
  };
}
