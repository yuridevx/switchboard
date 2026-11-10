// «Расход»: вызовы модели и токены по дням и разрезам. Аналитика стоит в стороне: её отказ ничего не ломает.
import { analyticsQuery, CallError, peopleList } from "@sb/protocol";
import { BarChart } from "@mantine/charts";
import { Button, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import { useState } from "react";
import { Failed, modelWord, personWord, useCall, useWide } from "../common.tsx";
import { day, kilo, num } from "../lib/time.ts";

const BY = [["model", "Модели"], ["machine", "Машины"], ["session", "Сессии"], ["person", "Люди"], ["project", "Проекты"]] as const;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Цвета слоёв столбика: средние тона, читаются в обеих темах. */
const LAYERS = ["#5f7a71", "#2f6fde", "#c77700", "#2e8b62", "#8a6fd1", "#c5352b", "#8a9692"];
const money = (v: number) => `$${num(Math.round(v))}`;

export function Spend() {
  const wide = useWide();
  const [days, setDays] = useState("7");
  const [by, setBy] = useState<(typeof BY)[number][0]>("model");
  const to = iso(Date.now()), from = iso(Date.now() - (Number(days) - 1) * 86_400_000);
  // по дням с раскладкой по выбранному разрезу: служба, которая раскладки не знает, вернёт дни без неё — столбики будут одним слоем
  const daily = useCall(analyticsQuery, { by: "day", since: from, until: to, split: by } as never);
  const cut = useCall(analyticsQuery, { by, since: from, until: to });
  const projects = useCall(peopleList, {});
  const down = daily.error instanceof CallError && daily.error.word === "analytics_unavailable";
  const word = (key: string) => (by === "model" ? modelWord(key) : by === "person" ? personWord(key) : by === "project" ? (projects.data?.projects.find((p) => p.id === key)?.name ?? key) : key);
  const rows = daily.data?.rows ?? [];
  const total = rows.reduce((a, r) => ({ cost: a.cost + (r.cost ?? 0), calls: a.calls + r.calls, out: a.out + r.output }), { cost: 0, calls: 0, out: 0 });
  const keys = (cut.data?.rows ?? []).map((r) => r.key);
  const split = rows.some((r) => (r as { parts?: Record<string, number> }).parts);
  const shown = keys.slice(0, LAYERS.length - 1), rest = keys.slice(LAYERS.length - 1);
  const data = rows.map((r) => {
    const parts = (r as { parts?: Record<string, number> }).parts ?? {};
    const out: Record<string, number | string> = { day: day(Date.parse(r.key)) };
    // ключи слоёв — без точек и пробелов: график читает точку в имени как путь; подпись слоя — отдельно
    if (!split) out.k0 = r.cost ?? 0;
    else {
      shown.forEach((k, i) => (out["k" + i] = parts[k] ?? 0));
      if (rest.length) out.rest = rest.reduce((a, k) => a + (parts[k] ?? 0), 0);
    }
    return out;
  });
  const series = !split ? [{ name: "k0", label: "Расход", color: LAYERS[0]! }] : [...shown.map((k, i) => ({ name: "k" + i, label: word(k), color: LAYERS[i]! })), ...(rest.length ? [{ name: "rest", label: "остальное", color: LAYERS.at(-1)! }] : [])];
  return (
    <div className="scroll">
      <div className="page">
        <Group justify="space-between" mb="md">
          <h1 style={{ fontSize: 20, margin: 0 }}>Расход</h1>
          <SegmentedControl size="xs" value={days} onChange={setDays} data={[{ value: "7", label: "7 дней" }, { value: "30", label: "30 дней" }]} aria-label="Период" />
        </Group>
        {down ? (
          <div className="card" role="status">
            <Text fw={600}>Аналитика недоступна</Text>
            <Text size="sm">Хранилище расчётов не отвечает. Сессии, архив и поиск работают; пропущенное дольётся из архива.</Text>
            <Button size="xs" variant="default" w="fit-content" onClick={() => (daily.refetch(), cut.refetch())}>Повторить</Button>
          </div>
        ) : daily.error ? <Failed error={daily.error} retry={daily.refetch} /> : (
          <Stack gap="lg">
            <Group gap="xl">
              <div><Text size="xl" fw={700}>{money(total.cost)}</Text><Text size="sm" className="muted">расход</Text></div>
              <div><Text size="xl" fw={700}>{num(total.calls)}</Text><Text size="sm" className="muted">вызовов модели</Text></div>
              <div><Text size="xl" fw={700}>{kilo(total.out)}</Text><Text size="sm" className="muted">токенов ответа</Text></div>
            </Group>
            <SegmentedControl size="xs" w={wide ? "fit-content" : "100%"} value={by} onChange={(v) => setBy(v as never)} data={BY.map(([value, label]) => ({ value, label }))} aria-label="Разрез" />
            <div className="card">
              <BarChart h={wide ? 240 : 180} data={data} dataKey="day" type="stacked" series={series} tickLine="none" gridAxis="y" withTooltip withLegend={split} valueFormatter={money} yAxisLabel={wide ? "$ в день" : undefined} />
            </div>
            <div className="table-wrap">
              <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
                <Table.Thead><Table.Tr><Table.Th>{BY.find(([v]) => v === by)![1]}</Table.Th><Table.Th ta="right">Расход</Table.Th><Table.Th ta="right">Вызовы</Table.Th><Table.Th ta="right">Ввод</Table.Th><Table.Th ta="right">Ответ</Table.Th><Table.Th ta="right">Из кэша</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {(cut.data?.rows ?? []).map((r) => (
                    <Table.Tr key={r.key}>
                      <Table.Td className={by === "session" || by === "machine" ? "mono" : undefined} fw={500}>{word(r.key)}</Table.Td>
                      <Table.Td ta="right" data-l="Расход">${num(Math.round((r.cost ?? 0) * 100) / 100)}</Table.Td><Table.Td ta="right" data-l="Вызовы">{num(r.calls)}</Table.Td><Table.Td ta="right" data-l="Ввод">{kilo(r.input)}</Table.Td><Table.Td ta="right" data-l="Ответ">{kilo(r.output)}</Table.Td><Table.Td ta="right" data-l="Из кэша">{kilo(r.cacheRead)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          </Stack>
        )}
      </div>
    </div>
  );
}
