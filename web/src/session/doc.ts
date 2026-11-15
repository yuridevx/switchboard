// Документ сессии на странице: правка одним запросом, пометка «после хода».
import { sessionUpdate, type SessionRow, type SpecPatch } from "@sb/protocol";
import { useEffect } from "react";
import { create } from "zustand";
import { act } from "../api.ts";

/** Ключи документа, которые вступят в силу после хода: что ответил Host на session.update. */
const useLaterStore = create<{ keys: Record<string, string[]>; put(c: string, keys: string[]): void }>((set) => ({
  keys: {},
  put: (c, keys) => set((s) => ({ keys: { ...s.keys, [c]: keys } })),
}));

/** Слияние пометок «после хода»: новое добавляется, применённое сразу — снимается. */
export const mergeLater = (was: string[], now: string[], later: string[]): string[] => [...new Set([...was.filter((k) => !now.includes(k)), ...later])];

export async function patchDoc(s: SessionRow, patch: Omit<SpecPatch, "wing"> & { wing?: string | null }, opts: { pair?: boolean } = {}): Promise<boolean> {
  const r = await act(sessionUpdate, { to: s.callsign, patch: patch as never, ...(opts.pair ? { pair: true } : {}) });
  if (!r) return false;
  const st = useLaterStore.getState();
  st.put(s.callsign, mergeLater(st.keys[s.callsign] ?? [], r.now ?? [], r.later ?? []));
  return true;
}

/** Какие ключи ждут конца хода; ход кончился — пометки сняты. */
export function useLater(s: SessionRow): string[] {
  const keys = useLaterStore((st) => st.keys[s.callsign]);
  const idle = s.state === "idle" || s.state === "stopped";
  useEffect(() => {
    if (idle && keys?.length) useLaterStore.getState().put(s.callsign, []);
  }, [idle, keys, s.callsign]);
  return keys ?? [];
}
