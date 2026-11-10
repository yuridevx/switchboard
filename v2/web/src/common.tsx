// Общее для экранов: лампа состояния, слова, строка сессии, запросы с кэшем, граница ошибки.
import { obsReport, prefsGet, prefsSet, type InputOf, type OutputOf, type RequestDef, type SessionRow, type SessionState } from "@sb/protocol";
import { Button, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { create } from "zustand";
import { api, sayError } from "./api.ts";
import { ago } from "./lib/time.ts";
import { openStep } from "./shell/Page.tsx";
import { machineOfCall, useFleet } from "./store/fleet.ts";

export const STATE_WORD: Record<SessionState, string> = { starting: "запускается", idle: "свободна", busy: "работает", waiting: "ждёт вас", stopping: "останавливается", stopped: "остановлена", failed: "сбой" };
export const EFFORTS = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "предельное"]] as const;
export const MODES = [["all", "разрешено всё"], ["ask", "спрашивать"], ["plan", "только план"], ["edits", "правки без вопросов"], ["auto", "решает Claude"]] as const;
export const MODELS = [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]] as const;
export const modelWord = (id?: string) => MODELS.find(([m]) => m === id)?.[1] ?? id ?? "модель";
export const personWord = (p: string) => p.replace(/^~/, "");
/** Части пути запроса — по-человечески. */
export const PART: Record<string, string> = { services: "службы", platform: "платформа", host: "Host", keeper: "Keeper", archive: "архив", prefs: "настройки", analytics: "аналитика", ledger: "журнал флота", builds: "выпуски", reach: "связь с людьми", keys: "ключи флота", obs: "наблюдение", github: "GitHub", fleet: "флот" };
export const partWord = (p: string) => PART[p] ?? p;
export const accountWord = (a?: string) => a ?? "—";

/** Подтверждение опасного действия: страница с тем, что случится, красной кнопкой и «Отменой». */
export function confirmDanger(o: { title: string; body?: ReactNode; confirm: string; onConfirm: () => unknown }) {
  openStep(o);
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

/** Кто кого ведёт: пометка в строке сессии. */
export const treeWord = (s: SessionRow): string => (s.spec.wing ? ` · ведёт ${s.spec.wing.slice(0, s.spec.wing.indexOf("@"))}` : s.lead ? ` · ведомый ${s.lead.slice(0, s.lead.indexOf("@"))}` : s.spec.parent ? ` · от ${s.spec.parent.slice(0, s.spec.parent.indexOf("@"))}` : "");
/** Чья сессия, если не моя: имя человека, который её открыл. */
export const ownerWord = (s: SessionRow, me: string): string => {
  const owner = s.by.includes("~") ? s.by.slice(s.by.indexOf("~")) : "";
  return owner && owner !== me ? ` · ${owner.slice(1).split("@")[0]}` : "";
};

/** Знак строки: «?» — сессия ждёт ответа человека; точка — у человека есть непрочитанное. */
export const rowMark = (s: SessionRow, me: string): "ask" | "new" | null => (s.ask ? "ask" : s.unread?.includes(me) ? "new" : null);

/** Строка сессии в списке: лампа, заголовок, позывной и чем занята, время. Пара — одной строкой: «ведущий ▸ ведомый»; дочерняя — с отступом под родителем. */
export type RowParts = { call: boolean; doing: boolean; when: boolean };
export const ROW_PARTS: RowParts = { call: true, doing: true, when: true };
export function SessionLine({ s, selected, onPick, sub, depth = 0, wing, why, parts = ROW_PARTS }: { s: SessionRow; selected?: boolean; onPick: () => void; sub?: ReactNode; /** глубина под родителем */ depth?: number; /** ведомый пары: стоит в строке ведущего */ wing?: SessionRow; /** почему сессия в «Моих» */ why?: string; /** что показывать в строке — «Вид списка» */ parts?: RowParts }) {
  const me = useFleet((f) => f.you?.person ?? "");
  const offline = useFleet((f) => f.machines[machineOfCall(s.callsign)]?.online === false);
  const mark = rowMark(s, me) ?? (wing ? rowMark(wing, me) : null);
  const labels = useLabels();
  const label = labels[s.callsign];
  return (
    <div className={`row${selected ? " sel" : ""}${mark === "new" ? " unread" : ""}`} role="button" tabIndex={0} data-call={s.callsign} title={why || undefined} style={depth ? { paddingLeft: 14 + Math.min(depth, 4) * 18 } : undefined} onClick={onPick} onKeyDown={(e) => e.key === "Enter" && onPick()}>
      <Lamp state={s.state} offline={offline} />
      <div style={{ minWidth: 0 }}>
        <div className="t trunc">
          {label ?? s.title ?? s.spec.name}
          {wing && <span className="pairmate"><span className="arrow"> ▸ </span><Lamp state={wing.state} offline={offline} /> {labels[wing.callsign] ?? wing.title ?? wing.spec.name}</span>}
        </div>
        {(parts.call || parts.doing || offline) && <div className="sub trunc">{parts.call && <span className="mono">{s.callsign}</span>}{parts.call && (wing ? "" : treeWord(s))}{parts.call && ownerWord(s, me)}{offline ? " · нет связи" : !parts.doing ? "" : sub ?? (s.doing ? ` · ${s.doing}` : s.state === "failed" ? ` · ${s.error ?? "сбой"}` : "")}{s.archiveError && !offline ? " · точка не сохранилась" : ""}</div>}
      </div>
      <span className="when">{mark === "ask" ? <span className="qmark" role="img" aria-label="ждёт ответа">?</span> : mark === "new" ? <span className="newdot" role="img" aria-label="есть новое" /> : null}{parts.when ? <span className="ago">{ago(s.last ?? s.since)}</span> : null}</span>
    </div>
  );
}

/** Чтение запросом договора с кэшем. */
export function useCall<D extends RequestDef<any, any>>(def: D, input: InputOf<D> | null, opts: { refetch?: number } = {}): UseQueryResult<OutputOf<D>> {
  return useQuery({ queryKey: [def.name, input], queryFn: () => api.call(def, input as InputOf<D>), enabled: input !== null, refetchInterval: opts.refetch, retry: false });
}

/** Имена для людей: общая запись флота `labels` — позывной сессии или «@машина» → имя. Где имя есть, оно стоит вместо адреса. */
export function useLabels(): Record<string, string> {
  const q = useCall(prefsGet, { scope: "fleet", prefix: "labels" });
  return (q.data?.values.labels as Record<string, string> | undefined) ?? NO_LABELS;
}
const NO_LABELS: Record<string, string> = {};
/** Имя машины для людей; нет — её имя во флоте. */
export const useMachineName = () => {
  const labels = useLabels();
  return (machine: string) => labels["@" + machine] ?? machine;
};

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
type Ui = { inspector: boolean; set(p: Partial<Ui>): void };
export const useUi = create<Ui>((set) => ({ inspector: true, set: (p) => set(p) }));

const WIDE = "(min-width: 861px)";
export const useWide = (): boolean => useMediaQuery(WIDE, typeof window !== "undefined" && window.matchMedia(WIDE).matches, { getInitialValueInEffect: false }) ?? true;
