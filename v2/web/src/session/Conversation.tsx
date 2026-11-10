// Разговор сессии: шапка с документом (правка на месте), лента, вопрос, список дел, фон, ввод. Рядом — инспектор или второй разговор пары.
import { accountList, profileList, sessionCall, sessionRemove, sessionStart, sessionStop, type SessionRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, Drawer, Group, Loader, Menu, MultiSelect, Popover, Select, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowLeft, IconChevronDown, IconColumns2, IconDots, IconLayoutSidebarRight, IconPlayerPlay } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { act } from "../api.ts";
import { exportMd, focused } from "../chat/focus.ts";
import { confirmDanger, EFFORTS, Failed, Lamp, MODES, STATE_WORD, useCall, useMyPrefs, useUi, useWide } from "../common.tsx";
import { day, hhmm } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { Asides, Background } from "./Dock.tsx";
import { effectiveModel, patchDoc, useLabels, useLater, useModels } from "./doc.ts";
import { type FeedEnv, FeedEnvProvider, Rows, Tail, TodoList } from "./Feed.tsx";
import { Inspector } from "./Inspector.tsx";
import { type Talk, useMarkRead, useTalk } from "./talk.ts";

const isLive = (s: SessionRow) => s.state !== "stopped" && s.state !== "failed";
const AfterTurn = ({ on }: { on: boolean }) => (on ? <span className="after-turn">после хода</span> : null);

/** Чип документа сессии: «что это · значение» и меню замены — один запрос session.update. */
function Chip({ label, value, word, options, later, onPick }: { label: string; value?: string; word?: string; options: ReadonlyArray<readonly [string, string]>; later?: boolean; onPick: (v: string) => void }) {
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Badge component="button" type="button" variant="default" rightSection={<IconChevronDown size={11} />} aria-label={label} style={{ cursor: "pointer" }}>
          <span className="muted">{label.toLowerCase()}</span> {word ?? options.find(([v]) => v === value)?.[1] ?? value} <AfterTurn on={!!later} />
        </Badge>
      </Menu.Target>
      <Menu.Dropdown>
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
  const models = useModels(s, !offline && isLive(s));
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

function Chips({ s, running }: { s: SessionRow; running?: string }) {
  const d = useDoc(s, running);
  const picked = s.spec.pieces ?? [];
  return (
    <div className="chiprow h-chips wide-only">
      <Chip label="Модель" value={d.model.value} word={d.model.label} options={d.models.map((m) => [m.value, m.label] as const)} later={d.later.includes("model")} onPick={(model) => patchDoc(s, { model })} />
      <Chip label="Усилие" value={s.spec.effort} word={s.spec.effort ? undefined : "как у модели"} options={d.efforts} later={d.later.includes("effort")} onPick={(effort) => patchDoc(s, { effort: effort as never })} />
      <Chip label="Аккаунт" value={s.spec.account ?? "auto"} options={d.accountOptions} later={d.later.includes("account")} onPick={(account) => patchDoc(s, { account })} />
      <Popover position="bottom-start" withinPortal>
        <Popover.Target>
          <Badge component="button" type="button" variant="default" rightSection={<IconChevronDown size={11} />} aria-label="Кусочки" style={{ cursor: "pointer" }}>
            <span className="muted">кусочки</span> {picked.length ? picked.map(d.title).join(" + ") : "нет"} <AfterTurn on={d.later.includes("pieces")} />
          </Badge>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap={6}>
            {d.pieces.map((p) => (
              <Checkbox key={p.id} size="xs" label={p.title ?? p.id} description={p.ok ? p.about : p.why} disabled={!p.ok} checked={picked.includes(p.id)}
                onChange={(e) => patchDoc(s, { pieces: e.currentTarget.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id) })} />
            ))}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

function save(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Header({ s, talk, onBack, pair, onPair, onSheet, focus, onFocus }: { s: SessionRow; talk: Talk; onBack?: () => void; pair?: boolean; onPair?: () => void; onSheet?: () => void; focus: boolean; onFocus(): void }) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const ui = useUi();
  const wide = useWide();
  const prefs = useMyPrefs();
  const labels = useLabels();
  const pins = (prefs.values.pins as string[] | undefined) ?? [];
  const pinned = pins.includes(s.callsign);
  const down = !isLive(s);
  const midTurn = s.state === "busy" || s.state === "waiting";
  const now = s.compacting ? "сжимает контекст" : (s.doing ?? STATE_WORD[s.state]);
  const tree = s.spec.wing ? `ведёт ${labels.name(s.spec.wing)}` : s.lead ? `ведомый ${labels.name(s.lead)}` : s.spec.parent ? `задача от ${labels.name(s.spec.parent)}` : "";
  return (
    <div className="pane-head conv-head">
      {onBack && <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>}
      <Lamp state={s.state} offline={offline} />
      <div className="h-title">
        <div className="trunc" style={{ fontWeight: 600 }}>{labels.of(s.callsign) ?? s.title ?? s.spec.name}</div>
        <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {offline ? `нет связи · было: ${now}` : now}{tree ? ` · ${tree}` : ""}</div>
      </div>
      {!offline && !pair && <Chips s={s} running={talk.view.model} />}
      <Group gap={4} wrap="nowrap" className="h-acts">
        {down && !offline && <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => act(sessionStart, { to: s.callsign })}>Запустить</Button>}
        {pair && !offline && (
          <Popover position="bottom-end" withinPortal width={280}>
            <Popover.Target><Button size="compact-xs" variant="default" rightSection={<IconChevronDown size={12} />}>Документ</Button></Popover.Target>
            <Popover.Dropdown><DocFields s={s} /></Popover.Dropdown>
          </Popover>
        )}
        {onPair && <Tooltip label="Пара рядом"><ActionIcon variant={pair ? "light" : "subtle"} className="wide-only" aria-label="Пара рядом" onClick={onPair}><IconColumns2 size={17} /></ActionIcon></Tooltip>}
        {onSheet && <Tooltip label="Инспектор (I)"><ActionIcon variant={wide && ui.inspector && !pair ? "light" : "subtle"} aria-label="Инспектор" onClick={() => (wide ? ui.set({ inspector: !ui.inspector }) : onSheet())}><IconLayoutSidebarRight size={17} /></ActionIcon></Tooltip>}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><ActionIcon variant="subtle" aria-label="Ещё"><IconDots size={17} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            {!wide && <Menu.Item onClick={() => prefs.save("pins", pinned ? pins.filter((p) => p !== s.callsign) : [...pins, s.callsign])}>{pinned ? "Открепить" : "Закрепить"}</Menu.Item>}
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
  }, [talk.events, talk.loading, s.ask?.id, talk.asides]);
  const todos = talk.view.todos?.some((t) => t.status !== "completed") ? talk.view.todos : undefined;
  const live = isLive(s) && !offline;
  const env = useMemo<FeedEnv>(() => ({
    canAct: live, me, waiting: s.ask?.id,
    act: (method, args) => void act(sessionCall, { to: s.callsign, method, args }, method === "tasks" ? "Ушло в фон" : "Остановлено"),
    cancel: (id) => void talk.cancel(id), resend: talk.resend, drop: talk.drop,
    edit: (text) => composer.current?.setText(text),
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
          </div>
        </div>
        {!stuck && <Button className="to-last" size="compact-sm" variant="default" leftSection={<IconArrowDown size={14} />} onClick={toLast}>К последнему</Button>}
      </div>
      {!offline && (
        <div className="dock">
          <div className="dock-in">
            {todos && <TodoList todos={todos} />}
            {live && <Background callsign={s.callsign} view={talk.view} />}
            <Asides asides={talk.asides} drop={talk.dropAside} />
            {s.ask && <AskCard callsign={s.callsign} ask={s.ask} />}
            <Composer ref={composer} s={s} talk={talk} hint={s.state === "idle" ? talk.view.hint : undefined} autoFocus={autoFocus} />
          </div>
        </div>
      )}
    </>
  );
}

/** Один разговор: шапка и лента. */
function Column({ s, pair, primary, onBack, onPair, onSheet, onWhy, onView }: { s: SessionRow; pair?: boolean; primary?: boolean; onBack?: () => void; onPair?: () => void; onSheet?: () => void; onWhy(): void; onView?(talk: Talk): void }) {
  const talk = useTalk(s.callsign);
  const [focus, setFocus] = useState(false);
  useEffect(() => onView?.(talk), [talk.view]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="conv">
      <Header s={s} talk={talk} onBack={onBack} pair={pair} onPair={onPair} onSheet={onSheet} focus={focus} onFocus={() => setFocus((f) => !f)} />
      <FeedPane key={s.callsign} s={s} talk={talk} focus={focus} autoFocus={primary && pair} pair={pair} onWhy={onWhy} />
    </div>
  );
}

export function Conversation({ callsign, onBack }: { callsign: string; onBack?: () => void }) {
  const s = useFleet((f) => f.sessions[callsign]);
  const other = useFleet((f) => {
    const x = f.sessions[callsign];
    const c = x?.spec.wing ?? x?.lead ?? (x?.spec.parent && f.sessions[x.spec.parent]?.spec.wing === callsign ? x.spec.parent : undefined);
    return c ? f.sessions[c] : undefined;
  });
  const ui = useUi();
  const wide = useWide();
  const [pair, setPair] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState("doc");
  const [talk, setTalk] = useState<Talk | null>(null);
  useEffect(() => (setPair(false), setSheet(false), setTab("doc")), [callsign]);
  if (!s) return <div className="hole">Такой сессии нет: <span className="mono">&nbsp;{callsign}</span></div>;
  const showPair = pair && !!other && wide;
  const showInsp = ui.inspector && !showPair;
  const why = () => (setTab("log"), wide ? ui.set({ inspector: true }) : setSheet(true), setPair(false));
  const inspector = <Inspector s={s} view={talk?.view} tab={tab} onTab={setTab} />;
  return (
    <div className={`talk${showPair ? " pair" : showInsp ? " with-insp" : ""}`}>
      <Column key={s.callsign} s={s} primary pair={showPair} onBack={onBack} onPair={other ? () => setPair((p) => !p) : undefined} onSheet={() => setSheet(true)} onWhy={why} onView={setTalk} />
      {showPair && other && <Column key={other.callsign} s={other} pair onWhy={why} />}
      {showInsp && wide && <aside className="insp" aria-label="Инспектор">{inspector}</aside>}
      {!wide && <Drawer opened={sheet} onClose={() => setSheet(false)} position="bottom" size="80%" title={s.callsign}>{inspector}</Drawer>}
    </div>
  );
}
