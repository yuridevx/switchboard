// Разговор сессии: шапка с документом (правка на месте), лента, вопрос, список дел, ввод. Рядом — инспектор или второй разговор пары.
import { accountList, pointsSave, profileList, sessionCall, sessionRemove, sessionStart, sessionStop, sessionUpdate, type SessionRow, type SpecPatch } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, Drawer, Group, Loader, Menu, Popover, Stack, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconArrowLeft, IconBookmark, IconChevronDown, IconColumns2, IconDots, IconLayoutSidebarRight, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { act } from "../api.ts";
import { EFFORTS, Failed, Lamp, MODELS, MODES, modelWord, STATE_WORD, useCall, useUi } from "../common.tsx";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer } from "./Composer.tsx";
import { Rows, TodoList } from "./Feed.tsx";
import { Inspector } from "./Inspector.tsx";
import { useMarkRead, useTalk } from "./talk.ts";

/** Чип документа сессии: значение и меню замены — один запрос session.update. */
function Chip({ label, value, options, onPick }: { label: string; value?: string; options: ReadonlyArray<readonly [string, string]>; onPick: (v: string) => void }) {
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Badge component="button" type="button" variant="default" rightSection={<IconChevronDown size={11} />} aria-label={label} style={{ cursor: "pointer" }}>{options.find(([v]) => v === value)?.[1] ?? value ?? label}</Badge>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{label}</Menu.Label>
        {options.map(([v, word]) => <Menu.Item key={v} onClick={() => onPick(v)} fw={v === value ? 700 : undefined}>{word}</Menu.Item>)}
      </Menu.Dropdown>
    </Menu>
  );
}

function Header({ s, onBack, pair, onPair }: { s: SessionRow; onBack?: () => void; pair?: boolean; onPair?: () => void }) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const ui = useUi();
  const accounts = useCall(accountList, offline ? null : { to: "@" + machine });
  const pieces = useCall(profileList, offline ? null : { to: "@" + machine });
  const patch = (p: SpecPatch) => act(sessionUpdate, { to: s.callsign, patch: p });
  const busy = s.state === "busy" || s.state === "starting";
  const down = s.state === "stopped" || s.state === "failed";
  const picked = s.spec.pieces ?? [];
  return (
    <div className="pane-head">
      {onBack && <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>}
      <Lamp state={s.state} offline={offline} />
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div className="trunc" style={{ fontWeight: 600 }}>{s.title ?? s.spec.name}</div>
        <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {offline ? "нет связи" : s.doing ?? STATE_WORD[s.state]}</div>
      </div>
      <div className="chiprow">
        <Chip label="Модель" value={s.spec.model} options={MODELS} onPick={(model) => patch({ model })} />
        <Chip label="Усилие" value={s.spec.effort} options={EFFORTS} onPick={(effort) => patch({ effort: effort as never })} />
        <Chip label="Режим" value={s.spec.mode} options={MODES} onPick={(mode) => patch({ mode: mode as never })} />
        <Chip label="Аккаунт" value={s.spec.account} options={[["auto", `auto${s.account ? ` · ${s.account}` : ""}`] as const, ...(accounts.data?.accounts ?? []).map((a) => [a.id, a.id + (a.ok ? "" : " · нет входа")] as const)]} onPick={(account) => patch({ account })} />
        <Popover position="bottom-start" withinPortal>
          <Popover.Target><Badge component="button" type="button" variant="default" rightSection={<IconChevronDown size={11} />} aria-label="Кусочки" style={{ cursor: "pointer" }}>{picked.length ? picked.join(" + ") : "без кусочков"}</Badge></Popover.Target>
          <Popover.Dropdown>
            <Stack gap={6}>
              {(pieces.data?.pieces ?? []).map((p) => (
                <Checkbox key={p.id} size="xs" label={p.title ?? p.id} description={p.ok ? p.about : p.why} disabled={!p.ok} checked={picked.includes(p.id)}
                  onChange={(e) => patch({ pieces: e.currentTarget.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id) })} />
              ))}
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </div>
      <Group gap={4} wrap="nowrap">
        {busy && <Tooltip label="Прервать ход"><ActionIcon variant="default" aria-label="Прервать ход" onClick={() => act(sessionCall, { to: s.callsign, method: "interrupt" })}><IconPlayerStop size={16} /></ActionIcon></Tooltip>}
        {down && <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => act(sessionStart, { to: s.callsign })}>Запустить</Button>}
        <Tooltip label="Сохранить точку"><ActionIcon variant="subtle" aria-label="Сохранить точку" onClick={() => act(pointsSave, { to: s.callsign }, "Точка сохранена")}><IconBookmark size={17} /></ActionIcon></Tooltip>
        {onPair && <Tooltip label="Пара рядом"><ActionIcon variant={pair ? "filled" : "subtle"} className="wide-only" aria-label="Пара рядом" onClick={onPair}><IconColumns2 size={17} /></ActionIcon></Tooltip>}
        <Tooltip label="Инспектор (I)"><ActionIcon variant={ui.inspector && !pair ? "light" : "subtle"} aria-label="Инспектор" onClick={() => ui.set({ inspector: !ui.inspector })}><IconLayoutSidebarRight size={17} /></ActionIcon></Tooltip>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><ActionIcon variant="subtle" aria-label="Ещё"><IconDots size={17} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            {!down && <Menu.Item onClick={() => act(sessionStop, { to: s.callsign })}>Остановить сессию</Menu.Item>}
            <Menu.Item onClick={() => act(sessionCall, { to: s.callsign, method: "reload" }, "Инструменты перечитаны")}>Перечитать инструменты</Menu.Item>
            <Menu.Item color="red" onClick={() => modals.openConfirmModal({ title: `Убрать ${s.callsign}?`, children: <Text size="sm">Сессия уйдёт с машины. Точки в архиве останутся.</Text>, labels: { confirm: "Убрать", cancel: "Оставить" }, confirmProps: { color: "red" }, onConfirm: () => act(sessionRemove, { to: s.callsign }) })}>Убрать сессию</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </div>
  );
}

function Feed({ s }: { s: SessionRow }) {
  const talk = useTalk(s.callsign);
  useMarkRead(s.callsign);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rows = talk.view.rows.length;
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, talk.loading, s.ask?.id]);
  const todos = talk.view.todos?.some((t) => t.status !== "completed") ? talk.view.todos : undefined;
  return (
    <>
      <div className="feed" ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="feed-in">
          {talk.more && <Button variant="subtle" size="xs" onClick={talk.loadMore} style={{ alignSelf: "center" }}>Раньше</Button>}
          {talk.loading ? <Loader size="sm" style={{ alignSelf: "center" }} /> : talk.error ? <Failed error={talk.error} /> : <Rows rows={talk.view.rows} view={talk.view} />}
          {s.state === "failed" && s.error && <div className="ban bad"><Text fw={600} size="sm">Сессия остановилась</Text><Text size="sm">{s.error}</Text></div>}
        </div>
      </div>
      <div className="dock">
        <div className="dock-in">
          {todos && <TodoList todos={todos} />}
          {s.ask && <AskCard callsign={s.callsign} ask={s.ask} />}
          <Composer s={s} />
        </div>
      </div>
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
  const [pair, setPair] = useState(false);
  const [sheet, setSheet] = useState(false);
  useEffect(() => setPair(false), [callsign]);
  if (!s) return <div className="hole">Такой сессии нет: <span className="mono">&nbsp;{callsign}</span></div>;
  const wide = window.matchMedia("(min-width: 861px)").matches;
  const showPair = pair && !!other && wide;
  const showInsp = ui.inspector && !showPair;
  return (
    <div className={`talk${showPair ? " pair" : showInsp ? " with-insp" : ""}`}>
      <div className="conv">
        <Header s={s} onBack={onBack} pair={showPair} onPair={other ? () => setPair((p) => !p) : undefined} />
        <Feed key={s.callsign} s={s} />
      </div>
      {showPair && other && (
        <div className="conv">
          <Header s={other} />
          <Feed key={other.callsign} s={other} />
        </div>
      )}
      {showInsp && wide && <aside className="insp" aria-label="Инспектор"><Inspector s={s} /></aside>}
      {!wide && <Drawer opened={ui.inspector && sheet} onClose={() => setSheet(false)} position="bottom" size="75%" title={s.callsign}><Inspector s={s} /></Drawer>}
      {!wide && <NarrowInspectorOpener onOpen={() => setSheet(true)} />}
    </div>
  );
}

/** На телефоне кнопка инспектора в шапке открывает лист снизу. */
function NarrowInspectorOpener({ onOpen }: { onOpen: () => void }) {
  const inspector = useUi((u) => u.inspector);
  const was = useRef(inspector);
  useEffect(() => {
    if (was.current !== inspector) onOpen();
    was.current = inspector;
  }, [inspector, onOpen]);
  return null;
}
