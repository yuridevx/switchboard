// Инспектор сессии: обзор (документ и сведения), контекст, файлы, точки, журнал.
import { accountList, machineJournal, peopleList, pointsDelete, pointsList, pointsSave, sessionCall, slotSwap, type SessionRow } from "@sb/protocol";
import { Badge, Button, Group, Progress, SegmentedControl, Select, Stack, Switch, Tabs, Text, TextInput } from "@mantine/core";
import { openStep } from "../shell/Page.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { act, api, sayError } from "../api.ts";
import { CONTEXT_PARTS, STATUS_LABELS } from "../chat/words.ts";
import type { View } from "../chat/fold.ts";
import { accountWord, confirmDanger, Failed, Lamp, personWord, STATE_WORD, useCall, useWide } from "../common.tsx";
import { Sortable } from "../lib/Sortable.tsx";
import { ago, bytesWord, count, day, duration, hhmm, kilo, LIMIT_NAMES, nPoints, nTurns } from "../lib/time.ts";
import { DeleteTyped } from "../screens/archive/Raise.tsx";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { DocFields } from "./Conversation.tsx";
import { patchDoc, useLabels, useLater } from "./doc.ts";

type Any = Record<string, any>;
const AfterTurn = ({ on }: { on: boolean }) => (on ? <span className="after-turn">после хода</span> : null);

/** Поле, которое пишется при уходе из него или по Enter. */
function Field({ label, value, onSave, disabled, mono, placeholder, note }: { label: string; value: string; onSave(v: string): void; disabled?: boolean; mono?: boolean; placeholder?: string; note?: React.ReactNode }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = () => v !== value && onSave(v);
  return <TextInput label={<>{label} {note}</>} className={mono ? "mono" : undefined} disabled={disabled} placeholder={placeholder} value={v} onChange={(e) => setV(e.currentTarget.value)} onBlur={save} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? setV(value) : undefined)} />;
}

/** Пара в «Обзоре»: общие ряды, две колонки — ведущий и ведомый. */
export function pairRows(lead: SessionRow, wing: SessionRow): Array<[string, string, string]> {
  const row = (label: string, of: (s: SessionRow) => string): [string, string, string] => [label, of(lead), of(wing)];
  return [
    row("Состояние", (s) => (s.compacting ? "сжимает контекст" : (s.doing ?? STATE_WORD[s.state]))),
    row("Модель", (s) => s.spec.model ?? "по умолчанию"),
    row("Очередь", (s) => accountWord(s.spec.slot) + (s.account && s.account !== s.spec.slot ? ` · ${s.account}` : "")),
    row("Кусочки", (s) => (s.spec.pieces ?? []).join(", ") || "нет"),
    row("Папка", (s) => s.spec.cwd),
    row("Открыта", (s) => ago(s.since)),
  ];
}

function PairInfo({ s, other }: { s: SessionRow; other: SessionRow }) {
  const labels = useLabels();
  const lead = s.spec.wing ? s : other, wing = lead === s ? other : s;
  const head = (x: SessionRow) => (x === s ? <span className="mono">{labels.name(x.callsign)}</span> : <Link className="mono" to={`/work/${x.callsign}`}>{labels.name(x.callsign)}</Link>);
  return (
    <dl className="pairkv" aria-label="Пара">
      <dt /><dd className="head">ведущий</dd><dd className="head">▸ ведомый</dd>
      <dt /><dd><Lamp state={lead.state} /> {head(lead)}</dd><dd><Lamp state={wing.state} /> {head(wing)}</dd>
      {pairRows(lead, wing).map(([label, a, b]) => <span key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{a}</dd><dd>{b}</dd></span>)}
    </dl>
  );
}

function Overview({ s, other }: { s: SessionRow; other?: SessionRow }) {
  const machine = machineOfCall(s.callsign);
  const people = useCall(peopleList, {});
  const off = useFleet((f) => f.machines[machine]?.online === false);
  const accounts = useCall(accountList, off ? null : { to: "@" + machine });
  const wide = useWide();
  const later = useLater(s);
  const labels = useLabels();
  const mine = accounts.data?.accounts.find((a) => a.id === s.account || a.email === s.account);
  // сессия стоит на очереди машины, а не на ключе флота
  const auto = !!accounts.data?.slots.some((q) => q.name === s.spec.slot);
  const qc = useQueryClient();
  return (
    <Stack gap="sm" p="md">
      {!wide && !off && <DocFields s={s} />}
      <Field label="Заголовок" disabled={off} value={s.spec.title ?? ""} placeholder={s.title} onSave={(title) => patchDoc(s, { title })} />
      <Field label="Папка" mono disabled={off} value={s.spec.cwd} note={<AfterTurn on={later.includes("cwd")} />} onSave={(cwd) => patchDoc(s, { cwd })} />
      <Select label="Проект" clearable disabled={off} data={(people.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={s.spec.project ?? null} onChange={(v) => patchDoc(s, { project: v ?? undefined })} />
      <Switch label={<>Быстрый режим <AfterTurn on={later.includes("fast")} /></>} disabled={off} checked={!!s.spec.fast} onChange={(e) => patchDoc(s, { fast: e.currentTarget.checked })} />
      <Switch label={<>Размышлять перед ответом <AfterTurn on={later.includes("thinking")} /></>} disabled={off} checked={!!s.spec.thinking} onChange={(e) => patchDoc(s, { thinking: e.currentTarget.checked })} />
      <Field label="Стиль ответа" disabled={off} value={s.spec.style ?? ""} note={<AfterTurn on={later.includes("style")} />} onSave={(style) => patchDoc(s, { style: style || undefined })} />
      <Switch label="Сохранять точки в архив" disabled={off} checked={!!s.spec.backup} onChange={(e) => (e.currentTarget.checked ? void patchDoc(s, { backup: true }) : stopBackup(s, () => qc.invalidateQueries({ queryKey: ["points.list"] })))} />
      {(s.spec.pieces?.length ?? 0) > 1 && !off && (
        <div>
          <Text size="sm" fw={500} mb={4}>Порядок кусочков <AfterTurn on={later.includes("pieces")} /></Text>
          <Sortable ids={s.spec.pieces!} label={(id) => id} onOrder={(pieces) => void patchDoc(s, { pieces })} row={(id) => <span className="mono">{id}</span>} />
        </div>
      )}
      <Switch label={<>Открыть в приложении Claude <AfterTurn on={later.includes("remote")} /></>} disabled={off} checked={!!s.spec.remote} onChange={(e) => patchDoc(s, { remote: e.currentTarget.checked })} />
      {s.remoteUrl && <Text size="sm" component="a" href={s.remoteUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: "anywhere" }}>{s.remoteUrl}</Text>}
      {other && <PairInfo s={s} other={other} />}
      <dl className="kv">
        {/* ведомого открыла ведущая: она названа один раз — в колонке пары выше */}
        {!s.lead && <><dt>Открыл</dt><dd className="mono">{personWord(s.by)}</dd></>}
        {!other && <><dt>Открыта</dt><dd>{ago(s.since)}</dd></>}
        {s.spec.parent && !s.lead && <><dt>Задачу дала</dt><dd><Link className="mono" to={`/work/${s.spec.parent}`}>{labels.name(s.spec.parent)}</Link></dd></>}
        {s.lead && !other && <><dt>Ведущий</dt><dd><Link className="mono" to={`/work/${s.lead}`}>{labels.name(s.lead)}</Link></dd></>}
        {s.incident && <><dt>Разбирает</dt><dd>{s.incident.kind} · <span className="mono">{s.incident.key}</span></dd></>}
        {/* у пары кусочки, аккаунт и срок стоят в её двух колонках выше */}
        {!other && <><dt>Кусочки</dt><dd>{(s.spec.pieces ?? []).join(", ") || "нет"}</dd></>}
        {!other ? <><dt>Очередь</dt><dd><span className="mono">{accountWord(s.spec.slot)}</span>{s.account && s.account !== s.spec.slot ? ` · ${s.account}` : ""}{mine?.plan ? ` · ${mine.plan}` : ""}</dd></> : mine?.plan ? <><dt>План</dt><dd>{mine.plan}</dd></> : null}
        {(mine?.limits ?? []).map((l) => <span key={l.name} style={{ display: "contents" }}><dt>{LIMIT_NAMES[l.name] ?? l.name}</dt><dd style={l.used >= 0.9 ? { color: "var(--st-failed)" } : l.used >= 0.7 ? { color: "var(--st-waiting)" } : undefined}>{Math.round(l.used * 100)}%{l.resets ? ` · сброс ${day(l.resets)}, ${hhmm(l.resets)}` : ""}</dd></span>)}
      </dl>
      {auto && !off && <Button size="xs" variant="default" w="fit-content" onClick={async () => (await act(slotSwap, { to: "@" + machine, slot: s.spec.slot ?? "" }, "Аккаунт очереди сменён")) && qc.invalidateQueries({ queryKey: ["account.list"] })}>Сменить аккаунт сейчас</Button>}
    </Stack>
  );
}

const RULE: Record<string, string> = { allow: "можно", deny: "нельзя", ask: "спросить" };
const PLACE: Record<string, string> = { userSettings: "настройки пользователя", projectSettings: "настройки проекта", localSettings: "локальные настройки", flagSettings: "настройки запуска", policySettings: "политика", cliArg: "запуск", command: "команда", session: "эта сессия" };
const HIDDEN_STATUS = new Set(["Peer address"]);
const MCP_WORD: Record<string, string> = { connected: "подключён", failed: "сбой", "needs-auth": "нужен вход", pending: "подключается", disabled: "выключен" };

/** Раздел панели: не ответил — слово причины; пусто — раздела нет. */
function Section({ title, q, children }: { title: string; q: { data?: unknown; error: unknown }; children(x: Any): React.ReactNode }) {
  if (q.error) return <div className="insp-sec"><h4>{title}</h4><Text size="sm" c="red">{sayError(q.error)}</Text></div>;
  if (q.data == null) return null;
  const body = children(q.data as Any);
  return body ? <div className="insp-sec"><h4>{title}</h4>{body}</div> : null;
}

function Context({ s }: { s: SessionRow }) {
  const live = s.state !== "stopped" && s.state !== "failed";
  const call = (method: "contextUsage" | "mcpStatus" | "usage" | "status" | "hooks" | "permissionRules" | "agents") => useCall(sessionCall, live ? { to: s.callsign, method } : null);
  const ctx = call("contextUsage"), mcp = call("mcpStatus"), usage = call("usage"), status = call("status"), hooks = call("hooks"), rules = call("permissionRules"), agents = call("agents");
  const qc = useQueryClient();
  const again = () => qc.invalidateQueries({ queryKey: ["session.call"] });
  if (!live) return <Text size="sm" className="muted" p="md">Сессия не работает: контекст виден у работающей</Text>;
  const u = ctx.data as Any | undefined;
  const pct = Math.round(Number(u?.percentage ?? 0));
  const servers = (Array.isArray(mcp.data) ? mcp.data : ((mcp.data as Any | undefined)?.servers ?? [])) as Any[];
  return (
    <Stack gap="md" p="md">
      {ctx.error ? <Failed error={ctx.error} retry={ctx.refetch} /> : u && (
        <div className="insp-sec">
          <Group justify="space-between" mb={4}><h4>Контекст</h4><Text size="sm">{kilo(u.totalTokens ?? 0)} из {kilo(u.maxTokens ?? 0)} · {pct}%</Text></Group>
          <Progress value={Math.min(100, pct)} color={pct >= 80 ? "red" : "ink"} aria-label="Занятость контекста" />
          <dl className="kv" style={{ marginTop: 8 }}>{((u.categories ?? []) as Any[]).filter((c) => c.tokens > 0).map((c) => <span key={c.name} style={{ display: "contents" }}><dt>{CONTEXT_PARTS[c.name] ?? c.name}</dt><dd>{kilo(c.tokens)}</dd></span>)}</dl>
          <Group gap="xs" mt="xs">
            <Button size="xs" variant="default" disabled={!!s.compacting} onClick={() => act(sessionCall, { to: s.callsign, method: "compact" }, "Сжатие контекста встало в очередь")}>{s.compacting ? "Сжимаю…" : "Сжать контекст"}</Button>
            <Button size="xs" variant="default" onClick={async () => (await act(sessionCall, { to: s.callsign, method: "reload" }, "Инструменты перечитаны")) !== undefined && again()}>Перечитать инструменты</Button>
          </Group>
        </div>
      )}
      <Section title="Расход" q={usage}>
        {(x) => {
          const windows = Object.entries((x.rate_limits ?? {}) as Record<string, Any | null>).filter(([, w]) => w && w.utilization != null);
          const ses = x.session;
          return (
            <dl className="kv">
              {ses && <><dt>Этот запуск</dt><dd>${Number(ses.total_cost_usd ?? 0).toFixed(2).replace(".", ",")}</dd><dt>Время API</dt><dd>{duration(ses.total_api_duration_ms ?? 0)}</dd><dt>Строки</dt><dd className="stat-pm"><b className="plus">+{ses.total_lines_added ?? 0}</b> <b className="minus">−{ses.total_lines_removed ?? 0}</b></dd></>}
              {windows.map(([name, w]) => <span key={name} style={{ display: "contents" }}><dt>{LIMIT_NAMES[name] ?? name}</dt><dd>{Math.round(Number(w!.utilization))}%{w!.resets_at ? ` · сброс ${day(Date.parse(w!.resets_at))}, ${hhmm(Date.parse(w!.resets_at))}` : ""}</dd></span>)}
            </dl>
          );
        }}
      </Section>
      <div className="insp-sec">
        <h4>Серверы MCP</h4>
        {mcp.error ? <Text size="sm" c="red">{sayError(mcp.error)}</Text> : servers.map((m) => {
          const tools = Array.isArray(m.tools) ? m.tools.length : Number(m.tools ?? 0);
          const run = (method: "mcpToggle" | "mcpReconnect", args: unknown[], said: string) => act(sessionCall, { to: s.callsign, method, args }, said).then((r) => void (r !== undefined && mcp.refetch()));
          return (
            <Group key={m.name} justify="space-between" wrap="nowrap" gap={6}>
              <span className="mono trunc" title={m.error}>{m.name}</span>
              <Group gap={6} wrap="nowrap">
                <Badge color={m.status === "connected" ? "teal" : m.status === "disabled" || m.status === "pending" ? "gray" : "red"}>{m.status === "connected" ? count(tools, "инструмент", "инструмента", "инструментов") : (MCP_WORD[m.status] ?? m.status)}</Badge>
                {m.status === "needs-auth" && <Button size="compact-xs" variant="default" onClick={async () => { const r = (await act(sessionCall, { to: s.callsign, method: "mcpAuthenticate", args: [m.name] })) as { authUrl?: string } | undefined; if (r?.authUrl) window.open(r.authUrl, "_blank", "noopener"); }}>Войти</Button>}
                {m.status === "failed" && <Button size="compact-xs" variant="default" onClick={() => run("mcpReconnect", [m.name], "Переподключаю")}>Переподключить</Button>}
                <Switch size="xs" aria-label={`${m.name}: включён`} checked={m.status !== "disabled"} onChange={(e) => run("mcpToggle", [m.name, e.currentTarget.checked], e.currentTarget.checked ? "Сервер включён" : "Сервер выключен")} />
              </Group>
            </Group>
          );
        })}
      </div>
      <Section title="Разрешения" q={rules}>
        {(x) => {
          const list = (x.state?.rules ?? x.rules ?? []) as Any[];
          return list.length ? list.map((r, i) => <div key={i} className="rule"><b>{RULE[r.behavior] ?? r.behavior}</b><span><span className="mono">{r.rule}</span> <span className="muted">· {PLACE[r.source] ?? r.source}</span></span></div>) : null;
        }}
      </Section>
      <Section title="Хуки" q={hooks}>
        {(x) => {
          const list = (x.hooks ?? []) as Any[];
          return list.length ? list.map((h, i) => <div key={i} className="rule"><b>{h.event}</b><span><span className="mono">{h.matcher}</span> {h.displayText && <span className="muted">· {h.displayText}</span>}</span></div>) : null;
        }}
      </Section>
      <Section title="Субагенты" q={agents}>
        {(x) => {
          const list = (Array.isArray(x) ? x : (x.agents ?? [])) as Any[];
          return list.length ? <dl className="kv" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}>{list.map((a) => <span key={a.name} style={{ display: "contents" }}><dt className="mono">{a.name}</dt><dd style={{ textAlign: "left" }}>{a.description}</dd></span>)}</dl> : null;
        }}
      </Section>
      <Section title="Claude" q={status}>
        {(x) => {
          const rows = ((x.sections ?? []) as Any[]).flatMap((sec) => (sec.rows ?? []) as Any[]).filter((r) => !HIDDEN_STATUS.has(r.label));
          return rows.length ? <dl className="kv">{rows.map((r, i) => <span key={i} style={{ display: "contents" }}><dt>{STATUS_LABELS[r.label] ?? r.label}</dt><dd>{String(r.value).replace("connected", "подключено")}</dd></span>)}</dl> : null;
        }}
      </Section>
    </Stack>
  );
}

/** Заголовок вкладки «Точки»: сколько точек, когда последняя и сколько она весит; сбой последней точки — словами и когда повтор. */
export function pointsHead(points: Array<{ at: number; bytes?: number }>, row: { archiveError?: string; archiveRetryAt?: number }): { word: string; error?: string } {
  const last = points.at(-1);
  const word = last ? `${nPoints(points.length)} · последняя ${day(last.at)}, ${hhmm(last.at)}${last.bytes ? ` · ${bytesWord(last.bytes)}` : ""}` : "Точек пока нет";
  return row.archiveError ? { word, error: `Последняя точка не сохранилась: ${row.archiveError}${row.archiveRetryAt ? ` · повтор в ${hhmm(row.archiveRetryAt)}` : ""}` } : { word };
}

/** Снять «Сохранять точки в архив»: точки сессии удаляются сразу и без отмены — только после ввода её имени. */
export function stopBackup(s: SessionRow, done: () => unknown) {
  const name = s.callsign.slice(0, s.callsign.indexOf("@"));
  openStep({
    title: "Не сохранять точки в архив", name: "backup",
    body: (close) => (
      <DeleteTyped name={name} body="Точки этой сессии в архиве будут удалены сразу, без отмены. Поднять её на другой машине станет не из чего."
        onDelete={async () => {
          if (!(await patchDoc(s, { backup: false }))) return;
          const mine = (await api.call(pointsList, { machine: machineOfCall(s.callsign) }).catch(() => null))?.sessions.find((a) => a.callsign === s.callsign);
          if (mine) await act(pointsDelete, { sid: mine.sid }, "Точки удалены из архива");
          close();
          await done();
        }} />
    ),
  });
}

function Points({ s }: { s: SessionRow }) {
  const qc = useQueryClient();
  const list = useCall(pointsList, { machine: machineOfCall(s.callsign) });
  const mine = list.data?.sessions.find((a) => a.callsign === s.callsign);
  const points = useCall(pointsList, mine ? { sid: mine.sid } : null);
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const head = pointsHead(points.data?.points ?? [], s as { archiveError?: string; archiveRetryAt?: number });
  return (
    <Stack gap="xs" p="md">
      <Text size="sm">{head.word}</Text>
      {head.error && <Text size="sm" c="red" role="alert">{head.error}</Text>}
      <Group gap="xs">
        <Button size="xs" variant="default" onClick={async () => (await act(pointsSave, { to: s.callsign }, "Точка сохранена")) && qc.invalidateQueries({ queryKey: ["points.list"] })}>Сохранить точку</Button>
        {mine && <Button size="xs" variant="subtle" component={Link} to={`/archive/${mine.sid}`}>Открыть в архиве</Button>}
      </Group>
      <div className="timeline">
        {[...(points.data?.points ?? [])].reverse().map((p) => (
          <div key={p.point} className="pt" style={{ cursor: "default" }}>
            <i />
            <span className="trunc">{p.label ?? nTurns(p.turns ?? 0)}</span>
            <span className="muted">{day(p.at)}, {hhmm(p.at)}</span>
          </div>
        ))}
      </div>
    </Stack>
  );
}

const PAGE = 60;
type Line = { t: number; part: string; level: string; msg: string };

/** Журнал: фильтры общие; у пары — две колонки, ведущий и ведомый. */
function Journal({ s, other }: { s: SessionRow; other?: SessionRow }) {
  const [level, setLevel] = useState("all");
  const [kind, setKind] = useState("all");
  const labels = useLabels();
  const lead = other && !s.spec.wing ? other : s, wing = other ? (lead === s ? other : s) : undefined;
  return (
    <Stack gap={6} p="md">
      <SegmentedControl size="xs" value={level} onChange={setLevel} data={[{ value: "all", label: "Все" }, { value: "warn", label: "Предупреждения" }, { value: "error", label: "Ошибки" }]} />
      <SegmentedControl size="xs" value={kind} onChange={setKind} data={[{ value: "all", label: "Любые" }, { value: "stop", label: "Остановки" }, { value: "refuse", label: "Отказы" }]} />
      {wing ? (
        <div className="pairlog">
          <div><Text size="xs" fw={600} className="mono trunc">{labels.name(lead.callsign)}</Text><JournalLines key={lead.callsign} s={lead} level={level} kind={kind} /></div>
          <div><Text size="xs" fw={600} className="mono trunc">▸ {labels.name(wing.callsign)}</Text><JournalLines key={wing.callsign} s={wing} level={level} kind={kind} /></div>
        </div>
      ) : <JournalLines key={s.callsign} s={s} level={level} kind={kind} />}
    </Stack>
  );
}

function JournalLines({ s, level, kind }: { s: SessionRow; level: string; kind: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = (before?: number) =>
    api.call(machineJournal, { to: "@" + machineOfCall(s.callsign), session: s.callsign, limit: PAGE, ...(level !== "all" ? { level: level as "warn" | "error" } : {}), ...(kind !== "all" ? { kind: kind as "stop" | "refuse" } : {}), ...(before ? { before } : {}) }).then(
      (r) => (setLines((l) => (before ? [...l, ...r.lines] : r.lines)), setMore(r.more), setError(null), setLoading(false)),
      (e) => (setError(e), setLoading(false)),
    );
  useEffect(() => {
    setLoading(true);
    void load();
  }, [s.callsign, level, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {error ? <Failed error={error} retry={() => load()} /> : !loading && !lines.length ? <Text size="sm" className="muted">Строк об этой сессии нет</Text> : null}
      {lines.map((l, i) => (
        <Text key={i} size="xs" className="mono" c={l.level === "error" ? "red" : l.level === "warn" ? "orange" : undefined} style={{ overflowWrap: "anywhere" }}>{hhmm(l.t)} {l.part} · {l.msg}</Text>
      ))}
      {more && <Button size="xs" variant="subtle" w="fit-content" onClick={() => load(lines.at(-1)?.t)}>Раньше</Button>}
    </>
  );
}

export function Inspector({ s, other, view, tab, onTab }: { s: SessionRow; /** вторая сторона пары */ other?: SessionRow; view?: View; tab?: string; onTab?: (t: string) => void }) {
  const [own, setOwn] = useState("doc");
  const value = tab ?? own;
  return (
    <Tabs value={value} onChange={(t) => t && (onTab ? onTab(t) : setOwn(t))} keepMounted={false} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <Tabs.List px={4} style={{ flexWrap: "nowrap" }}>
        <Tabs.Tab px={10} value="doc">Обзор</Tabs.Tab>
        <Tabs.Tab px={10} value="ctx">Контекст</Tabs.Tab>
        <Tabs.Tab px={10} value="points">Точки</Tabs.Tab>
        <Tabs.Tab px={10} value="log">Журнал</Tabs.Tab>
      </Tabs.List>
      <div className="scroll">
        <Tabs.Panel value="doc"><Overview key={s.callsign} s={s} other={other} /></Tabs.Panel>
        <Tabs.Panel value="ctx"><Context s={s} /></Tabs.Panel>
        <Tabs.Panel value="points"><Points s={s} /></Tabs.Panel>
        <Tabs.Panel value="log"><Journal key={s.callsign} s={s} other={other} /></Tabs.Panel>
      </div>
    </Tabs>
  );
}
