// «Наблюдение»: здоровье флота, последние запросы с путём по частям, журнал флота и журнал машины.
import { ledgerRead, machineJournal, obsHealth, obsRecent, obsStats, type LedgerEvent, type ObsRow, type OutputOf } from "@sb/protocol";
import { BarChart } from "@mantine/charts";
import { Badge, Button, Group, SegmentedControl, Select, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, sayError, sayWord } from "../api.ts";
import { Failed, partWord, useCall, useMachineName, useWide } from "../common.tsx";
import { hostLine, HostSeries, SERIES_PERIODS } from "../lib/metrics.tsx";
import { byDay, day, duration, hhmm } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { TabsPage } from "./Fleet.tsx";

const ms = (n: number) => (n >= 1000 ? duration(n) : `${n} мс`);
/** Исход словами: причина по-русски, код — мелко рядом. Строка report — ошибка, пойманная на месте. */
const outcome = (r: ObsRow) => (r.type === "report" ? "ошибка" : r.ok ? "принят" : sayWord(r.word).toLowerCase());
const PART_OF: Record<string, string> = { web: "страница", host: "Host", keeper: "Keeper" };

/** Путь запроса: причина первой строкой, отрезки по частям — подписанной полосой; отказ — у последней части. */
function Path({ r }: { r: ObsRow }) {
  const go = useNavigate();
  const spans = r.spans ?? [];
  const total = Math.max(1, spans.reduce((a, s) => a + s.ms, 0));
  const machine = r.to && /@/.test(r.to) ? r.to.slice(r.to.indexOf("@") + 1) : "";
  if (r.type === "report") return <Stack gap={4} p="sm" style={{ background: "var(--surface-2)", borderRadius: 8 }}><Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>{r.why}</Text><Text size="xs" className="muted">прислал <span className="mono">{r.from}</span></Text></Stack>;
  return (
    <Stack gap={8} p="sm" style={{ background: "var(--surface-2)", borderRadius: 8 }}>
      {!r.ok && <Text size="sm" fw={600}>{r.why ? r.why[0]!.toUpperCase() + r.why.slice(1) : sayWord(r.word)} <span className="mono muted" style={{ fontWeight: 400 }}>{r.word}</span></Text>}
      <div className="span-bar" role="img" aria-label="Время по частям">{spans.map((s, i) => <i key={i} style={{ width: `${(s.ms / total) * 100}%` }} />)}</div>
      <Group gap="lg">
        {spans.map((s, i) => {
          const refused = !r.ok && i === spans.length - 1;
          return (
            <Group key={i} gap={6} wrap="nowrap" align="center">
              <span className={`sw sw-${i % 4}`} />
              <Text size="sm" fw={600} c={refused ? "red" : undefined}>{partWord(s.part)}{refused ? " — отказ" : ""}</Text>
              <Text size="sm" className="muted">{ms(s.ms)}</Text>
            </Group>
          );
        })}
      </Group>
      <Group gap="xs">
        <Text size="xs" className="muted">номер запроса <span className="mono">{r.trace}</span></Text>
        {machine && <Button size="compact-xs" variant="subtle" onClick={() => go(`/observe/machine?m=${machine}&trace=${r.trace}`)}>Строки журнала машины</Button>}
      </Group>
    </Stack>
  );
}

function Requests() {
  const [type, setType] = useState("");
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useCall(obsRecent, { ...(type.trim() ? { name: type.trim() } : {}), ...(failed ? { failed: true } : {}), limit: 80 }, { refetch: 5000 });
  if (rows.error) return <Failed error={rows.error} retry={rows.refetch} />;
  return (
    <Stack gap="sm">
      <Group gap="md">
        <TextInput size="xs" w={220} placeholder="Имя запроса" aria-label="Имя запроса" className="mono" value={type} onChange={(e) => setType(e.currentTarget.value)} />
        <Switch size="sm" label="Только отказы" checked={failed} onChange={(e) => setFailed(e.currentTarget.checked)} />
      </Group>
      <div className="table-wrap">
        <Table verticalSpacing={5} horizontalSpacing="md" highlightOnHover className="stack">
          <Table.Thead><Table.Tr><Table.Th>Когда</Table.Th><Table.Th>Запрос</Table.Th><Table.Th>От кого → кому</Table.Th><Table.Th ta="right">Время</Table.Th><Table.Th>Исход</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {(rows.data?.rows ?? []).map((r) => (
              <Fragment key={r.trace + r.at}>
                <Table.Tr style={{ cursor: "pointer" }} tabIndex={0} aria-expanded={open === r.trace} onClick={() => setOpen(open === r.trace ? null : r.trace)} onKeyDown={(e) => e.key === "Enter" && setOpen(open === r.trace ? null : r.trace)}>
                  <Table.Td className="muted" style={{ whiteSpace: "nowrap" }} data-l="Когда">{hhmm(r.at)}</Table.Td>
                  <Table.Td className="mono" fw={500}>{r.type === "report" ? "ошибка на месте" : r.type}</Table.Td>
                  <Table.Td className="mono" style={{ overflowWrap: "anywhere" }} data-l="От кого → кому">{r.from}{r.to ? ` → ${r.to}` : ""}</Table.Td>
                  <Table.Td ta="right" style={{ whiteSpace: "nowrap" }} data-l="Время">{r.type === "report" ? "" : ms(r.ms)}</Table.Td>
                  <Table.Td data-l="Исход"><Badge color={r.ok && r.type !== "report" ? "teal" : "red"}>{outcome(r)}</Badge></Table.Td>
                </Table.Tr>
                {open === r.trace && <Table.Tr className="full"><Table.Td colSpan={5}><Path r={r} /></Table.Td></Table.Tr>}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}

/** Слить события журнала: новые сверху, без повторов по номеру. */
export function mergeLedger(have: LedgerEvent[], more: LedgerEvent[]): LedgerEvent[] {
  const seen = new Set(have.map((e) => e.id));
  return [...have, ...more.filter((e) => !seen.has(e.id))].sort((a, b) => b.at - a.at);
}
/** Поиск по загруженным записям: текст, событие, кто, машина, сессия. */
export const ledgerMatches = (e: LedgerEvent, q: string) => !q.trim() || [e.text, e.what, e.who, e.machine, e.callsign].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()));

function Ledger() {
  const machines = useFleet((f) => f.machines);
  const go = useNavigate();
  const [machine, setMachine] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const live = useRef<LedgerEvent[]>([]);
  live.current = events;
  const load = async (input: { before?: number; after?: number }, fresh = false) => {
    try {
      const r = await api.call(ledgerRead, { limit: 80, ...(machine ? { machine } : {}), ...input });
      setEvents(mergeLedger(fresh ? [] : live.current, r.events));
      if (!input.after) setMore(r.more);
      setError(null);
    } catch (e) {
      if (!input.after) setError(e);
    }
    setLoading(false);
  };
  useEffect(() => {
    setLoading(true);
    void load({}, true);
    // новые события подтягиваются сами: только те, что новее самого свежего на экране
    const t = setInterval(() => live.current[0] && void load({ after: live.current[0].at }), 15_000);
    return () => clearInterval(t);
  }, [machine]);
  if (error) return <Failed error={error} retry={() => void load({}, true)} />;
  const shown = events.filter((e) => ledgerMatches(e, q));
  return (
    <Stack gap="sm">
      <Group gap="sm">
        <Select size="xs" w={200} clearable placeholder="Машина" aria-label="Машина" data={Object.keys(machines)} value={machine} onChange={setMachine} />
        <TextInput size="xs" w={240} leftSection={<IconSearch size={14} />} placeholder="Найти в журнале" aria-label="Поиск по журналу" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      </Group>
      <div className="table-wrap">
        {byDay(shown, (e) => e.at).map(([word, list]) => (
          <div key={word}>
            <div className="dayhead">{word}</div>
            <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
              <Table.Tbody>
                {list.map((e) => (
                  <Table.Tr key={e.id}>
                    <Table.Td className="muted" style={{ whiteSpace: "nowrap", width: 60 }}>{hhmm(e.at)}</Table.Td>
                    <Table.Td fw={500}>{e.text ?? e.what}</Table.Td>
                    <Table.Td data-l="Где" className="mono">{e.callsign ? <button type="button" className="linkbtn mono" onClick={() => go(`/work/${e.callsign}`)}>{e.callsign}</button> : e.machine ? <button type="button" className="linkbtn mono" onClick={() => go(`/machine/${e.machine}`)}>{e.machine}</button> : ""}</Table.Td>
                    <Table.Td className="mono muted" data-l="Событие">{e.what}</Table.Td>
                    <Table.Td className="mono muted" style={{ overflowWrap: "anywhere" }} data-l="Кто">{e.who}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ))}
        {!loading && !shown.length && <Text size="sm" className="muted" p="md">{q ? `Ничего не нашлось по «${q}»` : "Событий нет"}</Text>}
      </div>
      {more && <Button size="xs" variant="default" w="fit-content" loading={loading} onClick={() => (setLoading(true), void load({ before: events.at(-1)?.at }))}>Раньше</Button>}
    </Stack>
  );
}

type JLine = OutputOf<typeof machineJournal>["lines"][number];

/** Строка журнала машины словами: у запроса — имя, от кого, время и исход; у остального — событие, сессия и причина. */
export function journalWord(l: { msg: string; [field: string]: unknown }): string {
  const s = (k: string) => (typeof l[k] === "string" || typeof l[k] === "number" ? String(l[k]) : "");
  if (l.msg === "request" && s("type")) {
    const out = l.ok === false ? ` · отказ ${sayWord(s("word"))}${s("why") ? `: ${s("why")}` : ""}` : "";
    return `запрос ${s("type")}${s("from") ? ` от ${s("from")}` : ""}${s("ms") ? ` · ${s("ms")} мс` : ""}${out}`;
  }
  const bits = [s("callsign"), s("type") && l.msg !== "request" ? s("type") : "", s("build") ? `сборка ${s("build")}` : "", s("word"), s("why")].filter(Boolean);
  return bits.length ? `${l.msg} · ${bits.join(" · ")}` : l.msg;
}
const KINDS = [{ value: "stop", label: "остановки и сбои" }, { value: "refuse", label: "отказы запросам" }, { value: "note", label: "остальное" }];

function MachineLog() {
  const machines = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const nameOf = useMachineName();
  const [sp, setSp] = useSearchParams();
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  const machine = sp.get("m") ?? online[0] ?? null;
  const trace = sp.get("trace") ?? "";
  const session = sp.get("s");
  const [level, setLevel] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [older, setOlder] = useState<JLine[]>([]);
  const filter = { ...(level ? { level: level as "warn" | "error" } : {}), ...(kind ? { kind: kind as "stop" | "refuse" | "note" } : {}), ...(trace ? { of: trace } : {}), ...(session ? { session } : {}) };
  const j = useCall(machineJournal, machine ? { to: "@" + machine, limit: 80, ...filter } : null);
  const [more, setMore] = useState(false);
  useEffect(() => (setOlder([]), setMore(j.data?.more ?? false)), [j.data]);
  const set = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const lines = [...(j.data?.lines ?? []), ...older];
  const earlier = async () => {
    const before = lines.at(-1)?.t;
    if (!machine || !before) return;
    try {
      const r = await api.call(machineJournal, { to: "@" + machine, limit: 80, before, ...filter });
      setOlder([...older, ...r.lines]);
      setMore(r.more);
    } catch (e) {
      setMore(false);
      void sayError(e);
    }
  };
  return (
    <Stack gap="sm">
      <Group gap="sm">
        <Select size="xs" w={180} aria-label="Машина" data={online.map((m) => ({ value: m, label: nameOf(m) }))} value={machine} onChange={(v) => (set("m", v), set("s", null))} allowDeselect={false} />
        <Select size="xs" w={200} clearable placeholder="Сессия" aria-label="Сессия" className="mono" data={Object.keys(sessions).filter((c) => machineOfCall(c) === machine)} value={session} onChange={(v) => set("s", v)} />
        <Select size="xs" w={170} clearable placeholder="Вид строк" aria-label="Вид строк" data={KINDS} value={kind} onChange={setKind} />
        <Select size="xs" w={160} clearable placeholder="Уровень" aria-label="Уровень" data={[{ value: "warn", label: "предупреждения" }, { value: "error", label: "ошибки" }]} value={level} onChange={setLevel} />
        <TextInput size="xs" w={190} placeholder="Номер запроса" aria-label="Номер запроса" className="mono" value={trace} onChange={(e) => set("trace", e.currentTarget.value || null)} />
      </Group>
      {j.error ? <Failed error={j.error} retry={j.refetch} /> : (
        <div className="table-wrap" style={{ padding: "8px 12px" }}>
          {lines.map((l, i) => (
            <Text key={i} size="xs" className="mono" c={l.level === "error" ? "red" : l.level === "warn" ? "orange" : undefined} style={{ overflowWrap: "anywhere", padding: "2px 0" }}>{hhmm(l.t)} {partWord(l.part)} · {journalWord(l)}</Text>
          ))}
          {j.data && !lines.length && <Text size="sm" className="muted">Строк нет</Text>}
        </div>
      )}
      {more && <Button size="xs" variant="default" w="fit-content" onClick={() => void earlier()}>Раньше</Button>}
    </Stack>
  );
}

/** Ряды за период: запросы и отказы флота и числа Host выбранной машины. */
function Series() {
  const wide = useWide();
  const machines = useFleet((f) => f.machines);
  const nameOf = useMachineName();
  const [sp, setSp] = useSearchParams();
  const names = Object.values(machines).sort((a, b) => Number(b.online) - Number(a.online)).map((m) => m.name);
  const machine = sp.get("m") ?? names[0] ?? null;
  const [period, setPeriod] = useState("24h");
  const span = SERIES_PERIODS.find(([id]) => id === period)![2];
  const range = useMemo(() => { const until = Math.ceil(Date.now() / 60_000) * 60_000; return { until, since: until - span }; }, [span]);
  const stats = useCall(obsStats, range, { refetch: 60_000 });
  const long = span > 24 * 3_600_000;
  return (
    <Stack gap="sm">
      <Group gap="sm">
        <SegmentedControl size="xs" value={period} onChange={setPeriod} data={SERIES_PERIODS.map(([value, label]) => ({ value, label }))} aria-label="Период рядов" />
        <Select size="xs" w={200} aria-label="Машина" allowDeselect={false} data={names.map((m) => ({ value: m, label: nameOf(m) }))} value={machine} onChange={(v) => v && setSp({ m: v }, { replace: true })} />
      </Group>
      <div className="card" style={{ gap: 4 }}>
        <Text size="sm" fw={600}>Запросы флота</Text>
        {stats.error ? <Failed error={stats.error} retry={stats.refetch} /> : (
          <BarChart h={wide ? 150 : 110} data={(stats.data?.buckets ?? []).map((b) => ({ t: long ? `${day(b.at)} ${hhmm(b.at)}` : hhmm(b.at), ok: b.n - b.failed, bad: b.failed }))} dataKey="t" type="stacked" series={[{ name: "ok", label: "Приняты", color: "#869f96" }, { name: "bad", label: "Отказы", color: "#c5352b" }]} tickLine="none" gridAxis="y" withXAxis={wide} withLegend legendProps={{ verticalAlign: "bottom", height: 28 }} />
        )}
      </div>
      {machine ? <HostSeries machine={machine} period={period} /> : <Text size="sm" className="muted">Машин нет</Text>}
    </Stack>
  );
}

function Health() {
  const go = useNavigate();
  const nameOf = useMachineName();
  const wide = useWide();
  const range = useMemo(() => ({ until: Date.now(), since: Date.now() - 2 * 3_600_000 }), []);
  const stats = useCall(obsStats, range, { refetch: 15_000 });
  // сводка здоровья — одним запросом: машины, отказы, медленные запросы, сбои частей и ошибки, пойманные на месте
  const h = useCall(obsHealth, {}, { refetch: 15_000 });
  const d = h.data;
  const off = d?.machines.offline ?? [];
  const slow = d?.slow[0];
  return (
    <Stack gap="sm" mb="md">
      <div className="stats">
        <button type="button" className="stat" onClick={() => go(off[0] ? `/machine/${off[0].name}` : "/fleet/machines")}><b style={off.length ? { color: "var(--st-failed)" } : undefined}>{d ? `${d.machines.online} из ${d.machines.total}` : "…"}</b><span>машин на связи{off.length ? ` · нет ${off.map((m) => m.name).join(", ")}` : ""}</span></button>
        <div className="stat"><b>{d ? d.requests.n : "…"}</b><span>запросов за час</span></div>
        <div className="stat"><b style={d && d.requests.rate > 0.05 ? { color: "var(--st-failed)" } : undefined}>{d ? `${(d.requests.rate * 100).toFixed(1).replace(".", ",")}%` : "…"}</b><span>отказов{d?.sessions.failed.length ? ` · сессии со сбоем: ${d.sessions.failed.join(", ")}` : ""}</span></div>
        <div className="stat"><b>{slow ? ms(slow.p95) : "—"}</b><span>{slow ? <>самый медленный · <span className="mono">{slow.type}</span></> : "самый медленный"}</span></div>
      </div>
      <div className="card" style={{ padding: "10px 10px 4px" }}>
        <BarChart h={wide ? 110 : 70} data={(stats.data?.buckets ?? []).map((b) => ({ t: hhmm(b.at), ok: b.n - b.failed, bad: b.failed }))} dataKey="t" type="stacked" series={[{ name: "ok", label: "Запросы", color: "#869f96" }, { name: "bad", label: "Отказы", color: "#c5352b" }]} tickLine="none" gridAxis="none" withYAxis={false} withXAxis={wide} />
      </div>
      {d?.hosts && d.hosts.length > 0 && (
        <div className="card" style={{ gap: 2 }}>
          {d.hosts.map((x) => (
            <div key={x.machine} className="line" style={{ flexWrap: "wrap" }}>
              <button type="button" className="linkbtn" style={{ fontWeight: 600 }} onClick={() => go(`/machine/${x.machine}`)}>{nameOf(x.machine)}</button>
              <Text size="sm" className="grow" style={{ minWidth: 0, flex: "1 1 220px", overflowWrap: "anywhere" }}>{hostLine(x)}</Text>
              <Button size="compact-xs" variant="subtle" onClick={() => go(`/observe/series?m=${x.machine}`)}>Ряды</Button>
            </div>
          ))}
        </div>
      )}
      {d && (d.failures.length > 0 || d.reports.length > 0) && (
        <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {d.failures.length > 0 && (
            <div className="card">
              <Text fw={600}>Сбои частей</Text>
              {d.failures.slice(0, 5).map((e) => <div key={e.id} className="line"><Text size="xs" className="muted" style={{ whiteSpace: "nowrap" }}>{hhmm(e.at)}</Text><Text size="sm" className="grow" style={{ overflowWrap: "anywhere" }}>{e.text ?? e.what}</Text>{e.machine && <button type="button" className="linkbtn mono" onClick={() => go(`/machine/${e.machine}`)}>{e.machine}</button>}</div>)}
            </div>
          )}
          {d.reports.length > 0 && (
            <div className="card">
              <Text fw={600}>Ошибки страницы и Host</Text>
              {d.reports.slice(0, 5).map((r, i) => <div key={i} className="line"><Text size="xs" className="muted" style={{ whiteSpace: "nowrap" }}>{hhmm(r.at)}</Text><Text size="sm" className="grow" c={r.level === "error" ? "red" : "orange"} style={{ overflowWrap: "anywhere" }}>{r.msg}</Text><Text size="xs" className="muted">{PART_OF[r.part] ?? r.part}</Text></div>)}
            </div>
          )}
        </div>
      )}
    </Stack>
  );
}

export function Observe() {
  return (
    <TabsPage title="Наблюдение" base="/observe" tabs={[
      ["requests", "Запросы", () => <><Health /><Requests /></>],
      ["series", "Ряды", () => <Series />],
      ["ledger", "Журнал флота", () => <Ledger />],
      ["machine", "Журнал машины", () => <MachineLog />],
    ]} />
  );
}
