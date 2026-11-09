// «Новая сессия»: одно поле и Enter — сессия пошла с разумными значениями; остальное раскрывается.
import { machineDirs, peopleList, profileList, sessionOpen } from "@sb/protocol";
import { Button, Chip, Collapse, Group, Modal, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { act } from "../api.ts";
import { EFFORTS, MODELS, MODES, useCall, useUi } from "../common.tsx";
import { useFleet } from "../store/fleet.ts";

const nameOf = (cwd: string) => (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "session").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "session";

function Form({ onClose }: { onClose: () => void }) {
  const go = useNavigate();
  const preset = useUi((u) => u.newPreset);
  const machines = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const online = Object.values(machines).filter((m) => m.online);
  const [machine, setMachine] = useState(preset?.machine ?? online[0]?.name ?? "");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [more, setMore] = useState(false);
  const [pieces, setPieces] = useState<string[]>(["base"]);
  const [model, setModel] = useState<string>(MODELS[0][0]);
  const [effort, setEffort] = useState("high");
  const [mode, setMode] = useState("all");
  const [project, setProject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirs = useCall(machineDirs, machine ? { to: "@" + machine } : null);
  const list = useCall(profileList, machine ? { to: "@" + machine } : null);
  const people = useCall(peopleList, {});
  useEffect(() => { if (!cwd && dirs.data?.recent?.[0]) setCwd(dirs.data.recent[0]); }, [dirs.data, cwd]);
  const auto = nameOf(cwd);
  let free = auto;
  for (let i = 2; sessions[`${free}@${machine}`]; i++) free = `${auto}-${i}`;
  const finalName = name || free;
  const start = async () => {
    if (!machine || !cwd) return;
    setBusy(true);
    const r = await act(sessionOpen, { to: "@" + machine, spec: { name: finalName, cwd, model, effort: effort as never, mode: mode as never, account: "auto", pieces, backup: true, ...(project ? { project } : {}) }, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
    setBusy(false);
    if (r) {
      onClose();
      go(`/work/${r.callsign}`);
    }
  };
  return (
    <Stack gap="sm">
      <Textarea autoFocus autosize minRows={2} maxRows={8} placeholder="Что сделать" aria-label="Первое сообщение" value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), void start())} />
      <Chip.Group value={machine} onChange={(v) => (setMachine(v as string), setCwd(""))}>
        <Group gap={6}>{Object.values(machines).map((m) => <Chip key={m.name} value={m.name} size="sm" disabled={!m.online} variant="outline"><span className="mono">{m.name}</span>{m.online ? "" : " · нет связи"}</Chip>)}</Group>
      </Chip.Group>
      <Chip.Group value={cwd} onChange={(v) => setCwd(v as string)}>
        <Group gap={6}>{(dirs.data?.recent ?? []).map((d) => <Chip key={d} value={d} size="xs" variant="outline"><span className="mono">{d}</span></Chip>)}</Group>
      </Chip.Group>
      <Group gap="sm" align="end" wrap="nowrap">
        <TextInput label="Папка" className="mono" style={{ flex: 2 }} value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} />
        <TextInput label="Имя" className="mono" style={{ flex: 1 }} placeholder={free} value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} />
      </Group>
      <Button variant="subtle" size="compact-xs" w="fit-content" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? "Скрыть настройки" : "Модель, кусочки, проект"}</Button>
      <Collapse expanded={more}>
        <Stack gap="sm">
          <Group gap="sm" grow>
            <Select label="Модель" data={MODELS.map(([value, label]) => ({ value, label }))} value={model} onChange={(v) => v && setModel(v)} allowDeselect={false} />
            <Select label="Усилие" data={EFFORTS.map(([value, label]) => ({ value, label }))} value={effort} onChange={(v) => v && setEffort(v)} allowDeselect={false} />
            <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={mode} onChange={(v) => v && setMode(v)} allowDeselect={false} />
          </Group>
          <div>
            <Text size="sm" fw={500} mb={4}>Кусочки</Text>
            <Chip.Group multiple value={pieces} onChange={setPieces}>
              <Group gap={6}>{(list.data?.pieces ?? []).map((p) => <Chip key={p.id} value={p.id} size="xs" disabled={!p.ok} variant="outline">{p.title ?? p.id}</Chip>)}</Group>
            </Chip.Group>
          </div>
          <Select label="Проект" clearable data={(people.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} />
        </Stack>
      </Collapse>
      <Group justify="space-between">
        <Text size="sm" className="mono muted">{finalName}@{machine}</Text>
        <Button loading={busy} disabled={!machine || !cwd} onClick={start}>{prompt.trim() ? "Открыть и отправить" : "Открыть сессию"}</Button>
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
