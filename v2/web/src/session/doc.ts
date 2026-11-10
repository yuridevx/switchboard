// Документ сессии на странице: правка одним запросом, пометка «после хода», действующие значения по умолчанию, имена из настроек.
import { sessionCall, sessionUpdate, type SessionRow, type SpecPatch } from "@sb/protocol";
import { useEffect } from "react";
import { create } from "zustand";
import { act } from "../api.ts";
import { MODELS, useCall, useLabels as useLabelMap } from "../common.tsx";

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

export type ModelOption = { value: string; label: string; efforts?: string[]; fast?: boolean; auto?: boolean };

/** Модели сессии — из её SDK; не ответил (сессия стоит) — общий список страницы. */
export function modelOptions(list: unknown): ModelOption[] {
  const raw = (Array.isArray(list) ? list : ((list as { models?: unknown[] } | null)?.models ?? [])) as Array<Record<string, any>>;
  if (!raw.length) return MODELS.map(([value, label]) => ({ value, label }));
  return raw.map((m) => ({ value: String(m.value ?? m.id), label: String(m.displayName ?? m.name ?? m.value ?? m.id), ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels } : {}), ...(m.supportsFastMode ? { fast: true } : {}), ...(m.supportsAutoMode ? { auto: true } : {}) }));
}

/** Действующая модель: из документа, иначе та, на которой идёт разговор, иначе первая в списке SDK (она и есть «по умолчанию»). */
export function effectiveModel(spec: { model?: string }, options: ModelOption[], running?: string): ModelOption {
  const id = spec.model ?? running;
  const strip = (x: string) => x.replace(/\[.*$/, "");
  const found = id ? options.find((o) => o.value === id || strip(o.value) === strip(id)) : undefined;
  return found ?? (id ? { value: id, label: id } : (options[0] ?? { value: "", label: "по умолчанию" }));
}

/** Модели для аккаунта сессии: у ключа флота модель одна — та, что записана у ключа; чужую провайдер ключа не примет. У входа Claude — список SDK. */
export function modelsFor(account: { kind: string; model?: string; models?: Record<string, string> } | undefined, sdk: ModelOption[]): ModelOption[] {
  if (account?.kind !== "key") return sdk;
  // alias-модели ключа: имя, которое выбирает человек, → модель провайдера
  const alias = Object.entries(account.models ?? {});
  if (alias.length) return alias.map(([value, real]) => ({ value, label: value === real ? value : `${value} → ${real}` }));
  return account.model ? [{ value: account.model, label: account.model }] : sdk;
}

export function useModels(s: SessionRow, live: boolean): ModelOption[] {
  const q = useCall(sessionCall, live ? { to: s.callsign, method: "models" } : null);
  return modelOptions(q.data);
}

/** Имена сессий и машин из общих настроек флота: человек назвал — страница показывает имя вместо позывного. */
export function useLabels(): { of(addr: string): string | undefined; name(addr: string): string } {
  const labels = useLabelMap();
  return { of: (a) => labels[a] || undefined, name: (a) => labels[a] || a };
}
