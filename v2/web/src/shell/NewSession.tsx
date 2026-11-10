// «Новая сессия»: одно поле и Enter — сессия пошла с разумными значениями; остальное раскрывается.
// Недавние места — пары «машина + папка»; папку можно создать; кусочки подхватываются от соседней сессии той же папки.
import { accountList, machineDirs, peopleList, profileList, sessionOpen, type MachineRow, type SessionRow } from "@sb/protocol";
import { Button, Chip, Collapse, Group, Modal, Select, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { act, sayError } from "../api.ts";
import { EFFORTS, MODELS, MODES, useCall, useMyPrefs, useUi } from "../common.tsx";
import { useFleet } from "../store/fleet.ts";

export const nameOf = (cwd: string) => (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "session").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "session";

/** Свободное имя на машине: само имя, иначе имя-2, имя-3… */
export function freeName(base: string, machine: string, sessions: Record<string, unknown>): string {
  let free = base;
  for (let i = 2; sessions[`${free}@${machine}`]; i++) free = `${base}-${i}`;
  return free;
}

/** Порядок машин в выборе: на связи раньше, свои раньше чужих, дальше по имени. */
export function sortMachines(list: MachineRow[], me?: string): MachineRow[] {
  return [...list].sort((a, b) => Number(b.online) - Number(a.online) || Number(b.owner === me) - Number(a.owner === me) || a.name.localeCompare(b.name));
}

export type Place = { machine: string; cwd: string };
/** Недавние места: новое — в начало, без повторов, не больше восьми. */
export const pushPlace = (list: Place[], p: Place): Place[] => [p, ...list.filter((x) => x.machine !== p.machine || x.cwd !== p.cwd)].slice(0, 8);

/** Кусочки для новой сессии: как у соседней сессии той же папки на той же машине; соседа нет — основа. */
export function piecesFor(sessions: Record<string, SessionRow>, machine: string, cwd: string): string[] {
  const mate = Object.values(sessions).filter((s) => s.callsign.endsWith("@" + machine) && s.spec.cwd === cwd && s.spec.pieces?.length).sort((a, b) => (b.last ?? b.since) - (a.last ?? a.since))[0];
  return mate?.spec.pieces ?? ["base"];
}

/** Родительская папка и последнее имя пути: по ним видно, есть ли папка и что подсказать. */
export function splitPath(cwd: string): { parent: string; leaf: string } {
  const at = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
  return at < 0 ? { parent: "", leaf: cwd } : { parent: cwd.slice(0, at) || cwd.slice(0, at + 1), leaf: cwd.slice(at + 1) };
}

/** Tab в поле папки: набранное начало дополняется до подпапки, если она одна; иначе — до общего начала подходящих. Нечего дополнять — null. */
export function tabInto(parent: string, leaf: string, dirs: string[]): string | null {
  const fit = dirs.filter((d) => d.toLowerCase().startsWith(leaf.toLowerCase()));
  if (!fit.length || (fit.length === 1 && fit[0] === leaf)) return null;
  let common = fit[0]!;
  for (const d of fit) while (!d.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
  if (common.length <= leaf.length && fit.length > 1) return null;
  const sep = /\\/.test(parent) && !parent.includes("/") ? "\\" : "/";
  return `${parent}${/[\\/]$/.test(parent) ? "" : sep}${fit.length === 1 ? fit[0] + sep : common}`;
}

function Form({ onClose }: { onClose: () => void }) {
  const go = useNavigate();
  const preset = useUi((u) => u.newPreset) as ({ machine?: string; cwd?: string; project?: string } | null);
  const machineRows = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const me = useFleet((f) => f.you?.person);
  const prefs = useMyPrefs();
  const places = (prefs.values.places as Place[] | undefined) ?? [];
  const machines = useMemo(() => sortMachines(Object.values(machineRows), me), [machineRows, me]);
  const firstPlace = places.find((p) => machineRows[p.machine]?.online);
  const [machine, setMachine] = useState(preset?.machine ?? firstPlace?.machine ?? machines.find((m) => m.online)?.name ?? "");
  const [cwd, setCwdRaw] = useState(preset?.cwd ?? (!preset?.machine && firstPlace ? firstPlace.cwd : ""));
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [more, setMore] = useState(false);
  const [pieces, setPieces] = useState<string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState("all");
  const [account, setAccount] = useState("auto");
  const [fast, setFast] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [style, setStyle] = useState("");
  const [backup, setBackup] = useState(true);
  const [pair, setPair] = useState(false);
  const [resume, setResume] = useState("");
  const [fork, setFork] = useState(false);
  const [project, setProject] = useState<string | null>(preset?.project ?? null);
  const [busy, setBusy] = useState(false);
  const setCwd = (v: string) => (setCwdRaw(v), setPieces(null));
  const { parent, leaf } = splitPath(cwd);
  const dirs = useCall(machineDirs, machine ? { to: "@" + machine } : null);
  const inside = useCall(machineDirs, machine && parent ? { to: "@" + machine, path: parent } : null);
  const list = useCall(profileList, machine ? { to: "@" + machine } : null);
  const accounts = useCall(accountList, machine ? { to: "@" + machine } : null);
  const people = useCall(peopleList, {});
  useEffect(() => { if (!cwd && dirs.data?.recent?.[0]) setCwdRaw(dirs.data.recent[0]); }, [dirs.data, cwd]);
  const here = places.filter((p) => p.machine === machine).map((p) => p.cwd);
  const recent = [...new Set([...here, ...(dirs.data?.recent ?? [])])].slice(0, 8);
  // подпапки, имя которых начинается с набранного; папки с таким именем нет — её можно создать
  const sub = (inside.data?.dirs ?? []).filter((d) => d.toLowerCase().startsWith(leaf.toLowerCase()) && d !== leaf).slice(0, 8);
  const missing = !!leaf && !!inside.data && inside.data.path === parent && !inside.data.dirs.includes(leaf);
  const picked = pieces ?? piecesFor(sessions, machine, cwd);
  const finalName = name || freeName(nameOf(cwd), machine, sessions);
  const start = async () => {
    if (!machine || !cwd) return;
    setBusy(true);
    const r = await act(sessionOpen, {
      to: "@" + machine,
      spec: { name: finalName, cwd, ...(model ? { model } : {}), ...(effort ? { effort: effort as never } : {}), mode: mode as never, account, pieces: picked, backup, ...(fast ? { fast: true } : {}), ...(thinking ? { thinking: true } : {}), ...(style.trim() ? { style: style.trim() } : {}), ...(project ? { project } : {}) },
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}), ...(missing ? { mkdir: true } : {}), ...(pair ? { pair: true } : {}), ...(resume.trim() ? { resume: resume.trim(), ...(fork ? { fork: true } : {}) } : {}),
    });
    setBusy(false);
    if (r) {
      void prefs.save("places", pushPlace(places, { machine, cwd }));
      onClose();
      go(`/work/${r.callsign}`);
    }
  };
  return (
    <Stack gap="sm">
      <Textarea autoFocus autosize minRows={2} maxRows={8} placeholder="Что сделать" aria-label="Первое сообщение" value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), void start())} />
      {places.length > 0 && (
        <Group gap={6} aria-label="Недавние места">
          {places.slice(0, 4).map((p) => <Chip key={p.machine + p.cwd} size="xs" variant="outline" checked={p.machine === machine && p.cwd === cwd} disabled={!machineRows[p.machine]?.online} onChange={() => (setMachine(p.machine), setCwd(p.cwd))}><span className="mono">{p.machine} · {p.cwd}</span></Chip>)}
        </Group>
      )}
      <Chip.Group value={machine} onChange={(v) => (setMachine(v as string), setCwd(""))}>
        <Group gap={6}>{machines.map((m) => <Chip key={m.name} value={m.name} size="sm" disabled={!m.online} variant="outline"><span className="mono">{m.name}</span>{m.online ? "" : " · нет связи"}</Chip>)}</Group>
      </Chip.Group>
      <Chip.Group value={cwd} onChange={(v) => setCwd(v as string)}>
        <Group gap={6}>{recent.map((d) => <Chip key={d} value={d} size="xs" variant="outline"><span className="mono">{d}</span></Chip>)}</Group>
      </Chip.Group>
      <Group gap="sm" align="end" wrap="nowrap">
        <TextInput label="Папка" className="mono" style={{ flex: 2 }} value={cwd} onChange={(e) => setCwd(e.currentTarget.value)}
          error={inside.error ? sayError(inside.error) : undefined}
          onKeyDown={(e) => { const to = e.key === "Tab" && !e.shiftKey ? tabInto(parent, leaf, inside.data?.dirs ?? []) : null; if (to) (e.preventDefault(), setCwd(to)); }} />
        <TextInput label="Имя" className="mono" style={{ flex: 1 }} placeholder={finalName} value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} />
      </Group>
      {parent && !leaf && inside.data && inside.data.path === parent && !inside.data.dirs.length && <Text size="xs" className="muted">В папке {parent} подпапок нет</Text>}
      {sub.length > 0 && (
        <Group gap={6} aria-label="Подпапки">
          {sub.map((d) => <Button key={d} size="compact-xs" variant="default" className="mono" onClick={() => setCwd(`${parent}${/[\\/]$/.test(parent) ? "" : "/"}${d}`)}>{d}</Button>)}
        </Group>
      )}
      <Button variant="subtle" size="compact-xs" w="fit-content" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? "Скрыть настройки" : "Модель, аккаунт, кусочки, проект"}</Button>
      <Collapse expanded={more}>
        <Stack gap="sm">
          <Group gap="sm" grow>
            <Select label="Модель" placeholder="по умолчанию" clearable data={MODELS.map(([value, label]) => ({ value, label }))} value={model} onChange={setModel} />
            <Select label="Усилие" placeholder="как у модели" clearable data={EFFORTS.map(([value, label]) => ({ value, label }))} value={effort} onChange={setEffort} />
            <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={mode} onChange={(v) => v && setMode(v)} allowDeselect={false} />
          </Group>
          <Select label="Аккаунт" data={[{ value: "auto", label: "авто — по лимитам" }, ...(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.kind === "key" ? `ключ ${a.id}${a.model ? ` · ${a.model}` : ""}` : a.id, disabled: !a.ok }))]} value={account} onChange={(v) => v && setAccount(v)} allowDeselect={false} />
          <div>
            <Text size="sm" fw={500} mb={4}>Кусочки</Text>
            <Chip.Group multiple value={picked} onChange={setPieces}>
              <Group gap={6}>{(list.data?.pieces ?? []).map((p) => <Chip key={p.id} value={p.id} size="xs" disabled={!p.ok} variant="outline">{p.title ?? p.id}</Chip>)}</Group>
            </Chip.Group>
          </div>
          <Select label="Проект" clearable data={(people.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} />
          <Group gap="lg">
            <Switch label="Быстрый режим" checked={fast} onChange={(e) => setFast(e.currentTarget.checked)} />
            <Switch label="Всегда размышлять" checked={thinking} onChange={(e) => setThinking(e.currentTarget.checked)} />
            <Switch label="Сохранять точки в архив" checked={backup} onChange={(e) => setBackup(e.currentTarget.checked)} />
            <Switch label="С ведомым" checked={pair} onChange={(e) => setPair(e.currentTarget.checked)} />
          </Group>
          <TextInput label="Стиль ответа" value={style} onChange={(e) => setStyle(e.currentTarget.value)} />
          <Group gap="sm" align="end" wrap="nowrap">
            <TextInput label="Продолжить разговор с диска машины" placeholder="номер разговора" className="mono" style={{ flex: 1 }} value={resume} onChange={(e) => setResume(e.currentTarget.value)} />
            <Switch label="Копией" disabled={!resume.trim()} checked={fork} onChange={(e) => setFork(e.currentTarget.checked)} />
          </Group>
        </Stack>
      </Collapse>
      <Group justify="space-between">
        <Text size="sm" className="mono muted">{finalName}@{machine}</Text>
        <Button loading={busy} disabled={!machine || !cwd} onClick={start}>{missing ? "Создать папку и открыть" : prompt.trim() ? "Открыть и отправить" : "Открыть сессию"}</Button>
      </Group>
    </Stack>
  );
}

export function NewSession() {
  const open = useUi((u) => u.newOpen);
  const set = useUi((u) => u.set);
  const close = () => set({ newOpen: false, newPreset: null });
  return <Modal opened={open} onClose={close} title="Новая сессия" size="lg">{open && <Form onClose={close} />}</Modal>;
}
