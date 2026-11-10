// «Флот → Инциденты»: обращения служб компьютера — открытые и все, недоставленные с причиной, правила видов.
import { incidentList, prefsGet, prefsSet, type Incident, type IncidentKind } from "@sb/protocol";
import { ActionIcon, Badge, Button, Group, Modal, MultiSelect, SegmentedControl, Stack, Table, TagsInput, Text, Textarea, TextInput } from "@mantine/core";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { act, api } from "../../api.ts";
import { confirmDanger, useCall } from "../../common.tsx";
import { ago, hhmm } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";

const WORD = { pending: "ждёт", taken: "разбирается", done: "закрыто" } as const;
export type Row = Incident & { machine: string };

/** Что показать: открытые или все; недоставленные — отдельно, со словом причины. */
export function splitIncidents(rows: Row[], all: boolean): { list: Row[]; undelivered: Row[] } {
  const sorted = [...rows].sort((a, b) => b.at - a.at);
  return { list: sorted.filter((r) => (all || r.state !== "done") && !(r.state === "pending" && r.why)), undelivered: sorted.filter((r) => r.state === "pending" && r.why) };
}

function KindForm({ name, kind, isNew, onSave, onClose }: { name: string; kind: IncidentKind; isNew: boolean; onSave: (name: string, k: IncidentKind) => void; onClose: () => void }) {
  const machines = useFleet((f) => f.machines);
  const [n, setN] = useState(name);
  const [k, setK] = useState(kind);
  const set = (p: Partial<IncidentKind>) => setK({ ...k, ...p });
  const badNotify = (k.notify ?? []).find((p) => !/^~\S+@\S+\.\S+$/.test(p));
  return (
    <Stack gap="sm">
      <TextInput label="Вид обращения" className="mono" disabled={!isNew} value={n} onChange={(e) => setN(e.currentTarget.value)} placeholder="disk" />
      <TextInput label="Папка сессии" className="mono" value={k.cwd} onChange={(e) => set({ cwd: e.currentTarget.value })} placeholder="~/ops" />
      <Textarea label="Что сказать сессии" autosize minRows={2} value={k.prompt ?? ""} onChange={(e) => set({ prompt: e.currentTarget.value || undefined })} />
      <TagsInput label="Кусочки профиля" className="mono" value={k.pieces ?? []} onChange={(v) => set({ pieces: v.length ? v : undefined })} />
      <Group grow>
        <TextInput label="Аккаунт" className="mono" value={k.account ?? ""} onChange={(e) => set({ account: e.currentTarget.value || undefined })} placeholder="auto" />
        <TextInput label="Модель" className="mono" value={k.model ?? ""} onChange={(e) => set({ model: e.currentTarget.value || undefined })} />
      </Group>
      <TagsInput label="Кого позвать" placeholder="~почта" value={k.notify ?? []} onChange={(v) => set({ notify: v.length ? v : undefined })} error={badNotify ? `${badNotify}: нужен человек вида ~a@b.c` : undefined} />
      <MultiSelect label="Только на машинах" data={Object.keys(machines)} value={k.machines ?? []} onChange={(v) => set({ machines: v.length ? v : undefined })} clearable />
      <Group><Button disabled={!/^[a-z0-9][a-z0-9_.-]*$/i.test(n) || !k.cwd.trim() || !!badNotify} onClick={() => onSave(n, k)}>Сохранить</Button><Button variant="default" onClick={onClose}>Отмена</Button></Group>
    </Stack>
  );
}

/** Правила видов обращений — общая настройка флота incidents.kinds: где открыть сессию, что ей сказать и кого позвать. */
function Kinds() {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const prefs = useCall(prefsGet, { scope: "fleet", prefix: "incidents.kinds" });
  const kinds = (prefs.data?.values["incidents.kinds"] as Record<string, IncidentKind> | undefined) ?? {};
  const [edit, setEdit] = useState<{ name: string; kind: IncidentKind; isNew: boolean } | null>(null);
  const patch = async (name: string, k: IncidentKind | null, done: string) => (await act(prefsSet, { scope: "fleet", name: "incidents.kinds", patch: { [name]: k } }, done)) && qc.invalidateQueries({ queryKey: ["prefs.get"] });
  return (
    <div className="card">
      <Group justify="space-between"><Text fw={600}>Правила видов</Text>{admin && <Button size="compact-xs" variant="default" onClick={() => setEdit({ name: "", kind: { cwd: "" }, isNew: true })}>Добавить вид</Button>}</Group>
      {Object.entries(kinds).map(([name, k]) => (
        <div key={name} className="line">
          <div className="grow">
            <Text size="sm" fw={500} className="mono">{name}</Text>
            <Text size="xs" className="muted" style={{ overflowWrap: "anywhere" }}><span className="mono">{k.cwd}</span>{k.notify?.length ? ` · зовёт ${k.notify.map((p) => p.replace(/^~/, "")).join(", ")}` : ""}{k.machines?.length ? ` · только ${k.machines.join(", ")}` : ""}</Text>
          </div>
          {admin && <ActionIcon variant="subtle" aria-label={`Изменить вид ${name}`} onClick={() => setEdit({ name, kind: k, isNew: false })}><IconPencil size={15} /></ActionIcon>}
          {admin && <ActionIcon variant="subtle" color="red" aria-label={`Удалить вид ${name}`} onClick={() => confirmDanger({ title: `Удалить вид «${name}»?`, body: "Обращения этого вида перестанут открывать сессии.", confirm: "Удалить", onConfirm: () => patch(name, null, "Вид удалён") })}><IconTrash size={15} /></ActionIcon>}
        </div>
      ))}
      {prefs.data && !Object.keys(kinds).length && <Text size="sm" className="muted">Видов нет: обращения некому разбирать</Text>}
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? "Новый вид обращений" : `Вид ${edit?.name}`}>
        {edit && <KindForm {...edit} onClose={() => setEdit(null)} onSave={async (name, k) => { if (await patch(name, k, "Правило сохранено, машины его перечитают")) setEdit(null); }} />}
      </Modal>
    </div>
  );
}

export function Incidents() {
  const go = useNavigate();
  const machines = useFleet((f) => f.machines);
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name).sort();
  const [show, setShow] = useState("open");
  const lists = useQueries({ queries: online.map((m) => ({ queryKey: ["incident.list", m], queryFn: () => api.call(incidentList, { to: "@" + m }), retry: false, refetchInterval: 15_000 })) });
  const rows: Row[] = lists.flatMap((q, i) => (q.data?.incidents ?? []).map((x) => ({ ...x, machine: online[i]! })));
  const ports = lists.flatMap((q, i) => (q.data?.port ? [`${online[i]}: ${q.data.port}`] : []));
  const { list, undelivered } = splitIncidents(rows, show === "all");
  return (
    <Stack>
      <Group justify="space-between">
        <SegmentedControl size="xs" value={show} onChange={setShow} data={[{ value: "open", label: "Открытые" }, { value: "all", label: "Все" }]} aria-label="Какие обращения" />
        {ports.length > 0 && <Text size="xs" className="muted">Службы компьютера пишут на 127.0.0.1, порт — <span className="mono">{ports.join(" · ")}</span></Text>}
      </Group>
      {undelivered.length > 0 && (
        <div className="card" style={{ borderColor: "var(--st-failed)" }}>
          <Text fw={600}>Не доставлены</Text>
          {undelivered.map((x) => (
            <div key={x.machine + x.id} className="line">
              <div className="grow"><Text size="sm">{x.text}</Text><Text size="xs" className="mono muted">{x.kind} · {x.key} · {x.machine}</Text><Text size="xs" c="red">{x.why}</Text></div>
              <Text size="xs" className="muted" style={{ whiteSpace: "nowrap" }}>с {hhmm(x.at)}</Text>
            </div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Обращение</Table.Th><Table.Th>Вид и ключ</Table.Th><Table.Th>Машина</Table.Th><Table.Th>Состояние</Table.Th><Table.Th>Разбирает</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {list.map((x) => (
              <Table.Tr key={x.machine + x.id}>
                <Table.Td>{x.text}{x.files?.length ? <Text size="xs" className="mono muted">{x.files.join(", ")}</Text> : null}</Table.Td>
                <Table.Td data-l="Вид и ключ" className="mono">{x.kind} · {x.key}</Table.Td>
                <Table.Td data-l="Машина" className="mono">{x.machine}</Table.Td>
                <Table.Td data-l="Состояние"><Badge color={x.state === "pending" ? "orange" : x.state === "taken" ? "blue" : "gray"}>{WORD[x.state]}</Badge></Table.Td>
                <Table.Td data-l="Разбирает">{x.callsign && <Button size="compact-xs" variant="subtle" className="mono" onClick={() => go(`/work/${x.callsign}`)}>{x.callsign}</Button>}</Table.Td>
                <Table.Td data-l="Когда" className="muted" ta="right">{ago(x.at)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {!list.length && <Text size="sm" className="muted" p="md">{show === "open" ? "Открытых обращений нет" : "Обращений нет"}</Text>}
      </div>
      <Kinds />
    </Stack>
  );
}
