// Снесено: вход отвечает отказом словом.
import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

export type IncidentType = { dir: string; profile?: string; slot?: string };
export type Config = { port?: number; to?: string; types?: Record<string, IncidentType> };
export const rule = (_type: string, _key: string | undefined, _to: string | undefined): string => "снесено";
export const wrap = (_type: string, _key: string | undefined, _text: string, _id: string): string => "снесено";
export const make = (): Module => ({
  fields: { incident: () => undefined },
  requests: {
    "incident.pending"() {
      throw refuse("снесено", "incident.pending снесён");
    },
  },
});
