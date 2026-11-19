// «Фабрика»: посты, конвейеры со шагами и тикетами на них, вставшие тикеты, бэклог, тикеты сессий, входы проекта. Тикет и новый тикет — страницы
// со своим адресом. Правил экран не считает: загрузку конвейера и то, что можно сделать с тикетом, отдают службы.
import { factoryGet, factoryPause, peopleList, ticketList, ticketNew, ticketSet, type FactoryDef, type InputOf, type RuleDef, type StepDef, type Ticket } from "@sb/protocol";
import { Badge, Button, Group, Select, Stack, Switch, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { IconBolt, IconBrandGithub, IconClock, IconHandFinger, IconListCheck, IconPin, IconPlus, IconRepeat, IconSparkles, IconUser, IconWebhook } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { act } from "../api.ts";
import { Failed, Lamp, personWord, useCall } from "../common.tsx";
import { atStep, doerOf, DOER_WORD, eventWord, postCall, ruleWord, STATE_LAMP, STATE_WORD, stateWord, stepOf, targetsOf, VERDICT_WORD, waitWord } from "../lib/factory.ts";
import { useLocal } from "../lib/local.ts";
import { ago, day, hhmm, leftWord } from "../lib/time.ts";
import { RoutePage } from "../shell/Page.tsx";
import { useFleet } from "../store/fleet.ts";

const REFETCH = 15_000;
const byWord = (by: string) => (by.startsWith("~") ? personWord(by) : by);
const ticketPath = (project: string, id: string) => `/factory/${project}/t/${id}`;
const onKey = (run: () => void) => (e: React.KeyboardEvent) => e.key === "Enter" && run();

/** Запись прошла — чтения фабрики берутся заново. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: [ticketList.name] }), qc.invalidateQueries({ queryKey: [factoryGet.name] })]);
}

const DOER_ICON = { new: IconSparkles, same: IconRepeat, post: IconPin, human: IconUser, event: IconBolt } as const;
/** Шапка шага: кто исполняет — значком; пост и событие — ещё и словом; проверка шага — значком с командой. */
function StepHead({ step }: { step: StepDef }) {
  const d = doerOf(step);
  const I = DOER_ICON[d.kind];
  return (
    <div className="fstep-head">
      <Tooltip label={DOER_WORD[d.kind]}><span className="fdoer" role="img" aria-label={DOER_WORD[d.kind]}><I size={14} stroke={1.8} /></span></Tooltip>
      <span className="trunc">{step.name}</span>
      {d.kind === "post" && <span className="mono muted trunc" style={{ fontWeight: 400 }}>{d.name}</span>}
      {d.kind === "event" && <span className="muted trunc" style={{ fontWeight: 400 }}>{eventWord(d.name!)}</span>}
      {step.check && <Tooltip label={step.check.run}><span className="fdoer" role="img" aria-label={`проверка: ${step.check.run}`} style={{ marginLeft: "auto" }}><IconListCheck size={14} stroke={1.8} /></span></Tooltip>}
    </div>
  );
}

/** Плашка тикета на шаге или у поста: состояние лампой, номер, заголовок; у идущего — сессия, у ждущего — чего ждёт, у вставшего — причина. */
function Tile({ def, t, onOpen, own }: { def: FactoryDef; t: Ticket; onOpen: () => void; /** плашка стоит у своей сессии — у поста: позывной не повторяется */ own?: boolean }) {
  return (
    <div className={`ftile ${t.state}`} role="button" tabIndex={0} data-ticket={t.id} onClick={(e) => (e.stopPropagation(), onOpen())} onKeyDown={onKey(onOpen)}>
      <div className="ftile-top">
        <span className={`lamp ${STATE_LAMP[t.state]}`} role="img" aria-label={STATE_WORD[t.state]} />
        <span className="mono muted">{t.id}</span>
        {t.returns > 0 && <span className="chip warn">возврат {t.returns}</span>}
      </div>
      <div className="clamp2">{t.title}</div>
      {t.state === "work" && t.session && !own && <div className="mono muted trunc" style={{ fontSize: 12 }}>{t.session}</div>}
      {t.state === "wait" && <div className="muted trunc" style={{ fontSize: 12 }}>{waitWord(def, t)}</div>}
      {t.state === "stop" && <div className="why">{t.why}</div>}
    </div>
  );
}

/** Строка тикета в списке: заголовок, номер и место, причина у вставшего. */
function TicketLine({ t, onOpen, where }: { t: Ticket; onOpen: () => void; where?: string }) {
  return (
    <div className="line fpick" role="button" tabIndex={0} data-ticket={t.id} onClick={onOpen} onKeyDown={onKey(onOpen)}>
      <div className="grow">
        <Text size="sm">{t.title}</Text>
        <Text size="xs" className="muted" style={{ overflowWrap: "anywhere" }}><span className="mono">{t.id}</span>{where ? ` · ${where}` : ""}</Text>
        {t.state === "stop" && <Text size="xs" c="red">{t.why}</Text>}
      </div>
      <Text size="xs" className="muted" style={{ whiteSpace: "nowrap" }}>{t.start && t.start > Date.now() ? `через ${leftWord(t.start)}` : ago(t.moved)}</Text>
    </div>
  );
}

const RULE_ICON = (r: RuleDef) => (r.github ? IconBrandGithub : r.hook ? IconWebhook : r.every || r.cron ? IconClock : IconHandFinger);
/** Имя исполнителя для человека: название конвейера или поста из определения, иначе как есть (позывной сессии). */
const toWord = (def: FactoryDef, to: string) => def.lines[to]?.title ?? def.posts[to]?.title ?? to;
/** Место тикета словами: конвейер и шаг, пост или сессия. */
const whereWord = (def: FactoryDef, t: Ticket) => (t.to ? (stepOf(def, t) ? `${toWord(def, t.to)} · ${stepOf(def, t)!.name}` : toWord(def, t.to)) : "бэклог");

export function Factory() {
  const { project } = useParams();
  const go = useNavigate();
  const refresh = useRefresh();
  const sessions = useFleet((f) => f.sessions);
  const [last, setLast] = useLocal("factory.project", "");
  const people = useCall(peopleList, {});
  // проекты, у которых применено определение, называет служба одним ответом
  const all = useCall(factoryGet, {}, { refetch: REFETCH });
  const have = all.data?.projects ?? [];
  const pick = project ?? (have.find((p) => p.project === last) ?? have[0])?.project;
  useEffect(() => {
    if (!project && pick) go(`/factory/${pick}`, { replace: true });
    if (project && project !== last) setLast(project);
  }, [project, pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const one = useCall(factoryGet, project ? { project } : null, { refetch: REFETCH });
  const list = useCall(ticketList, project ? { project } : null, { refetch: REFETCH });
  const f = one.data?.factory, tickets = list.data?.tickets ?? [];
  const nameOf = (id: string) => people.data?.projects.find((p) => p.id === id)?.name ?? id;

  if (all.error) return <Failed error={all.error} retry={() => void all.refetch()} />;
  if (project && (one.error || list.error)) return <Failed error={one.error ?? list.error} retry={() => void (one.refetch(), list.refetch())} />;
  if (!f || !project) return <div className="hole">{all.data && !have.length ? "Фабрик нет: ни у одного проекта нет определения." : null}</div>;

  const def = f.def;
  const open = (t: Ticket) => go(ticketPath(project, t.id));
  const live = tickets.filter((t) => t.state !== "done");
  const old = (a: Ticket, b: Ticket) => a.since - b.since;
  const backlog = live.filter((t) => !t.to).sort(old);
  const stopped = live.filter((t) => t.state === "stop").sort(old);
  const direct = live.filter((t) => t.to && !def.lines[t.to] && !def.posts[t.to]).sort(old);
  const closed = tickets.filter((t) => t.state === "done").sort((a, b) => b.moved - a.moved);

  return (
    <div className="scroll">
      <div className="page factory">
        <Group justify="space-between" gap="sm" mb="md" wrap="wrap">
          <Group gap="sm" wrap="wrap" style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>Фабрика</h1>
            {have.length > 1
              ? <Select size="xs" aria-label="Проект" allowDeselect={false} data={have.map((p) => ({ value: p.project, label: nameOf(p.project) }))} value={project} onChange={(v) => v && go(`/factory/${v}`)} />
              : <Text fw={600}>{nameOf(project)}</Text>}
            <Tooltip label={`${f.repo} · применено ${hhmm(f.at)}`}><span className="chip mono" aria-label={`определение ${f.commit}`}>{f.commit.slice(0, 7)} · {ago(f.at)}</span></Tooltip>
          </Group>
          <Group gap="md" wrap="nowrap">
            <Switch label="Пауза" checked={f.paused} onChange={async (e) => { const on = e.currentTarget.checked; if (await act(factoryPause, { project, on })) await refresh(); }} />
            <Button size="compact-sm" leftSection={<IconPlus size={14} />} onClick={() => go(`/factory/${project}/new`)}>Тикет</Button>
          </Group>
        </Group>

        <Stack gap="md">
          <section className="fposts" aria-label="Посты">
            {Object.entries(def.posts).map(([name, p]) => {
              const call = postCall(name, p.at), s = sessions[call];
              const theirs = live.filter((t) => t.to === name).sort((a, b) => (a.state === "work" ? -1 : b.state === "work" ? 1 : a.since - b.since));
              const talk = () => go(`/work/${call}`);
              return (
                <div key={name} className="card fpost" role="button" tabIndex={0} data-post={name} onClick={talk} onKeyDown={onKey(talk)}>
                  <div className="fpost-head">
                    <Lamp state={s?.state ?? "stopped"} />
                    <div style={{ minWidth: 0 }}>
                      <div className="t trunc">{p.title ?? s?.title ?? name}</div>
                      <div className="sub trunc mono muted">{call}</div>
                    </div>
                  </div>
                  {theirs.map((t) => <Tile key={t.id} def={def} t={t} own onOpen={() => open(t)} />)}
                </div>
              );
            })}
          </section>

          {Object.entries(def.lines).map(([name, l]) => (
            <section key={name} className="card fline" aria-label={`Конвейер ${l.title ?? name}`}>
              <div className="fline-head">
                <Text fw={600} className="trunc">{l.title ?? name}</Text>
                <Tooltip label="идёт шагов · потолок"><span className="chip" data-load>{f.load.lines[name]?.work ?? 0} из {l.limit}</span></Tooltip>
                <span className="mono muted trunc" style={{ fontSize: 12 }}>{l.at.join(" ")}</span>
              </div>
              <div className="fsteps">
                {l.steps.map((st, i) => (
                  <div key={i} className="fstep" aria-label={`Шаг ${st.name}`}>
                    <StepHead step={st} />
                    {atStep(name, i, tickets).map((t) => <Tile key={t.id} def={def} t={t} onOpen={() => open(t)} />)}
                  </div>
                ))}
              </div>
            </section>
          ))}

          <div className="flists">
            <section className="card" aria-label="Стоп" style={stopped.length ? { borderColor: "var(--st-failed)" } : undefined}>
              <Text fw={600}>Стоп</Text>
              {stopped.map((t) => <TicketLine key={t.id} t={t} where={whereWord(def, t)} onOpen={() => open(t)} />)}
              {!stopped.length && <Text size="sm" className="muted">Вставших нет</Text>}
            </section>
            <section className="card" aria-label="Бэклог">
              <Text fw={600}>Бэклог</Text>
              {backlog.map((t) => <TicketLine key={t.id} t={t} where={byWord(t.by)} onOpen={() => open(t)} />)}
              {!backlog.length && <Text size="sm" className="muted">Пусто</Text>}
            </section>
            <section className="card" aria-label="У сессий">
              <Text fw={600}>У сессий</Text>
              {direct.map((t) => <TicketLine key={t.id} t={t} where={`${t.to} · ${STATE_WORD[t.state]}`} onOpen={() => open(t)} />)}
              {!direct.length && <Text size="sm" className="muted">Пусто</Text>}
            </section>
            <section className="card" aria-label="Входы">
              <Text fw={600}>Входы</Text>
              {def.on.map((r) => {
                const I = RULE_ICON(r);
                return (
                  <div key={r.name} className="line" data-on={r.name}>
                    <I size={16} stroke={1.6} style={{ flex: "none", color: "var(--muted)" }} />
                    <div className="grow">
                      <Text size="sm">{r.title ?? r.name} <span className="muted">→ {toWord(def, r.to)}</span></Text>
                      <Text size="xs" className={r.cron ? "mono muted" : "muted"}>{ruleWord(r)}</Text>
                      {r.check && <Text size="xs" className="mono muted trunc" title={r.check.run}>{r.check.run}</Text>}
                    </div>
                    {f.next[r.name] !== undefined && <Text size="xs" className="muted" style={{ whiteSpace: "nowrap" }}>через {leftWord(f.next[r.name]!)}</Text>}
                  </div>
                );
              })}
              {!def.on.length && <Text size="sm" className="muted">Пусто</Text>}
            </section>
            <section className="card" aria-label="Закрытые">
              <Text fw={600}>Закрытые</Text>
              {closed.map((t) => <TicketLine key={t.id} t={t} where={stateWord(t)} onOpen={() => open(t)} />)}
              {!closed.length && <Text size="sm" className="muted">Пусто</Text>}
            </section>
          </div>
        </Stack>
      </div>
    </div>
  );
}

/** Страница тикета: где стоит, текст, заметки с вердиктами и то, что с ним можно сделать, — список действий называют службы. */
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
  const home = `/factory/${project}`;
  if (one.error || got.error) return <RoutePage title={id} home={home}><Failed error={one.error ?? got.error} /></RoutePage>;
  if (!def || !t) return <RoutePage title={id} home={home}>{null}</RoutePage>;

  const line = t.to ? def.lines[t.to] : undefined;
  const acts = t.acts ?? [];
  const open = t.state !== "done";
  const set = async (input: Omit<InputOf<typeof ticketSet>, "ticket" | "note">, done: string) => {
    if (await act(ticketSet, { ticket: t.id, ...(note.trim() ? { note: note.trim() } : {}), ...input }, done)) (setNote(""), await refresh());
  };
  return (
    <RoutePage home={home} title={<><span className="mono">{t.id}</span> · {t.title}</>}>
      <div className="fpath" aria-label="Место тикета">
        {line && <Text size="sm" fw={600} mr={4}>{line.title ?? t.to}</Text>}
        {line
          ? line.steps.map((s, i) => <span key={i} className={`chip${i === t.step && open ? " now" : ""}`} aria-current={i === t.step && open ? "step" : undefined}>{s.name}</span>)
          : <span className="chip now">{t.to ? toWord(def, t.to) : "бэклог"}</span>}
      </div>
      <Group gap={8} wrap="wrap" style={{ fontSize: 13.5 }}>
        <span className={`lamp ${STATE_LAMP[t.state]}`} style={{ marginTop: 0 }} role="img" aria-label={STATE_WORD[t.state]} />
        <span data-state={t.state}>{t.state === "wait" ? waitWord(def, t) : t.state === "stop" ? `стоп: ${t.why ?? ""}` : stateWord(t)}</span>
        {t.session && open && (sessions[t.session]
          ? <Button size="compact-xs" variant="default" className="mono" onClick={() => go(`/work/${t.session}`)}>{t.session}</Button>
          : <span className="mono muted">{t.session}</span>)}
        {t.returns > 0 && <span className="chip warn">возврат {t.returns}</span>}
        {t.pr && <span className="chip mono">{t.pr}</span>}
        {t.on && <span className="chip mono">{t.on}</span>}
        {t.start && t.start > Date.now() && <span className="chip">через {leftWord(t.start)}</span>}
        <span className="muted">от {byWord(t.by)} · {ago(t.since)}</span>
      </Group>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.text}</div>
      {!!t.files?.length && <Group gap={6} aria-label="Файлы тикета">{t.files.map((f) => <Badge key={f.hash} variant="default" className="mono">{f.name}</Badge>)}</Group>}

      {!!t.notes?.length && (
        <div className="card" aria-label="Заметки" style={{ gap: 0 }}>
          {t.notes.map((n, i) => (
            <div key={i} className="line">
              <div className="grow">
                <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.text}</Text>
                <Text size="xs" className="muted"><span className="mono">{byWord(n.by)}</span> · {Date.now() - n.at < 86_400_000 ? hhmm(n.at) : day(n.at)}</Text>
              </div>
              {n.verdict && <Badge color={n.verdict === "done" ? "teal" : n.verdict === "back" ? "orange" : "red"} variant="light">{VERDICT_WORD[n.verdict]}</Badge>}
            </div>
          ))}
        </div>
      )}

      {acts.length > 0 && (
        <Stack gap="sm">
          <Textarea label="Заметка" autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          {acts.includes("assign") && <Select label="Куда" data={targetsOf(def)} value={to} onChange={setTo} />}
          <Group gap="sm">
            {acts.includes("verdict") && <Button onClick={() => set({ verdict: "done" }, "Принято")}>Принять</Button>}
            {acts.includes("verdict") && <Button variant="default" onClick={() => set({ verdict: "back" }, "Возвращено")}>Вернуть</Button>}
            {acts.includes("resume") && <Button onClick={() => set({ resume: true }, "Возвращён в очередь")}>Вернуть в очередь</Button>}
            {acts.includes("assign") && <Button variant="default" disabled={!to} onClick={() => set({ to: to! }, `Назначен: ${toWord(def, to!)}`)}>Назначить</Button>}
            {acts.includes("drop") && <Button variant="default" color="red" onClick={() => set({ drop: true }, "Снят")}>Снять</Button>}
          </Group>
        </Stack>
      )}
    </RoutePage>
  );
}

/** Значение «без исполнителя» в поле «Куда»: имени конвейера и поста с @ не бывает. */
const BACKLOG = "@";
/** Новый тикет: заголовок, текст, куда. */
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
    go(`/factory/${project}`);
  };
  return (
    <RoutePage title="Новый тикет" home={`/factory/${project}`}>
      <TextInput label="Заголовок" value={title} onChange={(e) => setTitle(e.currentTarget.value)} autoFocus />
      <Textarea label="Текст" autosize minRows={4} value={text} onChange={(e) => setText(e.currentTarget.value)} />
      <Select label="Куда" allowDeselect={false} data={[{ value: BACKLOG, label: "Бэклог" }, ...(def ? targetsOf(def) : [])]} value={to} onChange={(v) => v !== null && setTo(v)} />
      <Group><Button disabled={!title.trim()} onClick={create}>Создать</Button></Group>
    </RoutePage>
  );
}
