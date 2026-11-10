// Общее для экранов: лампа состояния, слова, строка сессии, запросы с кэшем, граница ошибки.
import { obsReport, prefsGet, prefsSet, type InputOf, type OutputOf, type RequestDef, type SessionRow, type SessionState } from "@sb/protocol";
import { Button, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { create } from "zustand";
import { api, sayError } from "./api.ts";
import { ago } from "./lib/time.ts";
import { machineOfCall, useFleet } from "./store/fleet.ts";

export const STATE_WORD: Record<SessionState, string> = { starting: "запускается", idle: "свободна", busy: "работает", waiting: "ждёт вас", stopping: "останавливается", stopped: "остановлена", failed: "сбой" };
export const EFFORTS = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "предельное"]] as const;
export const MODES = [["all", "разрешено всё"], ["ask", "спрашивать"], ["plan", "только план"], ["edits", "правки без вопросов"]] as const;
export const MODELS = [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]] as const;
export const modelWord = (id?: string) => MODELS.find(([m]) => m === id)?.[1] ?? id ?? "модель";
export const personWord = (p: string) => p.replace(/^~/, "");
/** Части пути запроса — по-человечески. */
export const PART: Record<string, string> = { services: "службы", platform: "платформа", host: "Host", keeper: "Keeper", archive: "архив", prefs: "настройки", analytics: "аналитика", ledger: "журнал флота", builds: "выпуски", reach: "связь с людьми", keys: "ключи флота", obs: "наблюдение", github: "GitHub", fleet: "флот" };
export const partWord = (p: string) => PART[p] ?? p;
export const accountWord = (a?: string) => (!a || a === "auto" ? "авто" : a);

/** Подтверждение опасного действия: одно на всю страницу. */
export function confirmDanger(o: { title: string; body?: ReactNode; confirm: string; onConfirm: () => unknown }) {
  modals.openConfirmModal({
    title: o.title, children: o.body ? <div style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 8 }}>{o.body}</div> : undefined,
    labels: { confirm: o.confirm, cancel: "Отмена" }, confirmProps: { color: "red" }, onConfirm: () => void o.onConfirm(),
  });
}

/** Отложенное действие: уведомление с тем, что сделано, и отменой; по истечении срока действие уходит. */
type Pending = { items: Record<string, string>; put(key: string, label: string | null): void };
export const usePending = create<Pending>((set) => ({ items: {}, put: (key, label) => set((s) => { const items = { ...s.items }; if (label === null) delete items[key]; else items[key] = label; return { items }; }) }));
export const UNDO_MS = 5000;
export function later(o: { key: string; label: string; run: () => unknown; ms?: number }) {
  const id = "later:" + o.key;
  const done = () => (notifications.hide(id), usePending.getState().put(o.key, null));
  const timer = setTimeout(() => (done(), void o.run()), o.ms ?? UNDO_MS);
  usePending.getState().put(o.key, o.label);
  notifications.show({
    id, autoClose: false, withCloseButton: false,
    message: <Group justify="space-between" wrap="nowrap" gap="sm"><Text size="sm" className="clamp2" style={{ minWidth: 0 }}>{o.label}</Text><Button size="compact-xs" variant="default" onClick={() => (clearTimeout(timer), done())}>Отменить</Button></Group>,
  });
}

export function Lamp({ state, offline }: { state: SessionState; offline?: boolean }) {
  return <span className={`lamp ${offline ? "off" : state}`} role="img" aria-label={offline ? "нет связи" : STATE_WORD[state]} />;
}

/** Строка сессии в списке: лампа, заголовок, позывной и чем занята, время. */
export function SessionLine({ s, selected, onPick, sub }: { s: SessionRow; selected?: boolean; onPick: () => void; sub?: ReactNode }) {
  const me = useFleet((f) => f.you?.person ?? "");
  const offline = useFleet((f) => f.machines[machineOfCall(s.callsign)]?.online === false);
  const unread = s.unread?.includes(me);
  return (
    <div className={`row${selected ? " sel" : ""}${unread ? " unread" : ""}`} role="button" tabIndex={0} data-call={s.callsign} onClick={onPick} onKeyDown={(e) => e.key === "Enter" && onPick()}>
      <Lamp state={s.state} offline={offline} />
      <div style={{ minWidth: 0 }}>
        <div className="t trunc">{s.title ?? s.spec.name}</div>
        <div className="sub trunc"><span className="mono">{s.callsign}</span>{offline ? " · нет связи" : sub ?? (s.doing ? ` · ${s.doing}` : s.state === "failed" ? ` · ${s.error ?? "сбой"}` : "")}</div>
      </div>
      <span className="when">{ago(s.last ?? s.since)}</span>
    </div>
  );
}

/** Чтение запросом договора с кэшем. */
export function useCall<D extends RequestDef<any, any>>(def: D, input: InputOf<D> | null, opts: { refetch?: number } = {}): UseQueryResult<OutputOf<D>> {
  return useQuery({ queryKey: [def.name, input], queryFn: () => api.call(def, input as InputOf<D>), enabled: input !== null, refetchInterval: opts.refetch, retry: false });
}

/** Свои настройки человека: закреплённые сессии, порядок, вид. Запись видна сразу. */
export function useMyPrefs() {
  const qc = useQueryClient();
  const q = useCall(prefsGet, { scope: "me" });
  const save = async (name: string, value: unknown) => {
    qc.setQueryData(["prefs.get", { scope: "me" }], (old: any) => ({ values: { ...(old?.values ?? {}), [name]: value } }));
    await api.call(prefsSet, { scope: "me", name, value }).catch(() => {});
  };
  return { values: (q.data?.values ?? {}) as Record<string, unknown>, save };
}

export function Failed({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="hole">
      <Stack align="center" gap="xs">
        <Text>{sayError(error)}</Text>
        {retry && <Button variant="default" size="xs" onClick={retry}>Повторить</Button>}
      </Stack>
    </div>
  );
}

/** Граница ошибки экрана: остальные экраны живут; ошибка уходит в наблюдение. */
export class Boundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    api.call(obsReport, { part: "web", level: "error", msg: `${this.props.name}: ${error.message}`, stack: error.stack }).catch(() => {});
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="hole">
        <Stack align="center" gap="xs">
          <Text fw={600}>Экран «{this.props.name}» сломался</Text>
          <Text className="muted" size="sm">{this.state.error.message}</Text>
          <Button variant="default" size="xs" onClick={() => this.setState({ error: null })}>Открыть заново</Button>
        </Stack>
      </div>
    );
  }
}

/** Состояние оболочки. */
type Ui = { newOpen: boolean; newPreset: { machine?: string } | null; inspector: boolean; keysOpen: boolean; set(p: Partial<Ui>): void };
export const useUi = create<Ui>((set) => ({ newOpen: false, newPreset: null, inspector: true, keysOpen: false, set: (p) => set(p) }));

const WIDE = "(min-width: 861px)";
export const useWide = (): boolean => useMediaQuery(WIDE, typeof window !== "undefined" && window.matchMedia(WIDE).matches, { getInitialValueInEffect: false }) ?? true;
