// «Фабрика»: три вкладки. «Цех» — работа в ходу: сверху тикеты, которые ждут человека; ниже дорожки исполнителей: конвейер — рельс
// со станциями-шагами, пост или сессия с работой — дорожка в одну станцию; тикет стоит на своей станции. «Бэклог» — тикеты до и после
// работы: без исполнителя и закрытые по дням. «Входы» — что заводит тикеты само, со всеми подробностями определения.
// В цехе место отдано тикетам: то, что не меняется изо дня в день (названия дорожек, станции, свободные посты), стоит мелко и тихо,
// подробности — в подсказке. Пустых разделов цех не рисует. Тикет и новый тикет — страницы со своим адресом. Правил экран не считает:
// загрузку и то, что можно сделать с тикетом, отдают службы.
import { factoryGet, factoryPause, peopleList, postSessions, ticketList, ticketNew, ticketSet, type FactoryDef, type FactoryState, type InputOf, type RuleDef, type StepDef, type Ticket } from "@sb/protocol";
import { Badge, Button, Group, Select, Switch, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { IconBolt, IconBrandGithub, IconCheck, IconClock, IconHandFinger, IconPlus, IconWebhook } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { act } from "../api.ts";
import { Failed, Lamp, personWord, useCall } from "../common.tsx";
import { atStep, doerOf, DOER_WORD, eventWord, needsHuman, postStep, ruleWord, STATE_LAMP, STATE_WORD, stateWord, stepOf, targetsOf, VERDICT_WORD, waitsEvent, waitWord } from "../lib/factory.ts";
import { useLocal } from "../lib/local.ts";
import { ago, byDay, day, hhmm, leftWord } from "../lib/time.ts";
import { RoutePage } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";

const REFETCH = 15_000;
/** Шире станция с тикетами не растёт: плашка остаётся плашкой, а не строкой во весь экран. */
const STATION = "minmax(0, 272px)";
/** Подсказка с подробностями определения — тем, что не нужно видеть каждый день: по наведению, фокусу и касанию. */
const TIP = { hover: true, focus: true, touch: true } as const;
/** Вкладки: цех — без имени в адресе. */
type Tab = "" | "backlog" | "inputs";
const TABS: Array<[Tab, string]> = [["", "Цех"], ["backlog", "Бэклог"], ["inputs", "Входы"]];
const factoryPath = (project: string, tab: Tab = "") => `/factory/${project}${tab ? `/${tab}` : ""}`;
const byWord = (by: string) => (by.startsWith("~") ? personWord(by) : by);
const ticketPath = (project: string, id: string) => `/factory/${project}/t/${id}`;
const onKey = (run: () => void) => (e: React.KeyboardEvent) => e.key === "Enter" && run();

/** Запись прошла — чтения фабрики берутся заново. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: [ticketList.name] }), qc.invalidateQueries({ queryKey: [factoryGet.name] })]);
}

/** Кто исполняет шаг и чем он проверяется — словами для подсказки станции. */
function stepWord(step: StepDef): string {
  const d = doerOf(step);
  const who = d.kind === "post" ? `пост ${d.name}` : d.kind === "event" ? `событие: ${eventWord(d.name!)}` : DOER_WORD[d.kind];
  return step.check ? `${who} · проверка: ${step.check.run}` : who;
}
/** Станция рельса — шаг конвейера: имя; кто исполняет и чем проверяется — в подсказке. От станции к следующей идёт стрелка. */
function Station({ step, last }: { step: StepDef; last: boolean }) {
  return (
    <div className="fstop-head">
      <Tooltip label={stepWord(step)} events={TIP}><span>{step.name}</span></Tooltip>
      {!last && <span className="frail" aria-hidden />}
    </div>
  );
}

/** Знак состояния тикета: лампа цветом состояния; у ждущего события — значок события: человеку там делать нечего. */
function Mark({ def, t }: { def: FactoryDef; t: Ticket }) {
  if (waitsEvent(def, t)) return <span className="fmark" role="img" aria-label={STATE_WORD.wait}><IconBolt size={12} stroke={2} /></span>;
  return <span className={`lamp ${t.dropped ? "stopped" : STATE_LAMP[t.state]}`} role="img" aria-label={stateWord(t)} />;
}
/** Сколько тикет стоит на месте; отложенный — через сколько встанет в очередь. */
const whenWord = (t: Ticket) => (t.start && t.start > Date.now() ? `через ${leftWord(t.start)}` : ago(t.moved));

/** Плашка тикета на станции: заголовок целиком и сколько стоит; между ними — только то, что есть что сказать: причина у вставшего,
 *  событие у ждущего, возврат. Всё встаёт в одну строку, пока помещается, и переносится под заголовок на узкой станции.
 *  Номер — в подсказке и на странице тикета.
 *  Состояние — знаком и видом плашки: залитая — шаг идёт, пунктир — очередь, жёлтая — ждёт человека, красная — встал. */
function Tile({ def, t, onOpen, at, who }: { def: FactoryDef; t: Ticket; onOpen: () => void; /** станция — телефону: там тикеты стоят под рельсом одним столбцом */ at?: string; /** сессия поста, которая ведёт тикет, — у поста на несколько сессий */ who?: string }) {
  const event = waitsEvent(def, t);
  return (
    <div className={`ftile ${t.state}${needsHuman(def, t) ? " human" : ""}`} role="button" tabIndex={0} title={t.id} data-ticket={t.id} onClick={(e) => (e.stopPropagation(), onOpen())} onKeyDown={onKey(onOpen)}>
      <span className="ftile-h"><Mark def={def} t={t} /><span className="clamp2">{t.title}</span></span>
      {t.state === "stop" && <span className="why">{t.why}</span>}
      {event && <span className="fnote trunc">{waitWord(def, t)}</span>}
      {who && <span className="fnote mono">{who}</span>}
      {t.returns > 0 && <span className="chip warn">возврат {t.returns}</span>}
      <span className="fwhen">{at && <span className="fat">{at} · </span>}{whenWord(t)}</span>
    </div>
  );
}

/** Строка тикета в списке: знак состояния, номер, заголовок, время. Место или причина — в той же строке (цех) либо,
 *  на вкладке «Бэклог», второй строкой под заголовком: там заголовок виден целиком. */
function TicketRow({ def, t, onOpen, where, why, sub, when }: { def: FactoryDef; t: Ticket; onOpen: () => void; where?: string; why?: string; /** вторая строка под заголовком */ sub?: string; when?: string }) {
  return (
    <div className={sub === undefined ? "frow" : "frow two"} role="button" tabIndex={0} data-ticket={t.id} onClick={onOpen} onKeyDown={onKey(onOpen)}>
      <Mark def={def} t={t} />
      <span className="mono muted fid">{t.id}</span>
      <span className="ftitle">{t.title}</span>
      {sub === undefined && <span className="fwhere">{why && <span className="why">{why}</span>}{why && where ? " · " : ""}{where}</span>}
      <span className="fwhen">{when ?? whenWord(t)}</span>
      {sub && <span className="fsubline">{sub}</span>}
    </div>
  );
}

/** Потолок: деление — место под шаг, залитое — шаг идёт; число рядом — когда делений больше, чем видно с одного взгляда. */
function Slots({ work, limit }: { work: number; limit: number }) {
  const word = `идёт ${work} из ${limit}`;
  return (
    <Tooltip label={`${word} — потолок`} events={TIP}>
      <span className="fslots" data-load role="img" aria-label={word}>
        {limit <= 8 && Array.from({ length: limit }, (_, i) => <i key={i} className={i < work ? "on" : undefined} />)}
        {limit > 4 && <span>{work} из {limit}</span>}
      </span>
    </Tooltip>
  );
}

const RULE_ICON = (r: RuleDef) => (r.github ? IconBrandGithub : r.hook ? IconWebhook : r.every || r.cron ? IconClock : IconHandFinger);
/** Имя исполнителя для человека: название конвейера или поста из определения, иначе как есть (позывной сессии). */
const toWord = (def: FactoryDef, to: string) => def.lines[to]?.title ?? def.posts[to]?.title ?? to;
/** Место тикета словами: конвейер и шаг, пост или сессия. */
const whereWord = (def: FactoryDef, t: Ticket) => (t.to ? (stepOf(def, t) ? `${toWord(def, t.to)} · ${stepOf(def, t)!.name}` : toWord(def, t.to)) : "бэклог");
const old = (a: Ticket, b: Ticket) => a.since - b.since;

type View = { f: FactoryState; tickets: Ticket[]; open: (t: Ticket) => void };

export function Factory() {
  const { project, tab: named } = useParams();
  const tab: Tab = named === "backlog" || named === "inputs" ? named : "";
  const go = useNavigate();
  const refresh = useRefresh();
  const [last, setLast] = useLocal("factory.project", "");
  const people = useCall(peopleList, {});
  // проекты, у которых применено определение, называет служба одним ответом
  const all = useCall(factoryGet, {}, { refetch: REFETCH });
  const have = all.data?.projects ?? [];
  const pick = project ?? (have.find((p) => p.project === last) ?? have[0])?.project;
  useEffect(() => {
    if (!project && pick) go(factoryPath(pick), { replace: true });
    if (project && project !== last) setLast(project);
  }, [project, pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const one = useCall(factoryGet, project ? { project } : null, { refetch: REFETCH });
  const list = useCall(ticketList, project ? { project } : null, { refetch: REFETCH });
  const f = one.data?.factory, tickets = list.data?.tickets ?? [];
  const nameOf = (id: string) => people.data?.projects.find((p) => p.id === id)?.name ?? id;

  if (all.error) return <Failed error={all.error} retry={() => void all.refetch()} />;
  if (project && (one.error || list.error)) return <Failed error={one.error ?? list.error} retry={() => void (one.refetch(), list.refetch())} />;
  if (!f || !project) return <div className="hole">{all.data && !have.length ? "Фабрик нет: ни у одного проекта нет определения." : null}</div>;

  const view: View = { f, tickets, open: (t) => go(ticketPath(project, t.id)) };
  return (
    <div className="scroll">
      <div className="page factory">
        <header className={`fhead${f.paused ? " paused" : ""}`}>
          <h1>Фабрика</h1>
          {have.length > 1
            ? <Select size="xs" w={172} aria-label="Проект" allowDeselect={false} data={have.map((p) => ({ value: p.project, label: nameOf(p.project) }))} value={project} onChange={(v) => v && go(factoryPath(v, tab))} />
            : <Text fw={600}>{nameOf(project)}</Text>}
          <nav className="subtabs ftabs" role="tablist" aria-label="Разделы фабрики">
            {TABS.map(([id, word]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => go(factoryPath(project, id))}>{word}</button>)}
          </nav>
          {f.def.limit !== undefined && <Slots work={f.load.work} limit={f.def.limit} />}
          <span className="grow" />
          <Tooltip label={`${f.repo} · применено ${hhmm(f.at)}`} events={TIP}><span className="chip mono" aria-label={`определение ${f.commit}`}>{f.commit.slice(0, 7)} · {ago(f.at)}</span></Tooltip>
          <Switch label="Пауза" checked={f.paused} onChange={async (e) => { const on = e.currentTarget.checked; if (await act(factoryPause, { project, on })) await refresh(); }} />
          <Button size="compact-sm" leftSection={<IconPlus size={14} />} onClick={() => go(`/factory/${project}/new`)}>Тикет</Button>
        </header>
        {tab === "" ? <Floor {...view} /> : tab === "backlog" ? <Backlog {...view} /> : <Inputs {...view} />}
      </div>
    </div>
  );
}

/** «Цех» — работа в ходу: кто ждёт человека и дорожки исполнителей. У кого работы нет: пустая станция — одним именем, свободные посты — рядом меток. */
function Floor({ f, tickets, open }: View) {
  const go = useNavigate();
  const sessions = useFleet((s) => s.sessions);
  const def = f.def;
  const live = tickets.filter((t) => t.state !== "done");
  const calls = live.filter((t) => needsHuman(def, t)).sort(old);
  // пост: его очередь и шаг конвейера, которым он занят; без того и другого он свободен и стоит в ряду свободных
  const posts = Object.entries(def.posts).map(([name, p]) => {
    // у поста одна очередь и одна или несколько сессий: первая зовётся именем поста
    const calls = postSessions(name, p);
    return { name, call: calls[0]!, calls, title: `${p.title ?? name} · ${calls.join(" ")}`, theirs: atStep(name, 0, tickets), step: calls.map((c) => postStep(name, c, live)).find(Boolean) };
  });
  const idle = posts.filter((x) => !x.step && !x.theirs.length).flatMap((x) => x.calls.map((call) => ({ name: call.slice(0, call.indexOf("@")), call, title: x.title })));
  // сессия, которой тикет отдан по позывному, — тот же исполнитель с дорожкой, пока тикет открыт; порядок тикетов у поста и сессии —
  // тот же, что на шаге конвейера: одно правило
  const direct = live.filter((t) => t.to && !def.lines[t.to] && !def.posts[t.to]);
  const lanes = [
    ...posts.filter((x) => x.step || x.theirs.length).map((x) => ({ ...x, label: `Пост ${def.posts[x.name]!.title ?? x.name}`, post: x.name as string | undefined })),
    ...[...new Set(direct.map((t) => t.to!))].map((call) => ({ name: call, call, calls: [call], title: call, theirs: atStep(call, 0, tickets), step: undefined as Ticket | undefined, label: `Сессия ${call}`, post: undefined as string | undefined })),
  ];
  const lines = Object.entries(def.lines);
  const talk = (call: string) => () => go(`/work/${call}`);

  return (
    <>
      {calls.length > 0 && (
        <section className="fcall" aria-label="Нужен человек">
          {calls.map((t) => <TicketRow key={t.id} def={def} t={t} where={whereWord(def, t)} why={t.state === "stop" ? `стоп: ${t.why ?? ""}` : undefined} onOpen={() => open(t)} />)}
        </section>
      )}

      {(lines.length > 0 || posts.length > 0 || lanes.length > 0) && (
        <section className="ffloor" aria-label="Цех">
          {lines.map(([name, l]) => {
            const at = l.steps.map((_, i) => atStep(name, i, tickets));
            const one = l.steps.length === 1;
            return (
              <section key={name} className="flane" aria-label={`Конвейер ${l.title ?? name}`}>
                <div className="fwho">
                  {/* потолок и машины есть только у конвейера со свежими сессиями шагов */}
                  {l.at ? <Tooltip label={l.at.join(" ")} events={TIP}><div className="t">{l.title ?? name}</div></Tooltip> : <div className="t">{l.title ?? name}</div>}
                  {l.limit !== undefined && <Slots work={f.load.lines[name]?.work ?? 0} limit={l.limit} />}
                </div>
                {/* станция с тикетами берёт ширину, пустая — только своё имя */}
                <div className={`ftrack${one ? " one" : ""}`} style={one ? undefined : { gridTemplateColumns: at.map((here) => (here.length ? STATION : "max-content")).join(" ") }}>
                  {l.steps.map((st, i) => (
                    <div key={i} className="fstop" aria-label={`Шаг ${st.name}`}>
                      {!one && <Station step={st} last={i === l.steps.length - 1} />}
                      {at[i]!.map((t) => <Tile key={t.id} def={def} t={t} at={one ? undefined : st.name} onOpen={() => open(t)} />)}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {lanes.map(({ name, call, calls, title, theirs, step, label, post }) => (
            <section key={call} className="flane" aria-label={label}>
              {calls.length > 1 ? (
                // пост на несколько сессий: имя очереди и лампа на каждую сессию — нажатие открывает её разговор
                <div className="fwho" data-post={post}>
                  <Tooltip label={title} events={TIP}><div className="t mono">{name}</div></Tooltip>
                  <div className="fcrew">
                    {calls.map((c) => <Tooltip key={c} label={c}><button type="button" aria-label={c} onClick={talk(c)}><Lamp state={sessions[c]?.state ?? "stopped"} /></button></Tooltip>)}
                  </div>
                </div>
              ) : (
                <Tooltip label={title} events={TIP}>
                  <div className="fwho post" role="button" tabIndex={0} data-post={post} onClick={talk(call)} onKeyDown={onKey(talk(call))}>
                    <div className="t"><Lamp state={sessions[call]?.state ?? "stopped"} /><span className="mono trunc">{name}</span></div>
                  </div>
                </Tooltip>
              )}
              <div className="ftrack one">
                <div className="fstop">
                  {step && <button type="button" className="fbusy" onClick={() => open(step)}><span className="lamp busy" aria-hidden />шаг конвейера <span className="mono">{step.id}</span></button>}
                  {theirs.map((t) => <Tile key={t.id} def={def} t={t} who={calls.length > 1 && t.session ? t.session.slice(0, t.session.indexOf("@")) : undefined} onOpen={() => open(t)} />)}
                </div>
              </div>
            </section>
          ))}

          {idle.length > 0 && (
            <div className="fquiet" aria-label="Свободные посты">
              {idle.map(({ name, call, title }) => (
                <Tooltip key={call} label={title}>
                  <button type="button" className="fchip" data-post={name} onClick={talk(call)}><Lamp state={sessions[call]?.state ?? "stopped"} /><span className="mono">{name}</span></button>
                </Tooltip>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** Первая строка текста тикета — если она говорит больше заголовка. */
const preview = (t: Ticket) => {
  const line = t.text.split("\n").find((x) => x.trim())?.trim();
  return line && line !== t.title ? line : undefined;
};

/** «Бэклог» — тикеты до и после работы: слева без исполнителя, старые первыми; справа закрытые по дням, свежие выше. */
function Backlog({ f, tickets, open }: View) {
  const def = f.def;
  const backlog = tickets.filter((t) => t.state !== "done" && !t.to).sort(old);
  const closed = tickets.filter((t) => t.state === "done").sort((a, b) => b.moved - a.moved);
  return (
    <div className="fstore">
      <section aria-label="Бэклог">
        {backlog.length > 0
          ? <div className="ffloor flist">{backlog.map((t) => <TicketRow key={t.id} def={def} t={t} sub={[`от ${byWord(t.by)}`, preview(t)].filter(Boolean).join(" · ")} onOpen={() => open(t)} />)}</div>
          : <div className="fnone">Тикетов без исполнителя нет</div>}
      </section>
      <section aria-label="Закрытые" className="fdays">
        {closed.length > 0
          ? byDay(closed, (t) => t.moved).map(([word, rows]) => (
            <div key={word}>
              <h2 className="fgrp">{word}</h2>
              <div className="ffloor flist">
                {rows.map((t) => <TicketRow key={t.id} def={def} t={t} sub={`${t.to ? toWord(def, t.to) : "бэклог"}${t.dropped ? " · снят" : ""}`} when={hhmm(t.moved)} onOpen={() => open(t)} />)}
              </div>
            </div>
          ))
          : <div className="fnone">Закрытых нет</div>}
      </section>
    </div>
  );
}

/** «Входы» — что заводит тикеты само: чем срабатывает, проверка, кому идёт тикет, когда сработает и тикет, который вход держит открытым. */
function Inputs({ f, tickets, open }: View) {
  const def = f.def;
  if (!def.on.length) return <div className="fnone">Входов нет: тикеты заводят люди и сессии</div>;
  return (
    <section className="ffloor flist" aria-label="Входы">
      {def.on.map((r) => {
        const I = RULE_ICON(r), next = f.paused ? undefined : f.next[r.name];
        const made = tickets.filter((t) => t.on === r.name && t.state !== "done").sort(old);
        return (
          <div key={r.name} className="frule" data-on={r.name}>
            <I size={16} stroke={1.6} className="fdoer" />
            <div className="frule-cell"><span className="ftitle">{r.title ?? r.name}</span><span className="mono muted fid">{r.name}</span></div>
            <div className="frule-cell">
              <span className={r.cron ? "mono ftitle" : "ftitle"}>{ruleWord(r)}</span>
              {r.check && <span className="mono muted fid trunc" title={r.check.run}>{r.check.run} · {r.check.at}</span>}
            </div>
            <span className="fwhere">→ {toWord(def, r.to)}</span>
            <span className="fwhen">{next !== undefined ? `через ${leftWord(next)}` : ""}</span>
            <div className="frule-made">
              {made.map((t) => <button key={t.id} type="button" className="fchip" data-ticket={t.id} onClick={() => open(t)}><Mark def={def} t={t} /><span className="mono">{t.id}</span>{whenWord(t)}</button>)}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Страница тикета: путь по станциям конвейера, состояние, текст, заметки с вердиктами и то, что с ним можно сделать, — список действий называют службы. */
export function TicketPage() {
  const { project = "", id = "" } = useParams();
  const go = useNavigate();
  const refresh = useRefresh();
  const sessions = useFleet((f) => f.sessions);
  const one = useCall(factoryGet, { project }, { refetch: REFETCH });
  const got = useCall(ticketList, { ticket: id }, { refetch: REFETCH });
  const [note, setNote] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const def = one.data?.factory?.def, t = got.data?.tickets[0];
  const home = factoryPath(project);
  if (one.error || got.error) return <RoutePage title={id} home={home}><Failed error={one.error ?? got.error} /></RoutePage>;
  if (!def || !t) return <RoutePage title={id} home={home}>{null}</RoutePage>;

  const line = t.to ? def.lines[t.to] : undefined;
  const acts = t.acts ?? [];
  const open = t.state !== "done";
  const human = needsHuman(def, t);
  const set = async (input: Omit<InputOf<typeof ticketSet>, "ticket" | "note">, done: string) => {
    if (await act(ticketSet, { ticket: t.id, ...(note.trim() ? { note: note.trim() } : {}), ...input }, done)) (setNote(""), await refresh());
  };
  return (
    <RoutePage home={home} title={<><span className="mono">{t.id}</span> · {t.title}</>}>
      <div className="fpath" aria-label="Место тикета">
        {line && <Text size="sm" fw={600} mr={6}>{line.title ?? t.to}</Text>}
        {line
          ? line.steps.map((s, i) => {
            const now = i === t.step && open, past = i < t.step || !open;
            return (
              <span key={i} className={`fpath-st${now ? " now" : past ? " past" : ""}`}>
                {past && <span className="fdoer" role="img" aria-label="пройден"><IconCheck size={14} stroke={2} /></span>}
                <Tooltip label={stepWord(s)} events={TIP}><span aria-current={now ? "step" : undefined}>{s.name}</span></Tooltip>
                {i < line.steps.length - 1 && <span className="frail" aria-hidden />}
              </span>
            );
          })
          : <span className="fpath-st now"><span>{t.to ? toWord(def, t.to) : "бэклог"}</span></span>}
      </div>
      <Group gap={8} wrap="wrap" className="fstate" style={{ fontSize: 13.5 }}>
        <Mark def={def} t={t} />
        <span data-state={t.state} className={t.state === "stop" ? "why" : undefined}>{t.state === "wait" ? waitWord(def, t) : t.state === "stop" ? `стоп: ${t.why ?? ""}` : stateWord(t)}</span>
        {t.session && open && (sessions[t.session]
          ? <Button size="compact-xs" variant="default" className="mono" onClick={() => go(`/work/${t.session}`)}>{t.session}</Button>
          : <span className="mono muted">{t.session}</span>)}
        {t.returns > 0 && <span className="chip warn">возврат {t.returns}</span>}
        {t.until && open && t.until > Date.now() && <span className="chip">срок через {leftWord(t.until)}</span>}
        {t.pr && <span className="chip mono">{t.pr}</span>}
        {t.on && <span className="chip mono">{t.on}</span>}
        {t.parent && <Button size="compact-xs" variant="default" className="mono" data-parent={t.parent} onClick={() => go(ticketPath(project, t.parent!))}>← {t.parent}</Button>}
        {t.start && t.start > Date.now() && <span className="chip">через {leftWord(t.start)}</span>}
        <span className="muted">от {byWord(t.by)} · {ago(t.since)}</span>
      </Group>
      {t.text && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.text}</div>}
      {!!t.files?.length && <Group gap={6} aria-label="Файлы тикета">{t.files.map((f) => <Badge key={f.hash} variant="default" className="mono">{f.name}</Badge>)}</Group>}

      {!!t.notes?.length && (
        <div className="fnotes" aria-label="Заметки">
          {t.notes.map((n, i) => (
            <div key={i} className={`fnote-row${n.verdict ? ` ${n.verdict}` : ""}`}>
              <span className="fnote-dot" aria-hidden />
              <div className="grow">
                <Text size="xs" className="muted"><span className="mono">{byWord(n.by)}</span> · {Date.now() - n.at < 86_400_000 ? hhmm(n.at) : day(n.at)}{n.verdict && <> · <b className="fverdict">{VERDICT_WORD[n.verdict]}</b></>}</Text>
                {n.text && <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.text}</Text>}
              </div>
            </div>
          ))}
        </div>
      )}

      {acts.length > 0 && (
        <div className={`fact${t.state === "stop" ? " stop" : human ? " human" : ""}`}>
          <Textarea aria-label="Заметка" placeholder="Заметка" autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <div className="fact-row">
            {open && <Button variant="default" disabled={!note.trim()} data-act="note" onClick={() => set({}, "Заметка записана")}>Написать</Button>}
            {acts.includes("verdict") && <Button onClick={() => set({ verdict: "done" }, "Принято")}>Принять</Button>}
            {acts.includes("verdict") && <Button variant="default" onClick={() => set({ verdict: "back" }, "Возвращено")}>Вернуть</Button>}
            {acts.includes("resume") && <Button onClick={() => set({ resume: true }, "Возвращён в очередь")}>Вернуть в очередь</Button>}
            {acts.includes("assign") && (
              <span className="fassign">
                <Select aria-label="Куда" placeholder="Куда" data={targetsOf(def)} value={to} onChange={setTo} />
                <Button variant="default" disabled={!to} onClick={() => set({ to: to! }, `Назначен: ${toWord(def, to!)}`)}>Назначить</Button>
              </span>
            )}
            {acts.includes("drop") && <Button variant="subtle" color="red" className="fdrop" style={{ color: "var(--st-failed)" }} onClick={() => set({ drop: true }, "Снят")}>Снять</Button>}
          </div>
        </div>
      )}
    </RoutePage>
  );
}

/** Значение «без исполнителя» в поле «Куда»: имени конвейера и поста с @ не бывает. */
const BACKLOG = "@";
/** Новый тикет: заголовок, текст, куда. Экран возвращается туда, где тикет виден: с исполнителем — в цех, без него — в бэклог. */
export function NewTicket() {
  const { project = "" } = useParams();
  const go = useNavigate();
  const refresh = useRefresh();
  const one = useCall(factoryGet, { project });
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [to, setTo] = useState(BACKLOG);
  const def = one.data?.factory?.def;
  const create = async () => {
    if (!(await act(ticketNew, { project, title: title.trim(), text, ...(to === BACKLOG ? {} : { to }) }, "Тикет создан"))) return;
    await refresh();
    go(factoryPath(project, to === BACKLOG ? "backlog" : ""));
  };
  return (
    <RoutePage title="Новый тикет" home={factoryPath(project)}>
      <TextInput label="Заголовок" value={title} onChange={(e) => setTitle(e.currentTarget.value)} autoFocus />
      <Textarea label="Текст" autosize minRows={4} value={text} onChange={(e) => setText(e.currentTarget.value)} />
      <Select label="Куда" allowDeselect={false} data={[{ value: BACKLOG, label: "Бэклог" }, ...(def ? targetsOf(def) : [])]} value={to} onChange={(v) => v !== null && setTo(v)} />
      <Group><Button disabled={!title.trim()} onClick={create}>Создать</Button></Group>
    </RoutePage>
  );
}
