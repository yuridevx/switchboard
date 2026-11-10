// Разговор сессии: шапка с документом (правка на месте), лента, вопрос, список дел, фон, ввод. Рядом — инспектор или второй разговор пары.
import { accountList, prefsSet, profileList, sessionCall, sessionCompact, sessionRemove, sessionRewind, sessionStart, sessionStop, sessionUpdate, type SessionRow } from "@sb/protocol";
import { ActionIcon, Button, Checkbox, Group, Loader, Menu, MultiSelect, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { Page } from "../shell/Page.tsx";
import { IconArrowDown, IconArrowLeft, IconArrowsMinimize, IconCheck, IconDots, IconEraser, IconLayoutSidebarRight, IconPlayerPlay, IconUserMinus, IconUserPlus } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { act } from "../api.ts";
import { useLocal } from "../lib/local.ts";
import { exportMd, focused } from "../chat/focus.ts";
import { confirmDanger, EFFORTS, Failed, Lamp, MODES, modelWord, personWord, STATE_WORD, useCall, useMachineName, useMyPrefs, useUi, useWide } from "../common.tsx";
import { day, hhmm } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { Asides, Running } from "./Dock.tsx";
import { effectiveModel, modelsFor, patchDoc, useLabels, useLater, useModels } from "./doc.ts";
import { type FeedEnv, FeedEnvProvider, Rows, Tail, TodoList } from "./Feed.tsx";
import { Inspector } from "./Inspector.tsx";
import { type Talk, useMarkRead, useTalk } from "./talk.ts";

const isLive = (s: SessionRow) => s.state !== "stopped" && s.state !== "failed";
const AfterTurn = ({ on }: { on: boolean }) => (on ? <span className="after-turn">после хода</span> : null);

/** Значение документа сессии в ряду под полем ввода: само значение без слова-ярлыка, ярлык — в подсказке и в меню; замена — один запрос session.update. */
function Chip({ label, value, word, options, later, onPick }: { label: string; value?: string; word?: string; options: ReadonlyArray<readonly [string, string]>; later?: boolean; onPick: (v: string) => void }) {
  return (
    <Menu position="top-start" withinPortal>
      <Menu.Target>
        <button type="button" className="docval" aria-label={label} title={label}>{word ?? options.find(([v]) => v === value)?.[1] ?? value}<AfterTurn on={!!later} /></button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{label}</Menu.Label>
        {options.map(([v, w]) => <Menu.Item key={v} onClick={() => onPick(v)} fw={v === value ? 700 : undefined}>{w}</Menu.Item>)}
      </Menu.Dropdown>
    </Menu>
  );
}

function useDoc(s: SessionRow, running?: string) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const accounts = useCall(accountList, offline ? null : { to: "@" + machine });
  const pieces = useCall(profileList, offline ? null : { to: "@" + machine });
  // у сессии на ключе флота модель — та, что записана у ключа
  const mine = accounts.data?.accounts.find((a) => a.id === (s.account ?? s.spec.account));
  const models = modelsFor(mine, useModels(s, !offline && isLive(s)));
  const model = effectiveModel(s.spec, models, running);
  const accountOptions = [["auto", `авто${s.account ? ` · ${s.account}` : ""}`] as const, ...(accounts.data?.accounts ?? []).map((a) => [a.id, a.id + (a.ok ? "" : " · нет входа") + (a.wait ? ` · лимит до ${hhmm(a.wait)}` : "")] as const)];
  const list = pieces.data?.pieces ?? [];
  const title = (id: string) => list.find((p) => p.id === id)?.title ?? id;
  const efforts = model.efforts ? EFFORTS.filter(([e]) => model.efforts!.includes(e)) : EFFORTS;
  return { accountOptions, pieces: list, title, models, model, efforts, later: useLater(s) };
}

/** Документ сессии полями: на телефоне — в листе инспектора, при паре — в окошке шапки. */
export function DocFields({ s }: { s: SessionRow }) {
  const d = useDoc(s);
  return (
    <Stack gap="xs">
      <Select label="Модель" data={d.models.map((m) => ({ value: m.value, label: m.label }))} value={d.model.value || null} onChange={(model) => model && patchDoc(s, { model })} allowDeselect={false} />
      <Select label="Усилие" data={d.efforts.map(([value, label]) => ({ value, label }))} value={s.spec.effort ?? null} placeholder="как у модели" onChange={(effort) => effort && patchDoc(s, { effort: effort as never })} allowDeselect={false} />
      <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={s.spec.mode ?? "all"} onChange={(mode) => mode && patchDoc(s, { mode: mode as never })} allowDeselect={false} />
      <Select label="Аккаунт" data={d.accountOptions.map(([value, label]) => ({ value, label }))} value={s.spec.account ?? "auto"} onChange={(account) => account && patchDoc(s, { account })} allowDeselect={false} />
      <MultiSelect label="Кусочки" data={d.pieces.map((p) => ({ value: p.id, label: p.title ?? p.id, disabled: !p.ok }))} value={s.spec.pieces ?? []} onChange={(pieces) => patchDoc(s, { pieces })} />
    </Stack>
  );
}

/** Что стоит в шапке разговора: человек выбирает сам, выбор помнит устройство. */
export const HEAD_PARTS = [["model", "Модель"], ["effort", "Усилие"], ["account", "Аккаунт"], ["pieces", "Кусочки"], ["machine", "Машина"], ["owner", "Владелец"]] as const;
export const HEAD_DEFAULT: string[] = ["model", "effort", "account", "pieces"];
const HEAD_KEY = "head.parts";
/** Переключить часть шапки: порядок частей — всегда как в списке. */
export const toggleHeadPart = (parts: string[], id: string): string[] => (parts.includes(id) ? parts.filter((p) => p !== id) : HEAD_PARTS.map(([p]) => p as string).filter((p) => p === id || parts.includes(p)));

/** Значения документа сессии одной строкой: режим · модель · усилие · аккаунт · кусочки. */
function DocValues({ s, running }: { s: SessionRow; running?: string }) {
  const [piecesOpen, setPiecesOpen] = useState(false);
  const d = useDoc(s, running);
  const picked = s.spec.pieces ?? [];
  const [parts] = useLocal<string[]>(HEAD_KEY, HEAD_DEFAULT);
  const machineName = useMachineName();
  const on = (p: string) => parts.includes(p);
  return (
    <div className="docvals" role="group" aria-label="Документ сессии">
      <Chip label="Режим" value={s.spec.mode ?? "all"} options={MODES} onPick={(mode) => patchDoc(s, { mode: mode as never })} />
      {on("model") && <Chip label="Модель" value={d.model.value} word={d.model.label} options={d.models.map((m) => [m.value, m.label] as const)} later={d.later.includes("model")} onPick={(model) => patchDoc(s, { model })} />}
      {on("effort") && <Chip label="Усилие" value={s.spec.effort} word={s.spec.effort ? undefined : "усилие модели"} options={d.efforts} later={d.later.includes("effort")} onPick={(effort) => patchDoc(s, { effort: effort as never })} />}
      {on("account") && <Chip label="Аккаунт" value={s.spec.account ?? "auto"} options={d.accountOptions} later={d.later.includes("account")} onPick={(account) => patchDoc(s, { account })} />}
      {on("pieces") && <button type="button" className="docval" aria-label="Кусочки" title="Кусочки" onClick={() => setPiecesOpen(true)}>{picked.length ? picked.map(d.title).join(" + ") : "без кусочков"}<AfterTurn on={d.later.includes("pieces")} /></button>}
      {on("machine") && <Link className="docval" to={`/machine/${machineOfCall(s.callsign)}`} title="Машина">{machineName(machineOfCall(s.callsign))}</Link>}
      {on("owner") && <span className="docval still" title="Открыл">{personWord(s.by.includes("~") ? s.by.slice(s.by.indexOf("~")) : s.by)}</span>}
      <Page name="pieces" opened={piecesOpen} onClose={() => setPiecesOpen(false)} title={`Кусочки ${s.callsign}`}>
        <Stack gap="sm">
          {d.pieces.map((p) => (
            <Checkbox key={p.id} label={p.title ?? p.id} description={p.ok ? p.about : p.why} disabled={!p.ok} checked={picked.includes(p.id)}
              onChange={(e) => patchDoc(s, { pieces: e.currentTarget.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id) })} />
          ))}
        </Stack>
        <Button mt="md" style={{ alignSelf: "flex-start" }} onClick={() => setPiecesOpen(false)}>Готово</Button>
      </Page>
    </div>
  );
}

/** Действия над разговором значками справа: сжать, ведомый, очистить. */
function DocActs({ s }: { s: SessionRow }) {
  if (!isLive(s)) return null;
  return (
    <div className="docacts">
      <Tooltip label="Сжать разговор"><ActionIcon variant="subtle" color="gray" size="md" aria-label="Сжать" disabled={!!s.compacting} onClick={() => act(sessionCompact, { to: s.callsign })}><IconArrowsMinimize size={16} /></ActionIcon></Tooltip>
      {!s.spec.wing && !s.lead && <Tooltip label="Открыть ведомого"><ActionIcon variant="subtle" color="gray" size="md" aria-label="Открыть ведомого" onClick={() => act(sessionUpdate, { to: s.callsign, patch: {}, pair: true })}><IconUserPlus size={16} /></ActionIcon></Tooltip>}
      {s.spec.wing && <Tooltip label="Убрать ведомого"><ActionIcon variant="subtle" color="gray" size="md" aria-label="Убрать ведомого" onClick={() => confirmDanger({ title: `Убрать ведомого ${s.spec.wing}?`, body: `${s.spec.wing} перестанет получать задачи от ${s.callsign} и слать ей вести. Сама сессия ведомого останется.`, confirm: "Убрать ведомого", onConfirm: () => void patchDoc(s, { wing: null }) })}><IconUserMinus size={16} /></ActionIcon></Tooltip>}
      <Tooltip label="Очистить разговор"><ActionIcon variant="subtle" color="gray" size="md" className="far" aria-label="Очистить" onClick={() => confirmDanger({ title: `Очистить разговор ${s.callsign}?`, body: "Разговор начнётся заново: сессия забудет всё, что было сказано. Файлы останутся как есть.", confirm: "Очистить", onConfirm: async () => void (await act(sessionRewind, { to: s.callsign })) })}><IconEraser size={16} /></ActionIcon></Tooltip>
    </div>
  );
}

/** Выбор стороны пары, как в первой версии: лампа и модель каждого участника; участник — только он, он же ещё раз или стрелка — обе стороны. */
function PairPick({ lead, wing, side, onSide, wide }: { lead: SessionRow; wing: SessionRow; side: Side; onSide: (s: Side) => void; wide: boolean }) {
  const same = modelWord(lead.spec.model) === modelWord(wing.spec.model);
  const item = (of: "lead" | "wing", x: SessionRow) => (
    <button type="button" aria-pressed={side === "both" || side === of} aria-label={of === "lead" ? `Ведущий ${x.callsign}` : `Ведомый ${x.callsign}`} title={`${x.callsign} · ${STATE_WORD[x.state]}`} onClick={() => onSide(side === of && wide ? "both" : of)}>
      <Lamp state={x.state} /><b>{modelWord(x.spec.model)}</b>{same && <span>{x.spec.name}</span>}
    </button>
  );
  return (
    <div className="pairpick" role="group" aria-label="Кого показать">
      {item("lead", lead)}
      {wide ? <button type="button" className="arrow" aria-label="Обе стороны" aria-pressed={side === "both"} onClick={() => onSide("both")}>▸</button> : <i aria-hidden="true">▸</i>}
      {item("wing", wing)}
    </div>
  );
}

/** Скрытая сторона пары одной строкой под шапкой: кто это и чем занят; нажатие показывает её. */
function PairStrip({ x, word, onOpen }: { x: SessionRow; word: string; onOpen(): void }) {
  return (
    <button type="button" className="pairstrip" aria-label={`Показать: ${word} ${x.callsign}`} onClick={onOpen}>
      <Lamp state={x.state} /><b>{word}</b><span className="mono">{x.callsign}</span><span className="trunc muted">{x.compacting ? "сжимает контекст" : (x.doing ?? STATE_WORD[x.state])}</span>
    </button>
  );
}

/** Имя сессии для людей: нажатие на заголовок превращает его в поле на том же месте; Enter записывает, Esc отменяет, пустое имя снимает его. Запись — общая для флота. */
function NameButton({ s, shown }: { s: SessionRow; shown: string }) {
  const labels = useLabels();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const put = async () => {
    setOpen(false);
    if (v.trim() === (labels.of(s.callsign) ?? "")) return;
    if (await act(prefsSet, { scope: "fleet", name: "labels", patch: { [s.callsign]: v.trim() || null } }, v.trim() ? "Имя записано" : "Имя снято")) await qc.invalidateQueries({ queryKey: ["prefs.get"] });
  };
  if (open) return (
    <TextInput size="xs" autoFocus aria-label={`Имя для ${s.callsign}`} placeholder={s.title ?? s.spec.name} value={v} onChange={(e) => setV(e.currentTarget.value)} onBlur={() => void put()}
      onKeyDown={(e) => (e.key === "Enter" ? void put() : e.key === "Escape" ? setOpen(false) : undefined)} />
  );
  return <button type="button" className="namebtn trunc" title="Назвать сессию" onClick={() => (setV(labels.of(s.callsign) ?? ""), setOpen(true))}>{shown}</button>;
}

function save(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export type Side = "lead" | "wing" | "both";

function Header({ s, talk, onBack, pair, side, onSide, mates, onSheet, focus, onFocus }: { s: SessionRow; talk: Talk; onBack?: () => void; pair?: boolean; /** сессия в паре: какая сторона показана и как её сменить */ side?: Side; onSide?: (s: Side) => void; mates?: { lead: SessionRow; wing: SessionRow }; onSheet?: () => void; focus: boolean; onFocus(): void }) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const ui = useUi();
  const wide = useWide();
  const prefs = useMyPrefs();
  const labels = useLabels();
  const pins = (prefs.values.pins as string[] | undefined) ?? [];
  const pinned = pins.includes(s.callsign);
  const [parts, setParts] = useLocal<string[]>(HEAD_KEY, HEAD_DEFAULT);
  const down = !isLive(s);
  const midTurn = s.state === "busy" || s.state === "waiting";
  const now = s.compacting ? "сжимает контекст" : (s.doing ?? STATE_WORD[s.state]);
  const tree = s.spec.wing ? `ведёт ${labels.name(s.spec.wing)}` : s.lead ? `ведомый ${labels.name(s.lead)}` : s.spec.parent ? `задача от ${labels.name(s.spec.parent)}` : "";
  return (
    <div className="pane-head conv-head">
      {onBack && <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>}
      <Lamp state={s.state} offline={offline} />
      <div className="h-title">
        <NameButton s={s} shown={labels.of(s.callsign) ?? s.title ?? s.spec.name} />
        <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {offline ? `нет связи · было: ${now}` : now}{tree ? ` · ${tree}` : ""}</div>
      </div>
      <Group gap={4} wrap="nowrap" className="h-acts">
        {down && !offline && <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => act(sessionStart, { to: s.callsign })}>Запустить</Button>}
        {onSide && side && mates && <PairPick lead={mates.lead} wing={mates.wing} side={side === "both" && !wide ? "lead" : side} onSide={onSide} wide={wide} />}
        {onSheet && <Tooltip label="Инспектор (I)"><ActionIcon variant={wide && ui.inspector && !pair ? "light" : "subtle"} aria-label="Инспектор" onClick={() => (wide ? ui.set({ inspector: !ui.inspector }) : onSheet())}><IconLayoutSidebarRight size={17} /></ActionIcon></Tooltip>}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><ActionIcon variant="subtle" aria-label="Ещё"><IconDots size={17} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => prefs.save("pins", pinned ? pins.filter((p) => p !== s.callsign) : [...pins, s.callsign])}>{pinned ? "Открепить" : "Закрепить"}</Menu.Item>
            {wide && (
              <Menu.Sub>
                <Menu.Sub.Target><Menu.Sub.Item>Поля под вводом</Menu.Sub.Item></Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  {HEAD_PARTS.map(([id, word]) => <Menu.Item key={id} closeMenuOnClick={false} leftSection={parts.includes(id) ? <IconCheck size={14} /> : <span style={{ width: 14, display: "inline-block" }} />} onClick={() => setParts(toggleHeadPart(parts, id))}>{word}</Menu.Item>)}
                  <Menu.Divider />
                  <Menu.Item onClick={() => setParts(HEAD_DEFAULT)}>Вернуть</Menu.Item>
                </Menu.Sub.Dropdown>
              </Menu.Sub>
            )}
            <Menu.Item onClick={onFocus}>{focus ? "Вся лента" : "Фокус: только итоги ходов"}</Menu.Item>
            <Menu.Item onClick={() => save(`${s.callsign}.md`, exportMd(s.callsign, talk.view))}>Выгрузить разговор в Markdown</Menu.Item>
            {!down && !offline && <Menu.Item onClick={() => act(sessionStop, { to: s.callsign })}>Остановить сессию</Menu.Item>}
            <Menu.Item color="red" disabled={offline} onClick={() => confirmDanger({
              title: `Убрать ${s.callsign}?`, body: midTurn ? "Идёт ход: сессия уйдёт с машины, когда он кончится. Точки в архиве останутся." : "Сессия уйдёт с машины. Точки в архиве останутся.",
              confirm: midTurn ? "Убрать после хода" : "Убрать", onConfirm: () => act(sessionRemove, { to: s.callsign, ...(midTurn ? { after_turn: true } : {}) }, midTurn ? "Сессия уберётся после хода" : undefined),
            })}>Убрать сессию</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </div>
  );
}

/** Карточки состояния: почему сессия стоит или чего ждёт. */
function StateCards({ s, onWhy }: { s: SessionRow; onWhy(): void }) {
  return (
    <>
      {s.state === "failed" && (
        <div className="statecard bad">
          <Text fw={600} size="sm">Сессия не запустилась</Text>
          {s.error && <Text size="sm">{s.error}</Text>}
          <Group gap="xs"><Button size="compact-xs" variant="default" onClick={() => act(sessionStart, { to: s.callsign })}>Запустить</Button><Button size="compact-xs" variant="subtle" onClick={onWhy}>Почему</Button></Group>
        </div>
      )}
      {s.wait && <div className="statecard"><Text fw={600} size="sm">Ждёт сброса лимита</Text><Text size="sm">Аккаунты очереди исчерпали лимит. Сессия продолжит {day(s.wait)} в {hhmm(s.wait)}.</Text></div>}
      {s.remoteError && <div className="statecard bad"><Text fw={600} size="sm">Remote Control не включился</Text><Text size="sm">{s.remoteError}</Text></div>}
      {s.archiveError && <div className="statecard bad"><Text fw={600} size="sm">Последняя точка не сохранилась</Text><Text size="sm">{s.archiveError}</Text></div>}
    </>
  );
}

/** Шаг отката: что уйдёт — видно до нажатия; после — текст ушедшего сообщения возвращается в поле ввода. */
function Rewind({ s, upto, onDone }: { s: SessionRow; upto: string; onDone(text?: string): void }) {
  const [what, setWhat] = useState<"talk" | "both">("talk");
  const files = what === "both";
  // проба одна на оба варианта: число записей от выбора не зависит, список файлов показывается при «Разговор и файлы»
  const dry = useCall(sessionRewind, { to: s.callsign, upto, files: true, dry: true });
  const midTurn = s.state === "busy" || s.state === "waiting" || s.state === "starting";
  const d = dry.data;
  return (
    <Stack gap="sm">
      <SegmentedControl value={what} onChange={(v) => setWhat(v as "talk" | "both")} data={[{ value: "talk", label: "Только разговор" }, { value: "both", label: "Разговор и файлы" }]} aria-label="Что откатить" />
      {dry.error ? <Failed error={dry.error} /> : !d ? <Loader size="sm" /> : (
        <>
          {d.text && <div className="me" style={{ alignSelf: "stretch", maxWidth: "none" }}><Text size="sm" className="clamp2">{d.text}</Text></div>}
          <Text size="sm">Из разговора уйдёт записей: <b>{d.cut}</b>{d.text ? " — это сообщение и всё после него. Его текст вернётся в поле ввода." : "."}</Text>
          {midTurn && <Text size="sm" c="orange" role="note">Текущий ход прервётся</Text>}
          {files && (
            <div className="card" style={{ gap: 2 }}>
              <Text size="sm" fw={600}>Файлы вернутся к состоянию до этого сообщения · <span style={{ color: "var(--st-idle)" }}>+{d.plus ?? 0}</span> <span style={{ color: "var(--st-failed)" }}>−{d.minus ?? 0}</span></Text>
              {(d.files ?? []).map((f) => <div key={f} className="line mono" style={{ fontSize: 12.5 }}>{f}</div>)}
              {!d.files?.length && <Text size="sm" className="muted">Файлы с этого сообщения не менялись</Text>}
            </div>
          )}
        </>
      )}
      <Group gap="sm">
        <Button color="red" disabled={!d} onClick={async () => { const r = await act(sessionRewind, { to: s.callsign, upto, files }); if (r) onDone(r.text); }}>Откатить</Button>
        <Button variant="default" onClick={() => onDone()}>Отмена</Button>
      </Group>
    </Stack>
  );
}

function FeedPane({ s, talk, focus, autoFocus, pair, onWhy }: { s: SessionRow; talk: Talk; focus: boolean; autoFocus?: boolean; pair?: boolean; onWhy(): void }) {
  const machine = machineOfCall(s.callsign);
  const m = useFleet((f) => f.machines[machine]);
  const me = useFleet((f) => f.you?.person);
  const offline = m?.online === false;
  const labels = useLabels();
  useMarkRead(s.callsign);
  const box = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const [stuck, setStuck] = useState(true);
  const [rewindAt, setRewindAt] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const stick = useRef(true);
  const items = useMemo(() => (focus ? focused(talk.view) : talk.view.rows), [focus, talk.view]);
  const toLast = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setStuck(true);
  };
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [talk.events, talk.loading, talk.asides]);
  // вопрос сессии стоит карточками в конце ленты: лента встаёт на первый неотвеченный и больше сама вниз не едет
  useEffect(() => {
    const el = box.current, card = el?.querySelector<HTMLElement>("[data-ask][data-open]");
    if (!el || !card || talk.loading) return;
    stick.current = false;
    el.scrollTop = Math.max(0, card.offsetTop - 12);
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, [s.ask?.id, talk.loading]);
  const todos = talk.view.todos?.some((t) => t.status !== "completed") ? talk.view.todos : undefined;
  const live = isLive(s) && !offline;
  const env = useMemo<FeedEnv>(() => ({
    canAct: live, me, waiting: s.ask?.id,
    act: (method, args) => void act(sessionCall, { to: s.callsign, method, args }, method === "tasks" ? "Ушло в фон" : "Остановлено"),
    // снятое с очереди сообщение возвращает свой текст в поле ввода
    cancel: (id) => void talk.cancel(id).then((text) => text && composer.current?.giveBack(text)), resend: talk.resend, drop: talk.drop,
    edit: (text) => composer.current?.setText(text),
    rewind: setRewindAt,
    name: labels.name,
  }), [live, me, s.ask?.id, s.callsign, talk.cancel, talk.resend, talk.drop, labels.name]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="feed-wrap">
        <div className={`feed${drop ? " drop" : ""}`} ref={box}
          onScroll={(e) => { const el = e.currentTarget; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; stick.current = near; setStuck(near); }}
          onDragOver={(e) => live && e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDrop(true))}
          onMouseUp={() => pair && window.getSelection()?.isCollapsed !== false && composer.current?.focus()}
          onDragLeave={() => setDrop(false)}
          onDrop={(e) => { if (!live || !e.dataTransfer.files.length) return; e.preventDefault(); setDrop(false); composer.current?.addFiles([...e.dataTransfer.files]); }}>
          <div className="feed-in">
            {offline && (
              <div className="ban">
                <Text fw={600} size="sm">Машина {machine} без связи с {hhmm(m!.since)}</Text>
                <Text size="sm">Сессией нельзя управлять, пока машина не вернётся. <Link to={`/machine/${machine}`}>Что известно о машине</Link></Text>
              </div>
            )}
            {talk.more && <Button variant="subtle" size="xs" onClick={talk.loadMore} style={{ alignSelf: "center" }}>Раньше</Button>}
            <FeedEnvProvider value={env}>
              {talk.loading ? <Loader size="sm" style={{ alignSelf: "center" }} /> : talk.error ? <Failed error={talk.error} /> : !items.length && live ? <Text size="sm" className="muted" ta="center">Сообщений пока нет</Text> : <Rows rows={items} view={talk.view} />}
            </FeedEnvProvider>
            {live && <Tail view={talk.view} compacting={s.compacting} />}
            <StateCards s={s} onWhy={onWhy} />
            {s.ask && !offline && <AskCard key={s.ask.id} callsign={s.callsign} ask={s.ask} />}
          </div>
        </div>
        {!stuck && <Button className="to-last" size="compact-sm" variant="default" leftSection={<IconArrowDown size={14} />} onClick={toLast}>К последнему</Button>}
      </div>
      <Page name="rewind" opened={!!rewindAt} onClose={() => setRewindAt(null)} title={`Откатить ${s.callsign}`}>
        {rewindAt && <Rewind s={s} upto={rewindAt} onDone={(text) => (setRewindAt(null), text && composer.current?.setText(text))} />}
      </Page>
      {!offline && (
        <div className="dock">
          <div className="dock-in">
            {todos && <TodoList todos={todos} fold />}
            {live && <FeedEnvProvider value={env}><Running callsign={s.callsign} view={talk.view} /></FeedEnvProvider>}
            <Asides asides={talk.asides} drop={talk.dropAside} />
            <Composer ref={composer} s={s} talk={talk} hint={s.state === "idle" ? talk.view.hint : undefined} autoFocus={autoFocus} values={<DocValues s={s} running={talk.view.model} />} acts={<DocActs s={s} />} />
          </div>
        </div>
      )}
    </>
  );
}

/** Один разговор: шапка и лента. */
function Column({ s, pair, primary, onBack, side, onSide, mates, onSheet, onWhy, onView }: { s: SessionRow; pair?: boolean; primary?: boolean; onBack?: () => void; side?: Side; onSide?: (s: Side) => void; mates?: { lead: SessionRow; wing: SessionRow }; onSheet?: () => void; onWhy(): void; onView?(talk: Talk): void }) {
  const talk = useTalk(s.callsign);
  const [focus, setFocus] = useState(false);
  useEffect(() => onView?.(talk), [talk.view]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="conv">
      <Header s={s} talk={talk} onBack={onBack} pair={pair} side={side} onSide={onSide} mates={mates} onSheet={onSheet} focus={focus} onFocus={() => setFocus((f) => !f)} />
      {mates && onSide && side && side !== "both" && <PairStrip x={side === "lead" ? mates.wing : mates.lead} word={side === "lead" ? "ведомый" : "ведущий"} onOpen={() => onSide(side === "lead" ? "wing" : "lead")} />}
      <FeedPane key={s.callsign} s={s} talk={talk} focus={focus} autoFocus={primary && pair} pair={pair} onWhy={onWhy} />
    </div>
  );
}

/** Пара сессии: позывные ведущего и ведомого, если оба есть в картине. */
export function pairOf(sessions: Record<string, SessionRow>, callsign: string): { lead: string; wing: string } | null {
  const x = sessions[callsign];
  if (!x) return null;
  const lead = x.spec.wing ? x.callsign : (x.lead ?? (x.spec.parent && sessions[x.spec.parent]?.spec.wing === callsign ? x.spec.parent : undefined));
  const wing = lead ? sessions[lead]?.spec.wing ?? (lead !== callsign ? callsign : undefined) : undefined;
  return lead && wing && sessions[lead] && sessions[wing] ? { lead, wing } : null;
}
/** Где устройство помнит, какую сторону пары человек смотрел последней. */
export const pairKey = (lead: string) => "pair." + lead;

export function Conversation({ callsign, onBack }: { callsign: string; onBack?: () => void }) {
  const s = useFleet((f) => f.sessions[callsign]);
  const duo = useFleet((f) => { const p = pairOf(f.sessions, callsign); return p ? `${p.lead} ${p.wing}` : ""; });
  const [leadCall = "", wingCall = ""] = duo.split(" ");
  const other = useFleet((f) => (duo ? f.sessions[callsign === leadCall ? wingCall : leadCall] : undefined));
  const ui = useUi();
  const wide = useWide();
  const go = useNavigate();
  const here = useLocation().pathname;
  // какую сторону пары показать, помнит устройство: «обе» — два разговора рядом, иначе — тот, что в адресе
  const [stored, setStored] = useLocal<Side>(pairKey(leadCall || "-"), "lead");
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState("doc");
  const [talk, setTalk] = useState<Talk | null>(null);
  useEffect(() => (setSheet(false), setTab("doc")), [callsign]);
  if (!s) return <div className="hole">Такой сессии нет: <span className="mono">&nbsp;{callsign}</span></div>;
  const showPair = !!other && stored === "both" && wide;
  const side: Side | undefined = other ? (showPair ? "both" : callsign === wingCall ? "wing" : "lead") : undefined;
  const pickSide = (next: Side) => {
    setStored(next);
    const want = next === "wing" ? wingCall : next === "lead" ? leadCall : callsign;
    if (want !== callsign) go(here.replace(/[^/]+$/, want));
  };
  const showInsp = ui.inspector && !showPair;
  const why = () => (setTab("log"), wide ? ui.set({ inspector: true }) : setSheet(true), showPair && setStored(callsign === wingCall ? "wing" : "lead"));
  const inspector = <Inspector s={s} other={other} view={talk?.view} tab={tab} onTab={setTab} />;
  // пара рядом: ведущий слева, ведомый справа
  const left = showPair && other && callsign === wingCall ? other : s;
  const right = showPair && other ? (left === s ? other : s) : undefined;
  return (
    <div className={`talk${showPair ? " pair" : showInsp ? " with-insp" : ""}`}>
      <Column key={left.callsign} s={left} primary={left === s} pair={showPair} onBack={onBack} side={side} onSide={other ? pickSide : undefined} mates={other ? { lead: callsign === leadCall ? s : other, wing: callsign === leadCall ? other : s } : undefined} onSheet={() => setSheet(true)} onWhy={why} onView={left === s ? setTalk : undefined} />
      {right && <Column key={right.callsign} s={right} primary={right === s} pair onWhy={why} onView={right === s ? setTalk : undefined} />}
      {showInsp && wide && <aside className="insp" aria-label="Инспектор">{inspector}</aside>}
      {!wide && <Page name="info" opened={sheet} onClose={() => setSheet(false)} title={s.callsign}>{inspector}</Page>}
    </div>
  );
}
