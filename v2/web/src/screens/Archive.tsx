// «Архив»: каталог сессий с поиском по словам; сессия архива — разговор с точками в ленте и линия точек по дням;
// поднять, копия, перенос, откат, вызовы модели, выгрузка на свой компьютер, удаление.
import { parsePass, peopleList, pointsCalls, pointsDelete, pointsHistory, pointsList, pointsStats, type ArchPoint, type ArchSession, type OutputOf } from "@sb/protocol";
import { ActionIcon, Badge, Button, CopyButton, Group, Loader, Menu, SegmentedControl, Select, Table, Text, TextInput } from "@mantine/core";
import { Page } from "../shell/Page.tsx";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowLeft, IconDots, IconSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { create } from "zustand";
import { act, api, isMock, keyStore } from "../api.ts";
import { fold, type Msg } from "../chat/fold.ts";
import { Failed, modelWord, useCall, useMachineName, useWide } from "../common.tsx";
import { ago, byDay, bytesWord, day, hhmm, kilo, nCalls, nPoints, nSessions, nTurns } from "../lib/time.ts";
import { useSplit } from "../lib/Split.tsx";
import { Rows } from "../session/Feed.tsx";
import { useFleet } from "../store/fleet.ts";
import { DeleteTyped, Raise, RAISE_TITLE, type RaiseKind } from "./archive/Raise.tsx";
import { fireCount } from "./fleet/Machines.tsx";

/** Сводка архива: сколько сессий в нём, сколько из них идёт сейчас, сколько только в архиве, сколько живых сессий точек не сохраняет. */
export function archiveSummary(archive: Array<Pick<ArchSession, "callsign" | "bytes" | "live">>, live: Array<{ callsign: string; spec: { backup?: boolean } }>) {
  const running = new Set(live.map((s) => s.callsign));
  const going = archive.filter((a) => a.live ?? running.has(a.callsign)).length;
  return { total: archive.length, going, only: archive.length - going, bytes: archive.reduce((n, a) => n + (a.bytes ?? 0), 0), bare: live.filter((s) => !s.spec.backup).map((s) => s.callsign).sort() };
}

/** Ветки линии точек: точка с base, которая не стоит сразу за своей основой, — начало ветки; ответ — глубина отступа и основа. */
export function branches(points: Array<{ point: string; base?: string }>): Record<string, { depth: number; from?: string }> {
  const out: Record<string, { depth: number; from?: string }> = {};
  points.forEach((p, i) => {
    const prev = points[i - 1]?.point;
    if (!p.base || p.base === prev) return void (out[p.point] = { depth: prev && out[prev] ? out[prev]!.depth : 0 });
    out[p.point] = { depth: (out[p.base]?.depth ?? 0) + 1, from: p.base };
  });
  return out;
}

/** Запрос и фильтры архива живут, пока открыта страница: уход в другой раздел их не стирает. */
type Ui = { q: string; machine: string | null; project: string | null; period: string; order: "last" | "tokens" };
const useArchiveUi = create<Ui & { set(p: Partial<Ui>): void }>((set) => ({ q: "", machine: null, project: null, period: "all", order: "last", set: (p) => set(p) }));
const PERIODS: Array<[string, string, number]> = [["all", "За всё время", 0], ["7", "7 дней", 7], ["30", "30 дней", 30], ["90", "90 дней", 90]];
/** Начало периода для запроса каталога: день выровнен по началу суток, чтобы запрос не менялся каждую секунду. */
export const sinceOf = (period: string, now = Date.now()): number | undefined => {
  const days = PERIODS.find(([id]) => id === period)?.[2] ?? 0;
  return days ? Math.floor(now / 86_400_000) * 86_400_000 - days * 86_400_000 : undefined;
};

/** Найденное слово — подсветкой в строке. */
export function Hit({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

/** Строки ленты, сложенные из одной записи разговора, — отдельным куском: ключ строки начинается с номера её записи. */
export function runsOfRecord<R extends { key: string }>(rows: R[], uuid?: string): Array<{ hit: boolean; rows: R[] }> {
  const out: Array<{ hit: boolean; rows: R[] }> = [];
  for (const r of rows) {
    const hit = !!uuid && r.key.startsWith(uuid + ":");
    const last = out.at(-1);
    if (last && last.hit === hit) last.rows.push(r);
    else out.push({ hit, rows: [r] });
  }
  return out;
}

/** Сводка архива от службы: всего и по машинам; машины с пустым архивом не показываются. */
export function statsLines(st: OutputOf<typeof pointsStats>, nameOf: (m: string) => string = (m) => m): { total: string; machines: Array<{ machine: string; line: string }> } {
  const line = (x: { sessions: number; points: number; bytes: number }) => `${nSessions(x.sessions)} · ${nPoints(x.points)}${x.bytes ? ` · ${bytesWord(x.bytes)}` : ""}`;
  return { total: line(st), machines: st.machines.filter((m) => m.sessions > 0).sort((a, b) => b.bytes - a.bytes).map((m) => ({ machine: m.machine, line: `${nameOf(m.machine)}: ${line(m)}` })) };
}

/** Найденное в открытом разговоре: слово подсвечено; лента прокручена к найденной записи, а если её нет в ленте — к первому попаданию слова. */
function useHits(box: RefObject<HTMLElement | null>, q: string, ready: unknown) {
  useEffect(() => {
    const reg = (CSS as any).highlights as Map<string, unknown> | undefined;
    const Hl = (globalThis as any).Highlight;
    reg?.delete("hit");
    if (!q || !ready) return;
    // разметка ответов догружается отдельным куском: ищем, когда лента дорисована
    const timer = setTimeout(() => {
      const el = box.current;
      if (!el) return;
      const needle = q.toLowerCase(), ranges: Range[] = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = (n.textContent ?? "").toLowerCase();
        for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + needle.length);
          ranges.push(r);
        }
      }
      if (ranges.length && reg && Hl) reg.set("hit", new Hl(...ranges));
      const record = el.querySelector("[data-hit]");
      (record ?? ranges[0]?.startContainer.parentElement)?.scrollIntoView({ block: "center" });
    }, 250);
    return () => (clearTimeout(timer), void reg?.delete("hit"));
  }, [q, ready]);
}

/** Лента с точками: после какого хода стоит каждая точка. Точка с turns = N стоит после N-го итога хода в ленте.
 *  Ответ — куски ленты и точка в конце куска; куски после выбранной точки приглушаются. */
export function cutByPoints<R extends { k: string }>(rows: R[], points: Array<{ point: string; turns?: number }>, firstTurn = 0): Array<{ rows: R[]; point?: string }> {
  const at = new Map<number, string>();
  for (const p of points) if (p.turns !== undefined) at.set(p.turns, p.point);
  const out: Array<{ rows: R[]; point?: string }> = [];
  let cur: R[] = [], turn = firstTurn;
  for (const r of rows) {
    cur.push(r);
    if (r.k !== "res") continue;
    turn++;
    const point = at.get(turn);
    if (point) {
      out.push({ rows: cur, point });
      cur = [];
    }
  }
  if (cur.length) out.push({ rows: cur });
  return out;
}

/** Команда выгрузки сессии на свой компьютер без Host. */
export const pullCommand = (fleet: string, device: string, sid: string, dir: string, point?: string) => `node tools/fleet/pull.ts ${fleet} ${device} ${sid} ${dir}${point ? ` ${point}` : ""}`;

function Calls({ sid, point }: { sid: string; point?: string }) {
  const go = useNavigate();
  const c = useCall(pointsCalls, { sid, ...(point ? { point } : {}) });
  if (c.isLoading) return <Loader size="sm" />;
  if (c.error) return <Failed error={c.error} retry={c.refetch} />;
  const calls = c.data?.calls ?? [];
  const cost = calls.reduce((a, x) => a + (x.cost ?? 0), 0);
  return (
    <>
      <Text size="sm" mb="xs">{nCalls(calls.length)}{cost ? ` · $${cost.toFixed(2).replace(".", ",")}` : ""}</Text>
      <div className="table-wrap" style={{ maxHeight: "60vh", overflowY: "auto" }}>
        <Table verticalSpacing={4} horizontalSpacing="sm" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Когда</Table.Th><Table.Th>Модель</Table.Th><Table.Th ta="right">Ввод</Table.Th><Table.Th ta="right">Вывод</Table.Th><Table.Th ta="right">Кэш</Table.Th><Table.Th ta="right">$</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {calls.map((x) => (
              <Table.Tr key={x.call}>
                <Table.Td className="muted" style={{ whiteSpace: "nowrap" }}>{day(x.at)}, {hhmm(x.at)}</Table.Td>
                <Table.Td data-l="Модель" className="mono">{modelWord(x.model)}</Table.Td>
                <Table.Td data-l="Ввод" ta="right">{kilo(x.input)}</Table.Td>
                <Table.Td data-l="Вывод" ta="right">{kilo(x.output)}</Table.Td>
                <Table.Td data-l="Кэш" ta="right">{kilo(x.cacheRead + x.cacheWrite)}</Table.Td>
                <Table.Td data-l="$" ta="right">{x.cost !== undefined ? x.cost.toFixed(3).replace(".", ",") : "—"}</Table.Td>
                <Table.Td ta="right"><Button size="compact-xs" variant="subtle" onClick={() => go(`/settings/proxy?call=${encodeURIComponent(sid)}/${encodeURIComponent(x.call)}${point ? `&point=${encodeURIComponent(point)}` : ""}`)}>Правила</Button></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </>
  );
}

function Detail({ s, q, onBack }: { s: ArchSession; q: string; onBack: () => void }) {
  const go = useNavigate();
  const qc = useQueryClient();
  const wide = useWide();
  const you = useFleet((f) => f.you);
  const live = useFleet((f) => f.sessions[s.callsign]);
  const nameOf = useMachineName();
  const points = useCall(pointsList, { sid: s.sid });
  // выбранная точка живёт в адресе: ссылкой можно поделиться; точка с найденным словом выбрана сразу, пока человек не выбрал сам
  const [sp, setSp] = useSearchParams();
  const [chose, setChose] = useState(false);
  const point = sp.get("point") ?? (chose ? undefined : s.hitPoint);
  const setPoint = (p?: string) => {
    setChose(true);
    setSp((x) => { const n = new URLSearchParams(x); if (p) n.set("point", p); else n.delete("point"); return n; }, { replace: true });
  };
  const [tab, setTab] = useState("talk");
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: RaiseKind; point?: string } | { kind: "calls"; point?: string } | { kind: "pull"; point?: string } | { kind: "delete" } | null>(null);
  // разговор читается страницами с конца: «Раньше» догружает предыдущую
  const [events, setEvents] = useState<Msg[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const first = useCall(pointsHistory, { sid: s.sid, limit: 80 });
  useEffect(() => {
    if (!first.data) return;
    setEvents(first.data.events as Msg[]);
    setMore(first.data.more);
    setLoading(false);
  }, [first.data]);
  const earlier = async () => {
    const before = events.find((e) => e.uuid)?.uuid as string | undefined;
    if (!before) return;
    setLoading(true);
    const r = await act(pointsHistory, { sid: s.sid, before, limit: 80 });
    setLoading(false);
    if (r) { setEvents([...(r.events as Msg[]), ...events]); setMore(r.more); }
  };
  // найденная запись может лежать раньше загруженной страницы: дочитываем назад, пока она не появится (не больше восьми страниц)
  const pages = useRef(0);
  const hitHere = !s.hitUuid || events.some((e) => e.uuid === s.hitUuid);
  useEffect(() => {
    if (hitHere || !more || loading || pages.current >= 8) return;
    pages.current++;
    void earlier();
  }, [hitHere, more, loading, events.length]);
  const view = useMemo(() => fold(events), [events]);
  const feed = useRef<HTMLDivElement>(null);
  useHits(feed, q, hitHere ? events.length : 0);
  const list = points.data?.points ?? [];
  const last = list.at(-1)?.point;
  const selected = point ?? last;
  // ходы, которые ещё не догружены, лежат до начала ленты: счёт ходов в ленте начинается не с нуля
  const turnsShown = view.rows.filter((r) => r.k === "res").length;
  const firstTurn = more ? Math.max(0, (list.at(-1)?.turns ?? turnsShown) - turnsShown) : 0;
  const parts = useMemo(() => cutByPoints(view.rows, list, firstTurn), [view.rows, list, firstTurn]);
  const selAt = parts.findIndex((p) => p.point === selected);
  const pointOf = (id?: string) => list.find((p) => p.point === id);
  const canDelete = !live && (you?.admin || !s.owner || s.owner === you?.person);
  const days = byDay([...list].reverse(), (p) => p.at);
  const tree = branches(list as Array<ArchPoint & { base?: string }>);
  const pointRow = (p: ArchPoint) => {
    const isOpen = open === p.point;
    const br = tree[p.point];
    return (
      <div key={p.point} style={br?.depth ? { marginLeft: Math.min(br.depth, 3) * 14 } : undefined}>
        {br?.from && <div className="muted" style={{ fontSize: 11.5, padding: "2px 8px 0 32px" }}>ветка от {pointOf(br.from)?.label ?? `точки ${hhmm(pointOf(br.from)?.at ?? 0)}`}</div>}
        <div className={`pt${selected === p.point ? " sel" : ""}`} role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => (setPoint(p.point === last ? undefined : p.point), setOpen(isOpen ? null : p.point))} onKeyDown={(e) => e.key === "Enter" && (setPoint(p.point === last ? undefined : p.point), setOpen(isOpen ? null : p.point))}>
          <i />
          <span style={{ minWidth: 0 }}><span className="trunc" style={{ display: "block" }}>{p.label ?? nTurns(p.turns ?? 0)}</span><span className="muted" style={{ fontSize: 12 }}>{hhmm(p.at)}{p.label && p.turns ? ` · ${nTurns(p.turns)}` : ""}</span></span>
        </div>
        {isOpen && (
          <div style={{ padding: "2px 8px 10px 32px", fontSize: 12.5 }}>
            <div className="muted">{p.bytes ? bytesWord(p.bytes) : ""}{p.git ? ` · git ${String(p.git).slice(0, 7)}` : ""}{p.until ? ` · хранится до ${day(p.until)}` : p.point === last ? " · последняя, хранится без срока" : ""}</div>
            <Group gap={4} mt={6}>
              {live && <Button size="compact-xs" variant="default" onClick={() => setDialog({ kind: "rollback", point: p.point })}>Откатить сюда…</Button>}
              {!live && <Button size="compact-xs" variant="default" onClick={() => setDialog({ kind: "raise", point: p.point })}>Поднять отсюда…</Button>}
              <Button size="compact-xs" variant="default" onClick={() => setDialog({ kind: "copy", point: p.point })}>Копия…</Button>
              <Button size="compact-xs" variant="subtle" onClick={() => setDialog({ kind: "calls", point: p.point })}>Вызовы модели</Button>
            </Group>
          </div>
        )}
      </div>
    );
  };
  const timeline = (
    <div className="timeline scroll" style={{ padding: "0 8px 12px" }}>
      {days.map(([word, ps]) => <div key={word}><div className="daygrp">{word}</div>{ps.map(pointRow)}</div>)}
      {points.data && !list.length && <Text size="sm" className="muted" p="sm">Точек нет</Text>}
    </div>
  );
  const fleet = isMock ? "home" : parsePass(keyStore.get())?.fleet ?? "флот";
  return (
    <>
      <div className="pane-head">
        <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div className="trunc" style={{ fontWeight: 600 }}>{s.title}</div>
          <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {modelWord(s.model)} · {kilo(s.tokens ?? 0)} токенов</div>
        </div>
        {live ? (
          // живая сессия: её место — «Работа»; здесь путь к ней, перенос и работа с точками
          <><Badge color="blue">идёт</Badge><Button size="xs" onClick={() => go(`/work/${s.callsign}`)}>Открыть разговор</Button></>
        ) : <Button size="xs" onClick={() => setDialog({ kind: "raise", point })}>Поднять…</Button>}
        <Menu withinPortal position="bottom-end">
          <Menu.Target><ActionIcon variant="default" size="lg" aria-label="Действия с сессией архива"><IconDots size={16} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            {live && <Menu.Item onClick={() => setDialog({ kind: "move" })}>Перенести на машину…</Menu.Item>}
            <Menu.Item onClick={() => setDialog({ kind: "copy", point })}>Копия…</Menu.Item>
            <Menu.Item onClick={() => setDialog({ kind: "calls", point })}>Вызовы модели</Menu.Item>
            <Menu.Item onClick={() => setDialog({ kind: "pull", point })}>На свой компьютер</Menu.Item>
            {canDelete && <Menu.Item color="red" onClick={() => setDialog({ kind: "delete" })}>Удалить из архива…</Menu.Item>}
          </Menu.Dropdown>
        </Menu>
        {!wide && <SegmentedControl size="xs" w="100%" value={tab} onChange={setTab} data={[{ value: "talk", label: "Разговор" }, { value: "points", label: "Точки" }]} aria-label="Что показать" />}
      </div>
      {!wide && tab === "points" ? timeline : (
        <div className="talk with-insp" style={{ flex: 1 }}>
          <div className="feed" ref={feed}>
            <div className="feed-in">
              {more && <Button size="compact-xs" variant="default" loading={loading} style={{ alignSelf: "center" }} onClick={() => void earlier()}>Раньше</Button>}
              {loading && !events.length ? <Loader size="sm" style={{ alignSelf: "center" }} /> : first.error ? <Failed error={first.error} retry={first.refetch} /> : parts.map((part, i) => (
                // всё, что после выбранной точки, приглушено: так выглядит разговор «на точке»
                <div key={i} className={selAt >= 0 && i > selAt ? "after-point" : undefined} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {runsOfRecord(part.rows, s.hitUuid).map((run, j) => (run.hit
                    ? <div key={j} data-hit className="hit-record"><Rows rows={run.rows as never} view={view} /></div>
                    : <Rows key={j} rows={run.rows as never} view={view} />))}
                  {part.point && <div className="pointmark"><button type="button" aria-pressed={selected === part.point} onClick={() => setPoint(part.point === last ? undefined : part.point)}>{pointOf(part.point)?.label ?? "точка"} · {hhmm(pointOf(part.point)?.at ?? 0)}</button></div>}
                </div>
              ))}
            </div>
          </div>
          <aside className="insp" aria-label="Точки"><div className="grp">Точки</div>{timeline}</aside>
        </div>
      )}
      <Page opened={!!dialog} onClose={() => setDialog(null)} name={dialog?.kind} wide={dialog?.kind === "calls"}
        title={!dialog ? "" : dialog.kind === "calls" ? "Вызовы модели" : dialog.kind === "pull" ? "На свой компьютер" : dialog.kind === "delete" ? "Удалить сессию из архива" : RAISE_TITLE[dialog.kind]}>
        {dialog?.kind === "calls" && <Calls sid={s.sid} point={dialog.point} />}
        {dialog?.kind === "pull" && (() => {
          const cmd = pullCommand(fleet, (you?.addr ?? "cli").split("~")[0]!, s.sid, s.cwd ?? "./" + s.callsign.split("@")[0], dialog.point);
          return (
            <>
              <Text size="sm" mb="xs">В папке репозитория Switchboard, на компьютере с пропуском этого устройства. Папка получит репозиторий точки, разговор встанет в папку Claude — дальше <span className="mono">claude --resume</span>.</Text>
              <pre className="codebox">{cmd}</pre>
              <CopyButton value={cmd}>{({ copied, copy }) => <Button size="xs" variant="default" mt="xs" onClick={copy}>{copied ? "Скопировано" : "Скопировать команду"}</Button>}</CopyButton>
            </>
          );
        })()}
        {dialog?.kind === "delete" && (
          <DeleteTyped name={s.callsign.split("@")[0]!} body={`«${s.title ?? s.callsign}» на ${nameOf(s.machine)}: ${nPoints(s.points)} будут удалены. Вернуть нельзя.`}
            onDelete={async () => { if (await act(pointsDelete, { sid: s.sid, ...(last ? { expect: last } : {}) }, "Удалено из архива")) { await qc.invalidateQueries({ queryKey: ["points.list"] }); setDialog(null); onBack(); } }} />
        )}
        {dialog && (dialog.kind === "raise" || dialog.kind === "copy" || dialog.kind === "move" || dialog.kind === "rollback") && (
          <Raise kind={dialog.kind} s={s} point={dialog.point} onClose={() => setDialog(null)} onDone={(c) => { void qc.invalidateQueries({ queryKey: ["points.list"] }); setDialog(null); go(`/work/${c}`); }} />
        )}
      </Page>
    </>
  );
}

export function Archive() {
  const { sid } = useParams();
  const go = useNavigate();
  const machines = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const projects = useCall(peopleList, {});
  const ui = useArchiveUi();
  const [term] = useDebouncedValue(ui.q.trim(), 250);
  const since = sinceOf(ui.period);
  const list = useCall(pointsList, { ...(term ? { q: term } : {}), ...(ui.machine ? { machine: ui.machine } : {}), ...(since ? { since } : {}), ...(ui.order !== "last" ? { order: ui.order } : {}) });
  const names = Object.fromEntries((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const rows = (list.data?.sessions ?? []).filter((s) => !ui.project || s.project === ui.project);
  const [bare, setBare] = useState(false);
  const [byMachine, setByMachine] = useState(false);
  const nameOf = useMachineName();
  // сводка — от службы: всё, что в архиве, а не только загруженная страница каталога
  const stats = useCall(pointsStats, ui.machine ? { machine: ui.machine } : {});
  const st = stats.data ? statsLines(stats.data, nameOf) : null;
  const sum = archiveSummary(rows, Object.values(sessions));
  // «пожар»: машины без связи, чьи сессии ждут на точках архива
  const burning = Object.values(machines).map((m) => ({ m, n: fireCount(m, Object.values(sessions)) })).filter((x) => x.n > 0);
  const picked = rows.find((s) => s.sid === sid) ?? list.data?.sessions.find((s) => s.sid === sid);
  const wide = useWide();
  const split = useSplit({ key: "archive.listw", initial: 340, min: 240, rest: 420, cssVar: "--list", label: "Ширина списка архива" }, !!sid && wide);
  return (
    <div ref={split.box} className={`panes${sid ? " has-detail" : " solo"}${split.pulling ? " pulling" : ""}`} style={split.style}>
      <section className="pane list" aria-label="Архив">
        <div className="pane-head">
          <h1>Архив</h1>
          <TextInput w="100%" size="sm" leftSection={<IconSearch size={15} />} placeholder="Слова из разговора" aria-label="Поиск по архиву" value={ui.q} onChange={(e) => ui.set({ q: e.currentTarget.value })} autoFocus={!sid} />
          <Group gap={6} w="100%" wrap="wrap">
            <Select size="xs" clearable placeholder="Машина" aria-label="Машина" data={Object.keys(machines)} value={ui.machine} onChange={(machine) => ui.set({ machine })} style={{ flex: "1 1 120px" }} />
            <Select size="xs" clearable placeholder="Проект" aria-label="Проект" data={(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={ui.project} onChange={(project) => ui.set({ project })} style={{ flex: "1 1 120px" }} />
            <Select size="xs" aria-label="Период" allowDeselect={false} data={PERIODS.map(([value, label]) => ({ value, label }))} value={ui.period} onChange={(v) => v && ui.set({ period: v })} style={{ flex: "1 1 120px" }} />
            <Select size="xs" aria-label="Порядок" allowDeselect={false} data={[{ value: "last", label: "Сначала последние" }, { value: "tokens", label: "Сначала большие" }]} value={ui.order} onChange={(v) => v && ui.set({ order: v as Ui["order"] })} style={{ flex: "1 1 140px" }} />
          </Group>
        </div>
        <div className="scroll">
          {burning.map(({ m, n }) => (
            <div key={m.name} className="ban bad" style={{ margin: "8px 12px 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Text size="sm" style={{ flex: "1 1 180px", minWidth: 0 }}><span className="mono">{m.name}</span> без связи с {day(m.since)}, {hhmm(m.since)} · {nSessions(n)} ждут на последних точках</Text>
              <Button size="compact-xs" color="red" variant="light" onClick={() => go(`/machine/${m.name}`)}>Поднять на другой машине</Button>
            </div>
          ))}
          {list.data && !term && rows.length > 0 && (
            <div className="sub" style={{ padding: "8px 14px 2px" }}>
              {st ? <>В архиве {st.total}</> : <>{nSessions(sum.total)} в архиве{sum.bytes ? ` · ${bytesWord(sum.bytes)}` : ""}</>} · идёт {sum.going} · только в архиве {sum.only}
              {st && st.machines.length > 1 && <> · <button type="button" className="linklike" style={{ fontWeight: 400 }} aria-expanded={byMachine} onClick={() => setByMachine(!byMachine)}>по машинам</button></>}
              {sum.bare.length > 0 && <> · <button type="button" className="linklike" style={{ fontWeight: 400 }} aria-expanded={bare} onClick={() => setBare(!bare)}>без архива: {sum.bare.length}</button></>}
              {byMachine && st && <div style={{ paddingTop: 6 }}>{st.machines.map((m) => <div key={m.machine}>{m.line}</div>)}</div>}
              {bare && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 6 }}>{sum.bare.map((c) => <Badge key={c} variant="default" className="mono" component="button" type="button" style={{ cursor: "pointer" }} onClick={() => go(`/work/${c}`)}>{c}</Badge>)}</div>}
            </div>
          )}
          {list.error ? <Failed error={list.error} retry={list.refetch} /> : !rows.length && !list.isLoading ? <div className="hole" style={{ height: "50%" }}>{term ? `Ничего не нашлось по «${term}»` : "В архиве пусто"}</div> : null}
          {rows.map((s) => {
            const live = s.live ?? !!sessions[s.callsign];
            return (
              <div key={s.sid} className={`row${s.sid === sid ? " sel" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }} role="button" tabIndex={0} onClick={() => go(`/archive/${s.sid}`)} onKeyDown={(e) => e.key === "Enter" && go(`/archive/${s.sid}`)}>
                <div style={{ minWidth: 0 }}>
                  <div className="t trunc"><Hit text={s.title ?? s.callsign} q={term} /></div>
                  <div className="sub trunc"><span className="mono">{s.callsign}</span>{s.project && names[s.project] ? ` · ${names[s.project]}` : ""} · {modelWord(s.model)} · {kilo(s.tokens ?? 0)} токенов · {nPoints(s.points)}</div>
                  {s.hit && s.hit !== s.title && <div className="sub clamp2" style={{ marginTop: 3, color: "var(--mantine-color-text)" }}><Hit text={s.hit} q={term} /></div>}
                </div>
                <span className="when">{live ? <Badge size="xs" color="blue" variant="light">идёт</Badge> : ago(s.last)}</span>
              </div>
            );
          })}
        </div>
      </section>
      {split.edge}
      {sid && (
        <section className="pane detail">
          {picked ? <Detail key={picked.sid + term} s={picked} q={term} onBack={() => go("/archive")} /> : list.isLoading ? <div className="hole"><Loader size="sm" /></div> : <div className="hole">Такой сессии в архиве нет</div>}
        </section>
      )}
    </div>
  );
}
