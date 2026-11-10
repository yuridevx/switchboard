// Разговор сессии: шапка с документом (правка на месте), лента, вопрос, список дел, ввод. Рядом — инспектор или второй разговор пары.
import { accountList, profileList, sessionCall, sessionRemove, sessionStart, sessionStop, sessionUpdate, type SessionRow, type SpecPatch } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, Drawer, Group, Loader, Menu, MultiSelect, Popover, Select, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowLeft, IconChevronDown, IconColumns2, IconDots, IconLayoutSidebarRight, IconPlayerPlay } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { act } from "../api.ts";
import { confirmDanger, EFFORTS, Failed, Lamp, MODELS, MODES, STATE_WORD, useCall, useMyPrefs, useUi, useWide } from "../common.tsx";
import { hhmm } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer } from "./Composer.tsx";
import { Rows, TodoList } from "./Feed.tsx";
import { Inspector } from "./Inspector.tsx";
import { useMarkRead, useTalk } from "./talk.ts";

/** Чип документа сессии: «что это · значение» и меню замены — один запрос session.update. */
function Chip({ label, value, options, onPick }: { label: string; value?: string; options: ReadonlyArray<readonly [string, string]>; onPick: (v: string) => void }) {
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Badge component="button" type="button" variant="default" rightSection={<IconChevronDown size={11} />} aria-label={label} style={{ cursor: "pointer" }}>
          <span className="muted">{label.toLowerCase()}</span> {options.find(([v]) => v === value)?.[1] ?? value ?? "не задано"}
        </Badge>
      </Menu.Target>
      <Menu.Dropdown>
        {options.map(([v, word]) => <Menu.Item key={v} onClick={() => onPick(v)} fw={v === value ? 700 : undefined}>{word}</Menu.Item>)}
      </Menu.Dropdown>
    </Menu>
  );
}

function useDoc(s: SessionRow, offline: boolean) {
  const machine = machineOfCall(s.callsign);
  const accounts = useCall(accountList, offline ? null : { to: "@" + machine });
  const pieces = useCall(profileList, offline ? null : { to: "@" + machine });
  const patch = (p: SpecPatch) => act(sessionUpdate, { to: s.callsign, patch: p });
  const accountOptions = [["auto", `авто${s.account ? ` · ${s.account}` : ""}`] as const, ...(accounts.data?.accounts ?? []).map((a) => [a.id, a.id + (a.ok ? "" : " · нет входа")] as const)];
  const list = pieces.data?.pieces ?? [];
  const title = (id: string) => list.find((p) => p.id === id)?.title ?? id;
  return { patch, accountOptions, pieces: list, title };
}

/** Документ сессии полями: на телефоне — в листе инспектора, при паре — в окошке шапки. */
export function DocFields({ s }: { s: SessionRow }) {
  const d = useDoc(s, false);
  return (
    <Stack gap="xs">
      <Select label="Модель" data={MODELS.map(([value, label]) => ({ value, label }))} value={s.spec.model ?? null} onChange={(model) => model && d.patch({ model })} allowDeselect={false} />
      <Select label="Усилие" data={EFFORTS.map(([value, label]) => ({ value, label }))} value={s.spec.effort ?? null} onChange={(effort) => effort && d.patch({ effort: effort as never })} allowDeselect={false} />
      <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={s.spec.mode ?? null} onChange={(mode) => mode && d.patch({ mode: mode as never })} allowDeselect={false} />
      <Select label="Аккаунт" data={d.accountOptions.map(([value, label]) => ({ value, label }))} value={s.spec.account ?? "auto"} onChange={(account) => account && d.patch({ account })} allowDeselect={false} />
      <MultiSelect label="Кусочки" data={d.pieces.map((p) => ({ value: p.id, label: p.title ?? p.id, disabled: !p.ok }))} value={s.spec.pieces ?? []} onChange={(pieces) => d.patch({ pieces })} />
    </Stack>
  );
}

function Chips({ s }: { s: SessionRow }) {
  const d = useDoc(s, false);
  const picked = s.spec.pieces ?? [];
  return (
    <div className="chiprow h-chips wide-only">
      <Chip label="Модель" value={s.spec.model} options={MODELS} onPick={(model) => d.patch({ model })} />
      <Chip label="Усилие" value={s.spec.effort} options={EFFORTS} onPick={(effort) => d.patch({ effort: effort as never })} />
      <Chip label="Режим" value={s.spec.mode} options={MODES} onPick={(mode) => d.patch({ mode: mode as never })} />
      <Chip label="Аккаунт" value={s.spec.account ?? "auto"} options={d.accountOptions} onPick={(account) => d.patch({ account })} />
      <Popover position="bottom-start" withinPortal>
        <Popover.Target>
          <Badge component="button" type="button" variant="default" rightSection={<IconChevronDown size={11} />} aria-label="Кусочки" style={{ cursor: "pointer" }}>
            <span className="muted">кусочки</span> {picked.length ? picked.map(d.title).join(" + ") : "нет"}
          </Badge>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap={6}>
            {d.pieces.map((p) => (
              <Checkbox key={p.id} size="xs" label={p.title ?? p.id} description={p.ok ? p.about : p.why} disabled={!p.ok} checked={picked.includes(p.id)}
                onChange={(e) => d.patch({ pieces: e.currentTarget.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id) })} />
            ))}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

function Header({ s, onBack, pair, onPair, onSheet }: { s: SessionRow; onBack?: () => void; pair?: boolean; onPair?: () => void; onSheet?: () => void }) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const ui = useUi();
  const wide = useWide();
  const prefs = useMyPrefs();
  const pins = (prefs.values.pins as string[] | undefined) ?? [];
  const pinned = pins.includes(s.callsign);
  const down = s.state === "stopped" || s.state === "failed";
  return (
    <div className="pane-head conv-head">
      {onBack && <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>}
      <Lamp state={s.state} offline={offline} />
      <div className="h-title">
        <div className="trunc" style={{ fontWeight: 600 }}>{s.title ?? s.spec.name}</div>
        <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {offline ? `нет связи · было: ${s.doing ?? STATE_WORD[s.state]}` : s.doing ?? STATE_WORD[s.state]}</div>
      </div>
      {!offline && !pair && <Chips s={s} />}
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
            {!down && !offline && <Menu.Item onClick={() => act(sessionStop, { to: s.callsign })}>Остановить сессию</Menu.Item>}
            <Menu.Item color="red" disabled={offline} onClick={() => confirmDanger({ title: `Убрать ${s.callsign}?`, body: "Сессия уйдёт с машины. Точки в архиве останутся.", confirm: "Убрать", onConfirm: () => act(sessionRemove, { to: s.callsign }) })}>Убрать сессию</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </div>
  );
}

function Feed({ s }: { s: SessionRow }) {
  const machine = machineOfCall(s.callsign);
  const m = useFleet((f) => f.machines[machine]);
  const offline = m?.online === false;
  const talk = useTalk(s.callsign);
  useMarkRead(s.callsign);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** своё сообщение в очереди → номер сообщения у сессии: им оно отменяется */
  const queued = useRef(new Map<string, string>());
  const rows = talk.view.rows.length;
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, talk.loading, s.ask?.id]);
  const todos = talk.view.todos?.some((t) => t.status !== "completed") ? talk.view.todos : undefined;
  const { unsay } = talk;
  const cancel = useCallback(async (local: string) => {
    const uuid = queued.current.get(local);
    if (await act(sessionCall, { to: s.callsign, method: "cancelMessage", args: { uuid } }, "Сообщение снято с очереди")) unsay(local);
  }, [s.callsign, unsay]);
  return (
    <>
      <div className="feed" ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="feed-in">
          {offline && (
            <div className="ban">
              <Text fw={600} size="sm">Машина {machine} без связи с {hhmm(m!.since)}</Text>
              <Text size="sm">Сессией нельзя управлять, пока машина не вернётся. <Link to={`/machine/${machine}`}>Что известно о машине</Link></Text>
            </div>
          )}
          {talk.more && <Button variant="subtle" size="xs" onClick={talk.loadMore} style={{ alignSelf: "center" }}>Раньше</Button>}
          {talk.loading ? <Loader size="sm" style={{ alignSelf: "center" }} /> : talk.error ? <Failed error={talk.error} /> : <Rows rows={talk.view.rows} view={talk.view} onCancel={cancel} />}
          {s.state === "failed" && s.error && <div className="ban bad"><Text fw={600} size="sm">Сессия остановилась</Text><Text size="sm">{s.error}</Text></div>}
        </div>
      </div>
      {!offline && (
        <div className="dock">
          <div className="dock-in">
            {todos && <TodoList todos={todos} />}
            {s.ask && <AskCard callsign={s.callsign} ask={s.ask} />}
            <Composer s={s} say={talk.say} unsay={talk.unsay} bind={(local, uuid) => void queued.current.set(local, uuid)} />
          </div>
        </div>
      )}
    </>
  );
}

export function Conversation({ callsign, onBack }: { callsign: string; onBack?: () => void }) {
  const s = useFleet((f) => f.sessions[callsign]);
  const other = useFleet((f) => {
    const x = f.sessions[callsign];
    const c = x?.spec.wing ?? (x?.spec.parent && f.sessions[x.spec.parent]?.spec.wing === callsign ? x.spec.parent : undefined);
    return c ? f.sessions[c] : undefined;
  });
  const ui = useUi();
  const wide = useWide();
  const [pair, setPair] = useState(false);
  const [sheet, setSheet] = useState(false);
  useEffect(() => (setPair(false), setSheet(false)), [callsign]);
  if (!s) return <div className="hole">Такой сессии нет: <span className="mono">&nbsp;{callsign}</span></div>;
  const showPair = pair && !!other && wide;
  const showInsp = ui.inspector && !showPair;
  return (
    <div className={`talk${showPair ? " pair" : showInsp ? " with-insp" : ""}`}>
      <div className="conv">
        <Header s={s} onBack={onBack} pair={showPair} onPair={other ? () => setPair((p) => !p) : undefined} onSheet={() => setSheet(true)} />
        <Feed key={s.callsign} s={s} />
      </div>
      {showPair && other && (
        <div className="conv">
          <Header s={other} pair />
          <Feed key={other.callsign} s={other} />
        </div>
      )}
      {showInsp && wide && <aside className="insp" aria-label="Инспектор"><Inspector s={s} /></aside>}
      {!wide && <Drawer opened={sheet} onClose={() => setSheet(false)} position="bottom" size="80%" title={s.callsign}><Inspector s={s} /></Drawer>}
    </div>
  );
}
