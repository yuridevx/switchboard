// «Новая сессия»: одно поле и Enter — сессия пошла с разумными значениями; все поля — на одном уровне, ничего не спрятано.
// Недавние места — пары «машина + папка»; папку можно создать; кусочки подхватываются от соседней сессии той же папки.
import { accountList, machineConversations, machineDirs, peopleList, profileList, profileView, sessionOpen, type MachineRow, type SessionRow } from "@sb/protocol";
import { Badge, Button, Chip, Group, Select, SimpleGrid, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { act, sayError } from "../api.ts";
import { EFFORTS, MODELS, MODES, useCall, useMyPrefs } from "../common.tsx";
import { ago } from "../lib/time.ts";
import { RoutePage } from "./Page.tsx";
import { seatOptions } from "../lib/accounts.ts";
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

/** Пустой путь разговоров не ищет. */
const missing0 = (cwd: string) => !cwd.trim();

export type Place = { machine: string; cwd: string };
/** Недавние места: новое — в начало, без повторов, не больше восьми. */
export const pushPlace = (list: Place[], p: Place): Place[] => [p, ...list.filter((x) => x.machine !== p.machine || x.cwd !== p.cwd)].slice(0, 8);

/** Кусочки для новой сессии: как у соседней сессии той же папки на той же машине; соседа нет — без кусочков. */
export function piecesFor(sessions: Record<string, SessionRow>, machine: string, cwd: string): string[] {
  const mate = Object.values(sessions).filter((s) => s.callsign.endsWith("@" + machine) && s.spec.cwd === cwd && s.spec.pieces?.length).sort((a, b) => (b.last ?? b.since) - (a.last ?? a.since))[0];
  return mate?.spec.pieces ?? [];
}

/** Что набор кусочков ставит сам: слова для полей формы. */
export const GIVEN: Record<string, string> = { model: "модель", effortLevel: "усилие", fastMode: "быстрый режим", alwaysThinkingEnabled: "размышления", outputStyle: "стиль" };

/** Кусочки в выборе: чаще стоящие у сессий флота — раньше; при равенстве — как отдала машина. */
export function byUse<P extends { id: string }>(pieces: P[], sessions: Record<string, SessionRow>): P[] {
  const n = new Map<string, number>();
  for (const s of Object.values(sessions)) for (const id of s.spec.pieces ?? []) n.set(id, (n.get(id) ?? 0) + 1);
  return [...pieces].sort((a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0));
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

export function NewForm() {
  const go = useNavigate();
  // с какой машины или проекта пришли — в адресе страницы
  const [at] = useSearchParams();
  const preset = { machine: at.get("machine") ?? undefined, cwd: at.get("cwd") ?? undefined, project: at.get("project") ?? undefined };
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
  const [pieces, setPieces] = useState<string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState("all");
  const [seat, setSeat] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [thinking, setThinking] = useState(true);
  const [style, setStyle] = useState("");
  const [backup, setBackup] = useState(true);
  const [pair, setPair] = useState(false);
  const [resume, setResume] = useState("");
  const [fork, setFork] = useState(false);
  const [number, setNumber] = useState(false);
  const [project, setProject] = useState<string | null>(preset?.project ?? null);
  const [busy, setBusy] = useState(false);
  const setCwd = (v: string) => (setCwdRaw(v), setPieces(null), setSeat(null));
  const { parent, leaf } = splitPath(cwd);
  const dirs = useCall(machineDirs, machine ? { to: "@" + machine } : null);
  const inside = useCall(machineDirs, machine && parent ? { to: "@" + machine, path: parent } : null);
  const list = useCall(profileList, machine ? { to: "@" + machine } : null);
  const accounts = useCall(accountList, machine ? { to: "@" + machine } : null);
  const people = useCall(peopleList, {});
  // разговор, который держит живая сессия, продолжается только копией: два процесса на один разговор не идут
  const held = (list0: Array<{ id: string; live?: string }> | undefined) => list0?.find((t) => t.id === resume)?.live;
  const talks = useCall(machineConversations, machine && cwd && !missing0(cwd) ? { to: "@" + machine, cwd } : null);
  useEffect(() => { if (!cwd && dirs.data?.recent?.[0]) setCwdRaw(dirs.data.recent[0]); }, [dirs.data, cwd]);
  const here = places.filter((p) => p.machine === machine).map((p) => p.cwd);
  const recent = [...new Set([...here, ...(dirs.data?.recent ?? [])])].slice(0, 8);
  // подпапки, имя которых начинается с набранного; папки с таким именем нет — её можно создать
  const sub = (inside.data?.dirs ?? []).filter((d) => d.toLowerCase().startsWith(leaf.toLowerCase()) && d !== leaf).slice(0, 8);
  const missing = !!leaf && !!inside.data && inside.data.path === parent && !inside.data.dirs.includes(leaf);
  // кусочка соседней сессии на машине может уже не быть: в выбор идут только те, что машина отдала
  const picked = (pieces ?? piecesFor(sessions, machine, cwd)).filter((id) => !list.data || list.data.pieces.some((p) => p.id === id && p.ok));
  // что выбранный набор ставит сам — видно в полях ниже до открытия сессии
  const view = useCall(profileView, machine && picked.length ? { to: "@" + machine, pieces: picked } : null);
  const given = picked.length ? (view.data?.settings ?? {}) : {};
  const from = (key: string, none: string) => (given[key] ? `${String(given[key]!.value)} — из кусочков` : none);
  const finalName = name || freeName(nameOf(cwd), machine, sessions);
  // на машине нет ни входа Claude, ни ключа флота — сессии не на чем идти
  const seats = seatOptions(accounts.data);
  // очередь новой сессии: выбранная, иначе первая годная очередь машины, иначе первый годный ключ
  const account = seat && seats.some((o) => o.value === seat && !o.disabled) ? seat : (seats.find((o) => !o.disabled)?.value ?? "");
  const noAccount = !!accounts.data && !account;
  const start = async () => {
    if (!machine || !cwd) return;
    setBusy(true);
    const r = await act(sessionOpen, {
      to: "@" + machine,
      spec: { name: finalName, cwd, ...(model ? { model } : {}), ...(effort ? { effort: effort as never } : {}), mode: mode as never, slot: account, pieces: picked, backup, ...(fast ? { fast: true } : {}), thinking, ...(style.trim() ? { style: style.trim() } : {}), ...(project ? { project } : {}) },
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}), ...(missing ? { mkdir: true } : {}), ...(pair ? { pair: true } : {}), ...(number ? { number: true } : {}), ...(resume.trim() ? { resume: resume.trim(), ...(fork || held(talks.data?.conversations) ? { fork: true } : {}) } : {}),
    });
    setBusy(false);
    if (r) {
      void prefs.save("places", pushPlace(places, { machine, cwd }));
      go(`/work/${r.callsign}`, { replace: true });
    }
  };
  return (
    <Stack gap="sm">
      <TextInput autoFocus label="Имя" className="mono" placeholder={finalName} value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), void start())} />
      <Textarea autosize minRows={2} maxRows={8} placeholder="Что сделать" aria-label="Первое сообщение" value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)}
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
      </Group>
      {parent && !leaf && inside.data && inside.data.path === parent && !inside.data.dirs.length && <Text size="xs" className="muted">В папке {parent} подпапок нет</Text>}
      {sub.length > 0 && (
        <Group gap={6} aria-label="Подпапки">
          {sub.map((d) => <Button key={d} size="compact-xs" variant="default" className="mono" onClick={() => setCwd(`${parent}${/[\\/]$/.test(parent) ? "" : "/"}${d}`)}>{d}</Button>)}
        </Group>
      )}
      {(talks.data?.conversations ?? []).length > 0 && (
        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm" fw={500}>Продолжить разговор этой папки</Text>
            <Switch size="xs" label="Копией" disabled={!resume || !!held(talks.data?.conversations)} checked={fork || !!held(talks.data?.conversations)} onChange={(e) => setFork(e.currentTarget.checked)} />
          </Group>
          <div role="listbox" aria-label="Разговоры папки" className="card" style={{ gap: 0, padding: 4 }}>
            {talks.data!.conversations.slice(0, 6).map((t) => (
              <div key={t.id} role="option" aria-selected={resume === t.id} tabIndex={0} className={`row${resume === t.id ? " sel" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) auto", padding: "6px 10px" }}
                onClick={() => setResume(resume === t.id ? "" : t.id)} onKeyDown={(e) => e.key === "Enter" && setResume(resume === t.id ? "" : t.id)}>
                <span className="trunc">{t.title}</span>
                <span className="muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{t.live ? <>занят <span className="mono">{t.live}</span> · копией · </> : null}{ago(t.at)} · {Math.max(1, Math.round(t.size / 1024))} КБ</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <Text size="sm" fw={500} mb={4}>Кусочки</Text>
        <Chip.Group multiple value={picked} onChange={setPieces}>
          <Group gap={6}>{byUse(list.data?.pieces ?? [], sessions).map((p) => <Chip key={p.id} value={p.id} size="xs" disabled={!p.ok} variant="outline" title={p.ok ? p.about : p.why}>{p.title ?? p.id}</Chip>)}</Group>
        </Chip.Group>
        {Object.keys(given).length > 0 && (
          <Group gap={6} mt={6} aria-label="Что ставят кусочки">
            {Object.entries(given).map(([k, w]) => <Badge key={k} variant="default" title={`из ${w.from}`}><span className="muted">{GIVEN[k] ?? k}</span> {String(w.value)}</Badge>)}
          </Group>
        )}
      </div>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm">
        <Select label="Модель" placeholder={from("model", "по умолчанию")} clearable data={MODELS.map(([value, label]) => ({ value, label }))} value={model} onChange={setModel} />
        <Select label="Усилие" placeholder={from("effortLevel", "как у модели")} clearable data={EFFORTS.map(([value, label]) => ({ value, label }))} value={effort} onChange={setEffort} />
        <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={mode} onChange={(v) => v && setMode(v)} allowDeselect={false} />
        <Select label="Очередь аккаунтов" data={seats} value={account || null} onChange={(v) => v && setSeat(v)} allowDeselect={false} />
        <Select label="Проект" placeholder="без проекта" clearable data={(people.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} />
        <TextInput label="Стиль ответа" placeholder={from("outputStyle", "обычный")} value={style} onChange={(e) => setStyle(e.currentTarget.value)} />
      </SimpleGrid>
      <Group gap="lg">
        <Switch label="Размышлять перед ответом" checked={thinking} onChange={(e) => setThinking(e.currentTarget.checked)} />
        <Switch label="Быстрый режим" checked={fast} onChange={(e) => setFast(e.currentTarget.checked)} />
        <Switch label="С ведомым" checked={pair} onChange={(e) => setPair(e.currentTarget.checked)} />
        <Switch label="Сохранять точки в архив" checked={backup} onChange={(e) => setBackup(e.currentTarget.checked)} />
        <Switch label="Номер к имени" checked={number} onChange={(e) => setNumber(e.currentTarget.checked)} />
      </Group>
      {noAccount && <Text size="sm" c="red" role="alert">На машине {machine} нет очереди аккаунтов и ключа флота: войдите в аккаунт во «Флоте».</Text>}
      <Group justify="space-between">
        <Text size="sm" className="mono muted">{finalName}{number ? "-N" : ""}@{machine}</Text>
        <Button loading={busy} disabled={!machine || !cwd || noAccount} onClick={start}>{missing ? "Создать папку и открыть" : resume ? "Продолжить разговор" : prompt.trim() ? "Открыть и отправить" : "Открыть сессию"}</Button>
      </Group>
    </Stack>
  );
}

/** Адрес страницы «Новая сессия» с машиной или проектом, откуда пришли. */
export const newPath = (preset?: { machine?: string; project?: string } | null): string => {
  const q = new URLSearchParams(Object.entries(preset ?? {}).filter(([, v]) => v) as [string, string][]).toString();
  return "/new" + (q ? "?" + q : "");
};

export function NewSession() {
  return <RoutePage title="Новая сессия"><NewForm /></RoutePage>;
}
