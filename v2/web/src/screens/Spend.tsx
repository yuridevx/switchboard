// «Расход»: вызовы модели и токены по дням и разрезам. Аналитика стоит в стороне: её отказ ничего не ломает.
import { analyticsQuery, peopleList } from "@sb/protocol";
import { BarChart } from "@mantine/charts";
import { Button, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import { useState } from "react";
import { CallError } from "@sb/protocol";
import { Failed, modelWord, personWord, useCall } from "../common.tsx";
import { kilo, num } from "../lib/time.ts";

const BY = [["model", "Модели"], ["machine", "Машины"], ["session", "Сессии"], ["person", "Люди"], ["project", "Проекты"]] as const;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function Spend() {
  const [days, setDays] = useState("7");
  const [by, setBy] = useState<(typeof BY)[number][0]>("model");
  const to = iso(Date.now()), from = iso(Date.now() - (Number(days) - 1) * 86_400_000);
  const daily = useCall(analyticsQuery, { by: "day", since: from, until: to });
  const cut = useCall(analyticsQuery, { by, since: from, until: to });
  const projects = useCall(peopleList, {});
  const down = daily.error instanceof CallError && daily.error.word === "analytics_unavailable";
  const word = (key: string) => (by === "model" ? modelWord(key) : by === "person" ? personWord(key) : by === "project" ? (projects.data?.projects.find((p) => p.id === key)?.name ?? key) : key);
  const total = (daily.data?.rows ?? []).reduce((a, r) => ({ cost: a.cost + (r.cost ?? 0), calls: a.calls + r.calls, out: a.out + r.output }), { cost: 0, calls: 0, out: 0 });
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
              <div><Text size="xl" fw={700}>${num(Math.round(total.cost))}</Text><Text size="sm" className="muted">за {days} дней</Text></div>
              <div><Text size="xl" fw={700}>{num(total.calls)}</Text><Text size="sm" className="muted">вызовов модели</Text></div>
              <div><Text size="xl" fw={700}>{kilo(total.out)}</Text><Text size="sm" className="muted">токенов ответа</Text></div>
            </Group>
            <div className="card">
              <BarChart h={220} data={(daily.data?.rows ?? []).map((r) => ({ day: r.key.slice(5), "Расход, $": r.cost ?? 0 }))} dataKey="day" series={[{ name: "Расход, $", color: "ink.6" }]} tickLine="none" gridAxis="y" withTooltip />
            </div>
            <SegmentedControl size="xs" w="fit-content" value={by} onChange={(v) => setBy(v as never)} data={BY.map(([value, label]) => ({ value, label }))} aria-label="Разрез" />
            <div className="table-wrap">
              <Table verticalSpacing={6} horizontalSpacing="md">
                <Table.Thead><Table.Tr><Table.Th>{BY.find(([v]) => v === by)![1]}</Table.Th><Table.Th ta="right">Расход</Table.Th><Table.Th ta="right">Вызовы</Table.Th><Table.Th ta="right">Ввод</Table.Th><Table.Th ta="right">Ответ</Table.Th><Table.Th ta="right">Из кэша</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {(cut.data?.rows ?? []).map((r) => (
                    <Table.Tr key={r.key}>
                      <Table.Td className={by === "session" || by === "machine" ? "mono" : undefined}>{word(r.key)}</Table.Td>
                      <Table.Td ta="right">${num(Math.round((r.cost ?? 0) * 100) / 100)}</Table.Td><Table.Td ta="right">{num(r.calls)}</Table.Td><Table.Td ta="right">{kilo(r.input)}</Table.Td><Table.Td ta="right">{kilo(r.output)}</Table.Td><Table.Td ta="right">{kilo(r.cacheRead)}</Table.Td>
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
