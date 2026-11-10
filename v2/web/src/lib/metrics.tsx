// Числа Host: последнее окно словами и ряды за период графиками. Одно место для «Наблюдения» и экрана машины.
import { obsSeries, type HostMetrics } from "@sb/protocol";
import { AreaChart, BarChart, LineChart } from "@mantine/charts";
import { SegmentedControl, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { Failed, STATE_WORD, useCall, useWide } from "../common.tsx";
import { day, duration, hhmm } from "./time.ts";

const MIN = 60_000, HOUR = 60 * MIN;
/** Периоды рядов: Host отдаёт числа раз в минуту, служба хранит их 7 дней. */
export const SERIES_PERIODS: Array<[id: string, label: string, ms: number]> = [["1h", "Час", HOUR], ["24h", "Сутки", 24 * HOUR], ["7d", "7 дней", 7 * 24 * HOUR]];
const ms = (n: number) => (n >= 1000 ? duration(n) : `${Math.round(n)} мс`);

export type SeriesPoint = {
  at: number; t: string;
  /** время ответа провайдера: медиана — средняя по вызовам отрезка, 95-й процентиль — худший в отрезке */
  p50: number; p95: number; calls: number; failed: number; retries: number;
  /** сессии по состояниям и очередь ввода — на конец отрезка */
  busy: number; waiting: number; idle: number; other: number; queue: number;
  crashes: number; resumes: number;
};

/** Минутные окна Host → точки графика: период делится на равные отрезки (не больше `max`), пустые отрезки пропускаются. */
export function seriesPoints(rows: HostMetrics[], since: number, until: number, max = 48): SeriesPoint[] {
  const span = Math.max(MIN, until - since);
  const step = Math.max(MIN, Math.ceil(span / max / MIN) * MIN);
  const long = span > 24 * HOUR;
  const cells = new Map<number, HostMetrics[]>();
  for (const r of rows) {
    if (r.at < since || r.at >= until) continue;
    const at = since + Math.floor((r.at - since) / step) * step;
    (cells.get(at) ?? (cells.set(at, []), cells.get(at)!)).push(r);
  }
  return [...cells].sort((a, b) => a[0] - b[0]).map(([at, list]) => {
    const last = list.reduce((a, b) => (b.at > a.at ? b : a));
    const calls = list.reduce((n, r) => n + r.provider.n, 0);
    const state = (k: string) => last.sessions[k] ?? 0;
    const known = state("busy") + state("waiting") + state("idle");
    return {
      at, t: long ? `${day(at)} ${hhmm(at)}` : hhmm(at),
      p50: calls ? Math.round(list.reduce((n, r) => n + r.provider.p50 * r.provider.n, 0) / calls) : 0,
      p95: Math.max(0, ...list.filter((r) => r.provider.n).map((r) => r.provider.p95)),
      calls, failed: list.reduce((n, r) => n + r.provider.failed, 0), retries: list.reduce((n, r) => n + r.provider.retries, 0),
      busy: state("busy"), waiting: state("waiting"), idle: state("idle"), other: Object.values(last.sessions).reduce((n, v) => n + v, 0) - known, queue: last.queue,
      crashes: list.reduce((n, r) => n + r.crashes, 0), resumes: list.reduce((n, r) => n + r.resumes, 0),
    };
  });
}

/** Сессии по состояниям одной строкой: только те состояния, где кто-то есть. */
export function sessionsWord(by: Record<string, number>): string {
  const order = ["busy", "waiting", "idle", "starting", "stopping", "stopped", "failed"];
  const bits = Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, n]) => `${STATE_WORD[k as keyof typeof STATE_WORD] ?? k} ${n}`);
  return bits.length ? bits.join(" · ") : "нет";
}

/** Последнее окно одной строкой — для сводки по машинам: сессии, очередь, худшее время провайдера, сбои. */
export function hostLine(m: HostMetrics): string {
  const bits = [sessionsWord(m.sessions) === "нет" ? "сессий нет" : sessionsWord(m.sessions)];
  if (m.queue) bits.push(`в очереди ввода ${m.queue}`);
  if (m.provider.n) bits.push(`провайдер 95% ${ms(m.provider.p95)}`);
  if (m.provider.failed) bits.push(`отказов провайдера ${m.provider.failed}`);
  if (m.crashes) bits.push(`процесс вышел ${m.crashes}`);
  return bits.join(" · ");
}

/** Последнее окно чисел Host словами. */
export function HostNumbers({ m }: { m: HostMetrics }) {
  const p = m.provider;
  return (
    <dl className="kv">
      <dt>Сессии</dt><dd>{sessionsWord(m.sessions)}</dd>
      <dt>Очередь ввода</dt><dd>{m.queue}</dd>
      <dt>Провайдер</dt><dd>{p.n ? `медиана ${ms(p.p50)} · 95% ${ms(p.p95)} · вызовов ${p.n}` : "вызовов не было"}{p.failed ? ` · отказов ${p.failed}` : ""}{p.retries ? ` · повторов ${p.retries}` : ""}</dd>
      <dt>Процессы claude</dt><dd>{m.crashes ? `вышли сами ${m.crashes} · возобновлено ${m.resumes}` : "сбоев нет"}</dd>
      <dt>Замер</dt><dd>{hhmm(m.at)}</dd>
    </dl>
  );
}

const COLORS = { p50: "#5f7a71", p95: "#c77700", busy: "#2f6fde", waiting: "#c77700", idle: "#2e8b62", other: "#8a9692", crashes: "#c5352b", resumes: "#5f7a71", failed: "#8a6fd1" };

/** Ряды машины за период: время ответа провайдера, сессии по состояниям, сбои процессов и отказы провайдера. */
export function HostSeries({ machine, period: given }: { machine: string; /** период задан снаружи — своего переключателя нет */ period?: string }) {
  const wide = useWide();
  const [own, setPeriod] = useState("24h");
  const period = given ?? own;
  const span = SERIES_PERIODS.find(([id]) => id === period)![2];
  // граница периода выровнена по минуте: запрос не меняется на каждую отрисовку
  const until = useMemo(() => Math.ceil(Date.now() / MIN) * MIN, [period, machine]);
  const since = until - span;
  const series = useCall(obsSeries, { machine, since, until, limit: Math.min(10_080, span / MIN) }, { refetch: 60_000 });
  const points = useMemo(() => seriesPoints(series.data?.rows ?? [], since, until, wide ? 48 : 24), [series.data, since, until, wide]);
  // подписи рядов переносятся в две строки: под них оставлено место, чтобы они не выходили за карточку
  const h = wide ? 190 : 160;
  const axis = { tickLine: "none" as const, gridAxis: "y" as const, withXAxis: wide, withLegend: true, legendProps: { verticalAlign: "bottom" as const, height: 52 } };
  return (
    <div className="card" style={{ gap: 10 }}>
      {!given && <SegmentedControl size="xs" w="fit-content" value={period} onChange={setPeriod} data={SERIES_PERIODS.map(([value, label]) => ({ value, label }))} aria-label="Период рядов" />}
      {series.error ? <Failed error={series.error} retry={series.refetch} /> : series.data && !points.length ? <Text size="sm" className="muted">За этот период чисел нет: Host присылает их раз в минуту</Text> : (
        <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", alignItems: "start" }}>
          <div>
            <Text size="sm" fw={600} mb={4}>Ответ провайдера, мс</Text>
            <LineChart h={h} data={points} dataKey="t" withDots={false} curveType="monotone" series={[{ name: "p50", label: "Медиана", color: COLORS.p50 }, { name: "p95", label: "95%", color: COLORS.p95 }]} {...axis} />
          </div>
          <div>
            <Text size="sm" fw={600} mb={4}>Сессии по состояниям</Text>
            <AreaChart h={h} data={points} dataKey="t" type="stacked" withDots={false} curveType="stepAfter" series={[{ name: "busy", label: "Работают", color: COLORS.busy }, { name: "waiting", label: "Ждут", color: COLORS.waiting }, { name: "idle", label: "Свободны", color: COLORS.idle }, { name: "other", label: "Остальные", color: COLORS.other }]} {...axis} />
          </div>
          <div>
            <Text size="sm" fw={600} mb={4}>Сбои процессов и провайдера</Text>
            <BarChart h={h} data={points} dataKey="t" series={[{ name: "crashes", label: "Процесс вышел", color: COLORS.crashes }, { name: "resumes", label: "Возобновлён", color: COLORS.resumes }, { name: "failed", label: "Отказ провайдера", color: COLORS.failed }]} {...axis} />
          </div>
        </div>
      )}
    </div>
  );
}
