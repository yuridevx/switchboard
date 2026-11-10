// Поднять сессию из архива: на машине, копией, переносом живой сессии или откатом на месте. Один диалог, четыре вида.
import { accountList, pointsRaise, sessionStop, type ArchSession, type InputOf, type OutputOf } from "@sb/protocol";
import { Button, Group, SegmentedControl, Select, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { api, sayError } from "../../api.ts";
import { useCall, useMachineName } from "../../common.tsx";
import { nFiles } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";

export type RaiseKind = "raise" | "copy" | "move" | "rollback";
type Check = NonNullable<OutputOf<typeof pointsRaise>["check"]>;
export type Step = { word: string; state: "wait" | "run" | "done" | "failed"; why?: string };

export const RAISE_TITLE: Record<RaiseKind, string> = { raise: "Поднять на машине", copy: "Копия сессии", move: "Перенести на машину", rollback: "Откатить к точке" };

/** Проверка папки словами: что станет с файлами при подъёме. */
export function checkWord(c: Check, files: "keep" | "point"): { word: string; bad: boolean } {
  const keep = files === "keep" ? " Файлы папки не трогаются, встанет только разговор." : "";
  switch (c.folder) {
    case "nogit": return { word: `${c.dir}: точка без git — файлы папки не трогаются, встанет только разговор.`, bad: false };
    case "empty": return { word: `${c.dir}: папки нет — будет клон репозитория${c.branch ? ` на ветке ${c.branch}` : ""}.${keep}`, bad: false };
    case "same": return { word: `${c.dir}: тот же репозиторий без правок${files === "point" && c.branch ? ` — встанет ветка точки ${c.branch}` : ""}.${keep}`, bad: false };
    case "dirty": return { word: `${c.dir}: в папке несохранённые правки (${nFiles(c.files)}) — её файлы останутся как есть.`, bad: false };
    case "shared": return { word: `${c.dir}: в папке работают ${c.sessions.join(", ")} — её файлы останутся как есть.`, bad: false };
    default: return { word: `${c.dir}: другой репозиторий — сюда поднять нельзя, выберите другую папку.`, bad: true };
  }
}

/** Ввод points.raise по виду действия. Перенос живой сессии идёт без точки: прежняя машина снимает свежую. */
export function raiseInput(kind: RaiseKind, s: ArchSession, f: { machine: string; name: string; cwd: string; account: string; files: "keep" | "point"; point?: string }): InputOf<typeof pointsRaise> {
  const base = { to: "@" + f.machine, sid: s.sid, files: f.files, ...(f.cwd && f.cwd !== s.cwd ? { cwd: f.cwd } : {}), ...(f.account && f.account !== "auto" ? { account: f.account } : {}) };
  if (kind === "rollback") return { to: "@" + s.machine, sid: s.sid, files: f.files, ...(f.point ? { point: f.point } : {}) };
  if (kind === "move") return { ...base, move: true };
  if (kind === "copy") return { ...base, name: f.name, ...(f.point ? { point: f.point } : {}) };
  return { ...base, move: true, ...(f.name && f.name !== s.callsign.split("@")[0] ? { name: f.name } : {}), ...(f.point ? { point: f.point } : {}) };
}

/** Шаги хода — что произойдёт по порядку. */
export function stepsOf(kind: RaiseKind, s: ArchSession, machine: string, liveRunning: boolean): string[] {
  if (kind === "rollback") return [...(liveRunning ? [`Остановить ${s.callsign}`] : []), "Вернуть разговор и папку к точке", `Запустить ${s.callsign} с точки`];
  if (kind === "move") return [`${s.machine}: снять свежую точку и остановить сессию`, `${machine}: забрать блоки, подготовить папку`, `${machine}: продолжить разговор; ${s.machine}: убрать сессию`];
  return [`${machine}: забрать блоки, подготовить папку`, kind === "copy" ? "Открыть новую сессию от точки" : "Продолжить разговор на этой машине"];
}

export function Raise({ kind, s, point, onDone, onClose }: { kind: RaiseKind; s: ArchSession; point?: string; onDone: (callsign: string) => void; onClose: () => void }) {
  const machines = useFleet((f) => f.machines);
  const live = useFleet((f) => f.sessions[s.callsign]);
  const nameOf = useMachineName();
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  // перенос — на другую машину; откат — на своей
  const targets = kind === "move" ? online.filter((m) => m !== s.machine) : online;
  const base = s.callsign.split("@")[0]!;
  const [machine, setMachine] = useState<string | null>(kind === "rollback" ? s.machine : targets.includes(s.machine) && kind !== "move" ? s.machine : targets[0] ?? null);
  const [name, setName] = useState(kind === "copy" ? base + "-copy" : base);
  const [cwd, setCwd] = useState(s.cwd ?? "");
  const [account, setAccount] = useState("auto");
  const [files, setFiles] = useState<"keep" | "point">("point");
  const [check, setCheck] = useState<Check | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [why, setWhy] = useState("");
  const accounts = useCall(accountList, machine && kind !== "rollback" ? { to: "@" + machine } : null);
  const form = { machine: machine ?? "", name, cwd, account, files, point };
  const running = !!live && live.state !== "stopped" && live.state !== "failed";
  const probe = async () => {
    setWhy("");
    try {
      const r = await api.call(pointsRaise, { ...raiseInput(kind === "move" ? "raise" : kind, s, form), dryRun: true });
      setCheck(r.check ?? null);
    } catch (e) {
      setCheck(null);
      setWhy(sayError(e));
    }
  };
  const run = async () => {
    if (!machine) return;
    const words = stepsOf(kind, s, machine, running);
    const at = (i: number, failed?: string): Step[] => words.map((word, j) => ({ word, state: j < i ? "done" : j === i ? (failed ? "failed" : "run") : "wait", ...(j === i && failed ? { why: failed } : {}) }));
    let i = 0;
    setSteps(at(0));
    try {
      if (kind === "rollback" && running) {
        await api.call(sessionStop, { to: s.callsign });
        setSteps(at(++i));
      }
      const r = await api.call(pointsRaise, raiseInput(kind, s, form));
      setSteps(words.map((word) => ({ word, state: "done" })));
      if (r.callsign) onDone(r.callsign);
    } catch (e) {
      setSteps(at(i, sayError(e)));
    }
  };
  const said = check ? checkWord(check, files) : null;
  const badName = kind !== "rollback" && kind !== "move" && !/^[a-z0-9][a-z0-9_-]*$/i.test(name);
  if (steps) return (
    <Stack gap="sm">
      <div className="steps" role="status" aria-label="Ход">
        {steps.map((st, i) => (
          <div key={i} className="step"><span className={`lamp ${st.state === "done" ? "idle" : st.state === "run" ? "busy" : st.state === "failed" ? "failed" : "off"}`} /><span style={{ minWidth: 0 }}>{st.word}{st.why && <Text size="sm" c="red">{st.why}</Text>}</span></div>
        ))}
      </div>
      {steps.some((st) => st.state === "failed") && <Group><Button variant="default" onClick={() => setSteps(null)}>Назад</Button><Button variant="subtle" onClick={onClose}>Закрыть</Button></Group>}
    </Stack>
  );
  return (
    <Stack gap="sm">
      {kind === "rollback"
        ? <Text size="sm"><span className="mono">{s.callsign}</span> вернётся к точке: разговор после неё останется только в архиве.{running ? " Идущий ответ будет прерван, сессия остановлена и запущена с точки." : ""}</Text>
        : <Select label="Машина" data={targets.map((m) => ({ value: m, label: nameOf(m) + (m === s.machine ? " · здесь была" : "") }))} value={machine} onChange={(m) => (setMachine(m), setCheck(null))} allowDeselect={false} error={!targets.length ? "Других машин на связи нет" : undefined} />}
      {(kind === "copy" || kind === "raise") && <TextInput label="Имя сессии" className="mono" value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} error={badName ? "латиница, цифры, дефис" : undefined} />}
      {kind !== "rollback" && <TextInput label="Папка" className="mono" value={cwd} onChange={(e) => (setCwd(e.currentTarget.value), setCheck(null))} />}
      {kind !== "rollback" && <Select label="Аккаунт" data={[{ value: "auto", label: "авто — по очереди машины" }, ...(accounts.data?.accounts ?? []).filter((a) => a.ok).map((a) => ({ value: a.id, label: a.email ?? a.id }))]} value={account} onChange={(v) => setAccount(v ?? "auto")} allowDeselect={false} />}
      <SegmentedControl value={files} onChange={(v) => (setFiles(v as "keep" | "point"), setCheck(null))} data={[{ value: "point", label: "Файлы папки — как в точке" }, { value: "keep", label: "Файлы не трогать" }]} aria-label="Что делать с файлами папки" />
      {said && <Text size="sm" c={said.bad ? "red" : undefined}>{said.word}</Text>}
      {why && <Text size="sm" c="red">{why}</Text>}
      {kind === "move" && <Text size="sm">Разговор продолжится на новой машине; если она не поднимет сессию, прежняя запустит её снова.</Text>}
      <Group>
        <Button disabled={!machine || badName || !!said?.bad} onClick={() => void run()}>{kind === "rollback" ? "Откатить" : kind === "copy" ? "Сделать копию" : kind === "move" ? "Перенести" : "Поднять"}</Button>
        <Button variant="default" disabled={!machine} onClick={() => void probe()}>Проверить папку</Button>
      </Group>
    </Stack>
  );
}

/** Удаление сессии архива — только после ввода её имени. */
export function DeleteTyped({ name, body, onDelete }: { name: string; body: string; onDelete: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <Stack gap="sm">
      <Text size="sm">{body}</Text>
      <TextInput label={<>Введите имя сессии: <span className="mono">{name}</span></>} className="mono" value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoFocus />
      <Button color="red" disabled={typed.trim() !== name} onClick={onDelete}>Удалить из архива</Button>
    </Stack>
  );
}
