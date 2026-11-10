// «Архив»: каталог сессий с поиском по словам; сессия архива — разговор и линия точек; поднять, копия, удалить.
import { peopleList, pointsDelete, pointsHistory, pointsList, pointsRaise, type ArchSession } from "@sb/protocol";
import { ActionIcon, Badge, Button, Group, Loader, Menu, SegmentedControl, Select, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowLeft, IconSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate, useParams } from "react-router";
import { create } from "zustand";
import { act } from "../api.ts";
import { fold, type Msg } from "../chat/fold.ts";
import { confirmDanger, Failed, modelWord, useCall, useWide } from "../common.tsx";
import { ago, day, hhmm, kilo, nPoints, nTurns } from "../lib/time.ts";
import { Rows } from "../session/Feed.tsx";
import { useFleet } from "../store/fleet.ts";

/** Запрос и фильтры архива живут, пока открыта страница: уход в другой раздел их не стирает. */
const useArchiveUi = create<{ q: string; machine: string | null; project: string | null; set(p: Partial<{ q: string; machine: string | null; project: string | null }>): void }>((set) => ({ q: "", machine: null, project: null, set: (p) => set(p) }));

/** Найденное слово — подсветкой в строке. */
export function Hit({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

/** Найденное слово в открытом разговоре: подсветка и прокрутка к первому попаданию. */
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
      if (!ranges.length) return;
      if (reg && Hl) reg.set("hit", new Hl(...ranges));
      ranges[0]!.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }, 250);
    return () => (clearTimeout(timer), void reg?.delete("hit"));
  }, [q, ready]);
}

function Detail({ s, q, onBack }: { s: ArchSession; q: string; onBack: () => void }) {
  const go = useNavigate();
  const qc = useQueryClient();
  const wide = useWide();
  const machines = useFleet((f) => f.machines);
  const live = useFleet((f) => f.sessions[s.callsign]);
  const points = useCall(pointsList, { sid: s.sid });
  // точка с найденным словом — сразу выбрана
  const [point, setPoint] = useState<string | undefined>((s as { hitPoint?: string }).hitPoint);
  const [tab, setTab] = useState("talk");
  const hist = useCall(pointsHistory, { sid: s.sid, ...(point ? { point } : {}) });
  const view = useMemo(() => fold((hist.data?.events ?? []) as Msg[]), [hist.data]);
  const feed = useRef<HTMLDivElement>(null);
  useHits(feed, q, hist.data);
  const raise = async (machine: string, copy: boolean) => {
    const r = await act(pointsRaise, { to: "@" + machine, sid: s.sid, ...(point ? { point } : {}), ...(copy ? { name: s.callsign.split("@")[0] + "-copy" } : { move: machine !== s.machine }) }, copy ? "Копия поднята" : "Сессия поднята");
    if (r) go(`/work/${r.callsign}`);
  };
  const online = Object.values(machines).filter((m) => m.online);
  const list = [...(points.data?.points ?? [])].reverse();
  const last = points.data?.points?.at(-1)?.point;
  const pointsList_ = (
    <div className="timeline scroll" style={{ padding: "0 8px 12px" }}>
      {list.map((p, i) => (
        <div key={p.point} className={`pt${(point ?? last) === p.point ? " sel" : ""}`} role="button" tabIndex={0} onClick={() => (setPoint(i === 0 ? undefined : p.point), setTab("talk"))} onKeyDown={(e) => e.key === "Enter" && setPoint(i === 0 ? undefined : p.point)}>
          <i />
          <span style={{ minWidth: 0 }}><span className="trunc" style={{ display: "block" }}>{p.label ?? nTurns(p.turns ?? 0)}</span><span className="muted" style={{ fontSize: 12 }}>{day(p.at)}, {hhmm(p.at)}{p.label && p.turns ? ` · ${nTurns(p.turns)}` : ""}</span></span>
        </div>
      ))}
    </div>
  );
  return (
    <>
      <div className="pane-head">
        <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div className="trunc" style={{ fontWeight: 600 }}>{s.title}</div>
          <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {modelWord(s.model)} · {kilo(s.tokens ?? 0)} токенов</div>
        </div>
        {live ? (
          // живая сессия: её место — «Работа»; здесь только путь к ней и копия из точки
          <><Badge color="blue">идёт</Badge><Button size="xs" onClick={() => go(`/work/${s.callsign}`)}>Открыть разговор</Button></>
        ) : (
          <Menu withinPortal position="bottom-end">
            <Menu.Target><Button size="xs">Поднять</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>На машине</Menu.Label>
              {online.map((m) => <Menu.Item key={m.name} onClick={() => raise(m.name, false)}><span className="mono">{m.name}</span>{m.name === s.machine ? " · здесь" : ""}</Menu.Item>)}
            </Menu.Dropdown>
          </Menu>
        )}
        <Menu withinPortal position="bottom-end">
          <Menu.Target><Button size="xs" variant="default">Копия</Button></Menu.Target>
          <Menu.Dropdown><Menu.Label>На машине</Menu.Label>{online.map((m) => <Menu.Item key={m.name} onClick={() => raise(m.name, true)}><span className="mono">{m.name}</span></Menu.Item>)}</Menu.Dropdown>
        </Menu>
        {!live && (
          <Button size="xs" variant="subtle" color="red" onClick={() => confirmDanger({
            title: "Удалить сессию из архива?", confirm: "Удалить",
            body: <><span><b>{s.title}</b> · <span className="mono">{s.callsign}</span></span><span>{nPoints(s.points)} будут удалены. Вернуть нельзя.</span></>,
            onConfirm: async () => { if (await act(pointsDelete, { sid: s.sid }, "Удалено из архива")) { await qc.invalidateQueries({ queryKey: ["points.list"] }); onBack(); } },
          })}>Удалить</Button>
        )}
        {!wide && <SegmentedControl size="xs" w="100%" value={tab} onChange={setTab} data={[{ value: "talk", label: "Разговор" }, { value: "points", label: "Точки" }]} aria-label="Что показать" />}
      </div>
      {!wide && tab === "points" ? pointsList_ : (
        <div className="talk with-insp" style={{ flex: 1 }}>
          <div className="feed" ref={feed}><div className="feed-in">{hist.isLoading ? <Loader size="sm" style={{ alignSelf: "center" }} /> : hist.error ? <Failed error={hist.error} retry={hist.refetch} /> : <Rows rows={view.rows} view={view} />}</div></div>
          <aside className="insp" aria-label="Точки"><div className="grp">Точки</div>{pointsList_}</aside>
        </div>
      )}
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
  const list = useCall(pointsList, { ...(term ? { q: term } : {}), ...(ui.machine ? { machine: ui.machine } : {}) });
  const rows = (list.data?.sessions ?? []).filter((s) => !ui.project || s.project === ui.project);
  const picked = rows.find((s) => s.sid === sid) ?? list.data?.sessions.find((s) => s.sid === sid);
  return (
    <div className={`panes${sid ? " has-detail" : " solo"}`}>
      <section className="pane list" aria-label="Архив">
        <div className="pane-head">
          <h1>Архив</h1>
          <TextInput w="100%" size="sm" leftSection={<IconSearch size={15} />} placeholder="Слова из разговора" aria-label="Поиск по архиву" value={ui.q} onChange={(e) => ui.set({ q: e.currentTarget.value })} autoFocus={!sid} />
          <Group gap={6} w="100%" wrap="nowrap">
            <Select size="xs" clearable placeholder="Машина" aria-label="Машина" data={Object.keys(machines)} value={ui.machine} onChange={(machine) => ui.set({ machine })} style={{ flex: 1 }} />
            <Select size="xs" clearable placeholder="Проект" aria-label="Проект" data={(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={ui.project} onChange={(project) => ui.set({ project })} style={{ flex: 1 }} />
          </Group>
        </div>
        <div className="scroll">
          {list.error ? <Failed error={list.error} retry={list.refetch} /> : !rows.length && !list.isLoading ? <div className="hole" style={{ height: "50%" }}>{term ? `Ничего не нашлось по «${term}»` : "В архиве пусто"}</div> : null}
          {rows.map((s) => (
            <div key={s.sid} className={`row${s.sid === sid ? " sel" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }} role="button" tabIndex={0} onClick={() => go(`/archive/${s.sid}`)} onKeyDown={(e) => e.key === "Enter" && go(`/archive/${s.sid}`)}>
              <div style={{ minWidth: 0 }}>
                <div className="t trunc"><Hit text={s.title ?? s.callsign} q={term} /></div>
                <div className="sub trunc"><span className="mono">{s.callsign}</span> · {sessions[s.callsign] ? "идёт · " : ""}{nPoints(s.points)}</div>
                {s.hit && s.hit !== s.title && <div className="sub clamp2" style={{ marginTop: 3, color: "var(--mantine-color-text)" }}><Hit text={s.hit} q={term} /></div>}
              </div>
              <span className="when">{ago(s.last)}</span>
            </div>
          ))}
        </div>
      </section>
      {sid && (
        <section className="pane detail">
          {picked ? <Detail key={picked.sid + term} s={picked} q={term} onBack={() => go("/archive")} /> : list.isLoading ? <div className="hole"><Loader size="sm" /></div> : <div className="hole">Такой сессии в архиве нет</div>}
        </section>
      )}
    </div>
  );
}
