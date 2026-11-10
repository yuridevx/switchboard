// «Настройки → Сбои и цены»: кого звать о сбоях флота (obs.alerts) и цены моделей для расхода (prices). Обе — общие настройки флота.
import { peopleList, prefsGet, prefsSet } from "@sb/protocol";
import { ActionIcon, Button, Group, MultiSelect, NumberInput, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { act } from "../../api.ts";
import { Failed, personWord, useCall } from "../../common.tsx";
import { useFleet } from "../../store/fleet.ts";

export type AlertPrefs = { off?: boolean; rate?: number; min?: number; to?: string[] };
export type Prices = Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
type PriceRow = { model: string; input: number | ""; output: number | ""; cacheRead: number | ""; cacheWrite: number | "" };

/** Значения служб по умолчанию: доля отказов 25% при 20 и более запросах за пять минут. */
export const ALERT_DEFAULTS = { rate: 0.25, min: 20 };
const COLS: Array<[keyof Omit<PriceRow, "model">, string]> = [["input", "Ввод"], ["output", "Вывод"], ["cacheRead", "Чтение кэша"], ["cacheWrite", "Запись кэша"]];
export const rowsOfPrices = (p: Prices): PriceRow[] => Object.entries(p).map(([model, v]) => ({ model, input: v.input ?? "", output: v.output ?? "", cacheRead: v.cacheRead ?? "", cacheWrite: v.cacheWrite ?? "" }));
/** Строки таблицы → настройка: пустые ячейки не пишутся, строки без модели пропускаются. */
export function pricesOfRows(rows: PriceRow[]): Prices {
  const out: Prices = {};
  for (const r of rows) {
    if (!r.model.trim()) continue;
    out[r.model.trim()] = Object.fromEntries(COLS.filter(([k]) => r[k] !== "").map(([k]) => [k, Number(r[k])]));
  }
  return out;
}

export function Fleetwide() {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const prefs = useCall(prefsGet, { scope: "fleet" });
  const people = useCall(peopleList, {});
  const [alerts, setAlerts] = useState<AlertPrefs | null>(null);
  const [prices, setPrices] = useState<PriceRow[] | null>(null);
  useEffect(() => {
    if (!prefs.data) return;
    if (!alerts) setAlerts((prefs.data.values["obs.alerts"] as AlertPrefs | undefined) ?? {});
    if (!prices) setPrices(rowsOfPrices((prefs.data.values.prices as Prices | undefined) ?? {}));
  }, [prefs.data]);
  if (prefs.error) return <Failed error={prefs.error} retry={prefs.refetch} />;
  const a = alerts ?? {};
  const rows = prices ?? [];
  const save = async (name: string, value: unknown, done: string) => (await act(prefsSet, { scope: "fleet", name, value }, done)) && qc.invalidateQueries({ queryKey: ["prefs.get"] });
  const setRow = (i: number, p: Partial<PriceRow>) => setPrices(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const admins = (people.data?.people ?? []).filter((p) => p.admin).map((p) => p.name ?? personWord(p.person));
  return (
    <Stack>
      <div className="card">
        <Text fw={600}>Оповещения о сбоях</Text>
        <Switch label="Звать людей, когда сбоит часть флота или растёт доля отказов" checked={!a.off} disabled={!admin} onChange={(e) => setAlerts({ ...a, off: !e.currentTarget.checked })} />
        <Group align="end" gap="sm">
          <NumberInput label="Доля отказов, %" w={150} min={1} max={100} disabled={!admin || a.off} value={Math.round((a.rate ?? ALERT_DEFAULTS.rate) * 100)} onChange={(v) => setAlerts({ ...a, rate: Number(v) / 100 })} />
          <NumberInput label="Начиная с запросов за 5 минут" w={230} min={1} disabled={!admin || a.off} value={a.min ?? ALERT_DEFAULTS.min} onChange={(v) => setAlerts({ ...a, min: Number(v) })} />
        </Group>
        <MultiSelect label="Кого звать" placeholder={a.to?.length ? undefined : `админов: ${admins.join(", ")}`} disabled={!admin || a.off} data={(people.data?.people ?? []).map((p) => ({ value: p.person, label: p.name ?? personWord(p.person) }))} value={a.to ?? []} onChange={(v) => setAlerts({ ...a, to: v.length ? v : undefined })} clearable />
        {admin && <Button w="fit-content" size="xs" onClick={() => void save("obs.alerts", a, "Оповещения сохранены")}>Сохранить</Button>}
      </div>
      <div className="card">
        <Text fw={600}>Цены моделей, $ за миллион токенов</Text>
        <div className="table-wrap" style={{ border: 0 }}>
          <Table verticalSpacing={5} horizontalSpacing="xs" className="stack">
            <Table.Thead><Table.Tr><Table.Th>Модель или начало имени</Table.Th>{COLS.map(([, w]) => <Table.Th key={w}>{w}</Table.Th>)}<Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {rows.map((r, i) => (
                <Table.Tr key={i}>
                  <Table.Td><TextInput size="xs" className="mono" aria-label="Модель" disabled={!admin} value={r.model} onChange={(e) => setRow(i, { model: e.currentTarget.value })} /></Table.Td>
                  {COLS.map(([k, w]) => <Table.Td key={k} data-l={w}><NumberInput size="xs" w={110} aria-label={`${w}: ${r.model}`} disabled={!admin} min={0} decimalScale={4} value={r[k]} onChange={(v) => setRow(i, { [k]: v === "" ? "" : Number(v) })} /></Table.Td>)}
                  <Table.Td ta="right">{admin && <ActionIcon variant="subtle" color="red" aria-label={`Убрать цену ${r.model}`} onClick={() => setPrices(rows.filter((_, j) => j !== i))}><IconTrash size={14} /></ActionIcon>}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {!rows.length && <Text size="sm" className="muted">Цен нет: расход считается только в токенах</Text>}
        {admin && (
          <Group>
            <Button size="xs" variant="default" onClick={() => setPrices([...rows, { model: "", input: "", output: "", cacheRead: "", cacheWrite: "" }])}>Добавить модель</Button>
            <Button size="xs" onClick={() => void save("prices", pricesOfRows(rows), "Цены сохранены")}>Сохранить</Button>
          </Group>
        )}
      </div>
    </Stack>
  );
}
