// Ввод в сессию: многострочный, вложения (кнопкой, из буфера, перетаскиванием), «/» команды, «@» файлы, «/btw» — вопрос сбоку.
// Черновик живёт на каждую сессию. Пока сессия занята — сообщение встаёт в очередь с выбранной срочностью; «Прервать» — здесь же.
import { sessionCall, sessionFiles, type SessionRow } from "@sb/protocol";
import { ActionIcon, Button, FileButton, Group, Menu, Paper, Textarea, Tooltip } from "@mantine/core";
import { IconArrowUp, IconPaperclip, IconPlayerStop, IconX } from "@tabler/icons-react";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";
import { act, api } from "../api.ts";
import { useCall } from "../common.tsx";
import { draft, type FileOut, type Priority, type Talk } from "./talk.ts";

type Pick = { label: string; about?: string; insert: string };
export type ComposerHandle = { setText(text: string): void; /** вернуть текст в поле, не затирая набранное */ giveBack(text: string): void; addFiles(files: File[]): void; focus(): void };

const PRIORITY: Array<[Priority, string, string]> = [["next", "следующим", "после нынешнего шага"], ["now", "сейчас", "прервёт ход"], ["later", "потом", "после конца хода"]];
/** Команды самой страницы рядом с командами Claude. */
const OWN: Pick[] = [{ label: "/btw", about: "спросить сбоку, мимо разговора", insert: "/btw " }];

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Команды «/» из списка SDK: имя со слешем, подсказка аргументов, отбор по началу. Список SDK — массив; у старых версий — в поле commands. */
export function commandPicks(list: unknown, typed: string): Pick[] {
  const raw = (Array.isArray(list) ? list : ((list as { commands?: unknown[] } | null)?.commands ?? [])) as Array<{ name?: string; description?: string; about?: string; argumentHint?: string }>;
  const all = [...raw.map((c) => ({ label: "/" + String(c.name ?? "").replace(/^\//, ""), about: [c.argumentHint, c.description ?? c.about].filter(Boolean).join(" · ") || undefined })).map((c) => ({ ...c, insert: c.label + " " })), ...OWN];
  return all.filter((c) => c.label.startsWith("/" + typed)).slice(0, 12);
}

/** Вопрос сбоку: «/btw текст» — текст вопроса; иначе null. */
export const sideQuestion = (text: string): string | null => /^\/btw\s+(\S[\s\S]*)$/.exec(text.trim())?.[1] ?? null;

/** Вложение до отправки: картинка — превью, остальное — имя; крестик убирает. */
function Attached({ file, onDrop }: { file: File; onDrop(): void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <span className="att">
      {src && <img src={src} alt={file.name} />}
      <span className="trunc">{file.name}</span>
      <button type="button" className="x" aria-label={`Убрать ${file.name}`} onClick={onDrop}><IconX size={13} /></button>
    </span>
  );
}

/** Текст, вернувшийся в поле ввода (отменённое сообщение из очереди): к набранному добавляется с новой строки. */
export const returned = (typed: string, text: string): string => (typed.trim() ? `${typed.replace(/\s+$/, "")}\n${text}` : text);

export const Composer = forwardRef<ComposerHandle, { s: SessionRow; talk: Talk; hint?: string; autoFocus?: boolean; /** ряд под полем: значения документа сессии слева, действия над разговором значками справа */ values?: ReactNode; acts?: ReactNode }>(function Composer({ s, talk, hint, autoFocus, values, acts }, handle) {
  const [text, setTextRaw] = useState(() => draft.get(s.callsign));
  const [files, setFiles] = useState<File[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [at, setAt] = useState(0);
  const [priority, setPriority] = useState<Priority>("next");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = s.state === "busy" || s.state === "starting" || s.state === "waiting";
  const dead = s.state === "stopped" || s.state === "failed" || s.state === "stopping";
  const slash = /^\/(\S*)$/.exec(text);
  const commands = useCall(sessionCall, slash && !dead ? { to: s.callsign, method: "commands" } : null);
  const setText = (t: string) => (setTextRaw(t), draft.set(s.callsign, t));

  useImperativeHandle(handle, () => ({
    setText: (t) => (setText(t), ref.current?.focus()),
    giveBack: (t) => (setText(returned(draft.get(s.callsign), t)), ref.current?.focus()),
    addFiles: (list) => setFiles((x) => [...x, ...list]),
    focus: () => ref.current?.focus(),
  }));

  // «/» в начале — команды сессии; «@слово» в конце — файлы её папки
  useEffect(() => {
    let alive = true;
    const file = /(?:^|\s)@(\S*)$/.exec(text);
    if (slash) setPicks(commandPicks(commands.data, slash[1]));
    else if (file && !dead) api.call(sessionFiles, { to: s.callsign, q: file[1] }).then((r) => alive && setPicks(r.files.slice(0, 8).map((p) => ({ label: p, insert: text.slice(0, text.length - file[1].length) + p + " " }))), () => {});
    else setPicks([]);
    setAt(0);
    return () => void (alive = false);
  }, [text, s.callsign, commands.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const body = text.trim();
    if (!body && !files.length) return;
    const q = sideQuestion(body);
    setText("");
    if (q) return talk.aside(q);
    const attached: FileOut[] = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || "application/octet-stream", base64: await toBase64(f) })));
    setFiles([]);
    setPriority("next");
    void talk.send(body, attached.length ? attached : undefined, busy ? priority : undefined);
  };
  const choose = (p: Pick) => {
    setText(p.insert);
    setPicks([]);
    ref.current?.focus();
  };
  const word = PRIORITY.find(([p]) => p === priority)![1];

  return (
    <div style={{ position: "relative" }}>
      {picks.length > 0 && (
        <Paper withBorder shadow="sm" p={4} style={{ position: "absolute", bottom: "100%", left: 0, right: 0, marginBottom: 6, zIndex: 5, maxHeight: 280, overflowY: "auto" }} role="listbox">
          {picks.map((p, i) => (
            <div key={p.label} role="option" aria-selected={i === at} className={`row${i === at ? " sel" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr)", padding: "5px 10px" }} onMouseDown={(e) => (e.preventDefault(), choose(p))}>
              <span className="trunc"><span className="mono">{p.label}</span>{p.about && <span className="muted"> — {p.about}</span>}</span>
            </div>
          ))}
        </Paper>
      )}
      {hint && !text && !dead && <button type="button" className="hint trunc" title="Tab — взять подсказку" onClick={() => (setText(hint), ref.current?.focus())}>{hint}</button>}
      {files.length > 0 && (
        <div className="attach" style={hint && !text ? { marginTop: 6 } : undefined}>
          {files.map((f, i) => <Attached key={i} file={f} onDrop={() => setFiles((l) => l.filter((_, j) => j !== i))} />)}
        </div>
      )}
      <Group gap={8} align="end" wrap="nowrap" mt={hint && !text && !files.length ? 6 : 0}>
        <FileButton multiple onChange={(l) => setFiles((x) => [...x, ...l])}>
          {(props) => <Tooltip label="Приложить файл"><ActionIcon {...props} variant="subtle" size="lg" aria-label="Приложить файл" disabled={dead}><IconPaperclip size={18} /></ActionIcon></Tooltip>}
        </FileButton>
        <Textarea
          ref={ref} id={"composer-" + s.callsign} autosize minRows={1} maxRows={10} style={{ flex: 1 }} autoFocus={autoFocus} disabled={dead}
          placeholder={dead ? "Сессия не работает" : busy ? "Сообщение встанет в очередь" : "Сообщение сессии"} aria-label="Сообщение сессии"
          value={text} onChange={(e) => setText(e.currentTarget.value)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) (e.preventDefault(), setFiles((x) => [...x, ...pasted]));
          }}
          onKeyDown={(e) => {
            if (picks.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) (e.preventDefault(), setAt((i) => (i + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length));
            else if (picks.length && (e.key === "Enter" || e.key === "Tab")) (e.preventDefault(), choose(picks[at]!));
            else if (e.key === "Tab" && !text && hint) (e.preventDefault(), setText(hint));
            else if (e.key === "Escape") setPicks([]);
            else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), void send());
          }}
        />
        {busy && s.state !== "waiting" && <Button className="wide-only" variant="default" leftSection={<IconPlayerStop size={15} />} onClick={() => act(sessionCall, { to: s.callsign, method: "interrupt" })}>Прервать</Button>}
        {busy && s.state !== "waiting" && <Tooltip label="Прервать ход"><ActionIcon className="narrow-only" size="lg" variant="default" aria-label="Прервать ход" onClick={() => act(sessionCall, { to: s.callsign, method: "interrupt" })}><IconPlayerStop size={17} /></ActionIcon></Tooltip>}
        <ActionIcon size="lg" variant="filled" aria-label={busy ? "В очередь" : "Отправить"} disabled={dead || (!text.trim() && !files.length)} onClick={send}><IconArrowUp size={18} /></ActionIcon>
      </Group>
      {/* ряд под полем есть всегда: у стоящей сессии в нём остаются инспектор и «ещё» */}
      {(
        <div className="composer-opts">
          {!dead && values}
          {/* когда взять сообщение — выбор есть, только пока идёт ход */}
          {!dead && (s.state === "busy" || s.state === "starting") && (
            <Menu position="top-start" withinPortal>
              <Menu.Target><button type="button" className="docval take" aria-label="Когда взять сообщение" title="Когда взять сообщение">взять {word}</button></Menu.Target>
              <Menu.Dropdown>{PRIORITY.map(([pr, w, about]) => <Menu.Item key={pr} fw={pr === priority ? 700 : undefined} onClick={() => setPriority(pr)}>{w} — {about}</Menu.Item>)}</Menu.Dropdown>
            </Menu>
          )}
          {acts}
        </div>
      )}
    </div>
  );
});
