// «Наблюдение»: здоровье флота, последние запросы с путём по частям, журнал флота и журнал машины.
import { ledgerRead, machineJournal, obsRecent, obsStats, type ObsRow } from "@sb/protocol";
import { BarChart } from "@mantine/charts";
import { Badge, Button, Group, Select, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { Fragment, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { sayWord } from "../api.ts";
import { Failed, partWord, useCall, useWide } from "../common.tsx";
import { day, duration, hhmm } from "../lib/time.ts";
import { useFleet } from "../store/fleet.ts";
import { TabsPage } from "./Fleet.tsx";

const ms = (n: number) => (n >= 1000 ? duration(n) : `${n} мс`);
/** Исход словами: причина по-русски, код — мелко рядом. */
const outcome = (r: ObsRow) => (r.ok ? "принят" : sayWord(r.word).toLowerCase());

/** Путь запроса: причина первой строкой, отрезки по частям — подписанной полосой; отказ — у последней части. */
function Path({ r }: { r: ObsRow }) {
  const go = useNavigate();
  const spans = r.spans ?? [];
  const total = Math.max(1, spans.reduce((a, s) => a + s.ms, 0));
  const machine = r.to && /@/.test(r.to) ? r.to.slice(r.to.indexOf("@") + 1) : "";
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
                  <Table.Td className="mono" fw={500}>{r.type}</Table.Td>
                  <Table.Td className="mono" style={{ overflowWrap: "anywhere" }} data-l="От кого → кому">{r.from}{r.to ? ` → ${r.to}` : ""}</Table.Td>
                  <Table.Td ta="right" style={{ whiteSpace: "nowrap" }} data-l="Время">{ms(r.ms)}</Table.Td>
                  <Table.Td data-l="Исход"><Badge color={r.ok ? "teal" : "red"}>{outcome(r)}</Badge></Table.Td>
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

function Ledger() {
  const machines = useFleet((f) => f.machines);
  const [machine, setMachine] = useState<string | null>(null);
  const ev = useCall(ledgerRead, { limit: 80, ...(machine ? { machine } : {}) });
  if (ev.error) return <Failed error={ev.error} retry={ev.refetch} />;
  return (
    <Stack gap="sm">
      <Select size="xs" w={220} clearable placeholder="Машина" aria-label="Машина" data={Object.keys(machines)} value={machine} onChange={setMachine} />
      <div className="table-wrap">
        <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
          <Table.Tbody>
            {(ev.data?.events ?? []).map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td className="muted" style={{ whiteSpace: "nowrap" }}>{day(e.at)}, {hhmm(e.at)}</Table.Td>
                <Table.Td fw={500}>{e.text}</Table.Td>
                <Table.Td className="mono muted" data-l="Событие">{e.what}</Table.Td>
                <Table.Td className="mono muted" style={{ overflowWrap: "anywhere" }} data-l="Кто">{e.who}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}

function MachineLog() {
  const machines = useFleet((f) => f.machines);
  const [sp, setSp] = useSearchParams();
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  const machine = sp.get("m") ?? online[0] ?? null;
  const trace = sp.get("trace") ?? "";
  const [level, setLevel] = useState<string | null>(null);
  const j = useCall(machineJournal, machine ? { to: "@" + machine, limit: 80, ...(level ? { level: level as never } : {}), ...(trace ? { of: trace } : {}) } : null);
  const set = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  return (
    <Stack gap="sm">
      <Group gap="sm">
        <Select size="xs" w={180} aria-label="Машина" className="mono" data={online} value={machine} onChange={(v) => set("m", v)} />
        <Select size="xs" w={160} clearable placeholder="Уровень" aria-label="Уровень" data={[{ value: "warn", label: "предупреждения" }, { value: "error", label: "ошибки" }]} value={level} onChange={setLevel} />
        <TextInput size="xs" w={200} placeholder="Номер запроса" aria-label="Номер запроса" className="mono" value={trace} onChange={(e) => set("trace", e.currentTarget.value || null)} />
      </Group>
      {j.error ? <Failed error={j.error} retry={j.refetch} /> : (
        <div className="table-wrap" style={{ padding: "8px 12px" }}>
          {(j.data?.lines ?? []).map((l, i) => (
            <Text key={i} size="xs" className="mono" c={l.level === "error" ? "red" : l.level === "warn" ? "orange" : undefined} style={{ overflowWrap: "anywhere", padding: "2px 0" }}>{hhmm(l.t)} {partWord(l.part)} · {l.msg}</Text>
          ))}
          {j.data && !j.data.lines.length && <Text size="sm" className="muted">Строк нет</Text>}
        </div>
      )}
    </Stack>
  );
}

function Health() {
  const go = useNavigate();
  const wide = useWide();
  const machines = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const range = useMemo(() => ({ until: Date.now(), since: Date.now() - 2 * 3_600_000 }), []);
  const stats = useCall(obsStats, range, { refetch: 15_000 });
  const all = Object.values(machines);
  const n = (stats.data?.types ?? []).reduce((a, t) => a + t.n, 0), bad = (stats.data?.types ?? []).reduce((a, t) => a + t.failed, 0);
  const off = all.filter((m) => !m.online);
  const failed = Object.values(sessions).filter((s) => s.state === "failed").length;
  const worst = [...(stats.data?.types ?? [])].sort((a, b) => b.p95 - a.p95)[0];
  return (
    <Stack gap="sm" mb="md">
      <div className="stats">
        <button type="button" className="stat" onClick={() => go(off[0] ? `/machine/${off[0].name}` : "/fleet/machines")}><b style={off.length ? { color: "var(--st-failed)" } : undefined}>{all.length - off.length} из {all.length}</b><span>машин на связи{off.length ? ` · нет ${off.map((m) => m.name).join(", ")}` : ""}</span></button>
        <div className="stat"><b>{(n / 120).toFixed(1).replace(".", ",")}</b><span>запросов в минуту</span></div>
        <div className="stat"><b style={bad / Math.max(1, n) > 0.05 ? { color: "var(--st-failed)" } : undefined}>{((bad / Math.max(1, n)) * 100).toFixed(1).replace(".", ",")}%</b><span>отказов{failed ? ` · сессий со сбоем ${failed}` : ""}</span></div>
        <div className="stat"><b>{worst ? ms(worst.p95) : "—"}</b><span>{worst ? <>самый медленный · <span className="mono">{worst.type}</span></> : "самый медленный"}</span></div>
      </div>
      <div className="card" style={{ padding: "10px 10px 4px" }}>
        <BarChart h={wide ? 110 : 70} data={(stats.data?.buckets ?? []).map((b) => ({ t: hhmm(b.at), ok: b.n - b.failed, bad: b.failed }))} dataKey="t" type="stacked" series={[{ name: "ok", label: "Запросы", color: "#869f96" }, { name: "bad", label: "Отказы", color: "#c5352b" }]} tickLine="none" gridAxis="none" withYAxis={false} withXAxis={wide} />
      </div>
    </Stack>
  );
}

export function Observe() {
  return (
    <TabsPage title="Наблюдение" base="/observe" tabs={[
      ["requests", "Запросы", () => <><Health /><Requests /></>],
      ["ledger", "Журнал флота", () => <Ledger />],
      ["machine", "Журнал машины", () => <MachineLog />],
    ]} />
  );
}
