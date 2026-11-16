// Ввод в сессию: многострочный, вложения (кнопкой, из буфера, перетаскиванием), «/» команды, «@» файлы, «/btw» — вопрос сбоку, «/model» — выбор модели.
// Черновик живёт на каждую сессию. Пока идёт ход, кнопок отправки две: «следующим» (после нынешнего шага) и «сейчас» (прервёт ход); «Прервать» — здесь же.
import { notifications } from "@mantine/notifications";
import { upload } from "../lib/files.ts";
import { sayError } from "../api.ts";
import { sessionCall, sessionFiles, type SessionRow } from "@sb/protocol";
import { ActionIcon, FileButton, Group, Paper, Textarea, Tooltip } from "@mantine/core";
import { IconArrowUp, IconBolt, IconPaperclip, IconPlayerStop, IconX } from "@tabler/icons-react";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";
import { act } from "../api.ts";
import { useCall } from "../common.tsx";
import { draft, type FileOut, type Priority, type Talk } from "./talk.ts";

type Pick = { label: string; about?: string; insert: string };
export type ComposerHandle = { setText(text: string): void; /** вернуть текст в поле, не затирая набранное */ giveBack(text: string): void; addFiles(files: File[]): void; focus(): void };

/** Команды самой страницы рядом с командами Claude. */
const OWN: Pick[] = [{ label: "/btw", about: "спросить сбоку, мимо разговора", insert: "/btw " }, { label: "/model", about: "выбрать модель: слова поиска", insert: "/model " }];

/** Команды «/» из списка SDK: имя со слешем, подсказка аргументов, отбор по началу. Список SDK — массив; у старых версий — в поле commands. */
export function commandPicks(list: unknown, typed: string): Pick[] {
  const raw = (Array.isArray(list) ? list : ((list as { commands?: unknown[] } | null)?.commands ?? [])) as Array<{ name?: string; description?: string; about?: string; argumentHint?: string }>;
  const all = [...raw.map((c) => ({ label: "/" + String(c.name ?? "").replace(/^\//, ""), about: [c.argumentHint, c.description ?? c.about].filter(Boolean).join(" · ") || undefined })).map((c) => ({ ...c, insert: c.label + " " })), ...OWN];
  // своя команда страницы закрывает одноимённую команду Claude: «/model» ставит модель документом сессии
  const own = new Set(OWN.map((c) => c.label));
  return all.filter((c, i) => c.label.startsWith("/" + typed) && (i >= raw.length || !own.has(c.label))).slice(0, 12);
}

/** Вопрос сбоку: «/btw текст» — текст вопроса; иначе null. */
export const sideQuestion = (text: string): string | null => /^\/btw\s+(\S[\s\S]*)$/.exec(text.trim())?.[1] ?? null;

/** «/model слова»: слова поиска модели (пустая строка — список целиком); иначе null. Команда в разговор не уходит: модель ставит документ сессии. */
export const modelAsk = (text: string): string | null => { const m = /^\/model(?:\s+(.*))?$/.exec(text.trim()); return m ? (m[1] ?? "").trim() : null; };

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

export const Composer = forwardRef<ComposerHandle, { s: SessionRow; talk: Talk; hint?: string; autoFocus?: boolean; /** ряд под полем: значения документа сессии слева, действия над разговором значками справа */ values?: ReactNode; acts?: ReactNode; /** «/model слова»: открыть список моделей с этим поиском */ onModel?: (q: string) => void }>(function Composer({ s, talk, hint, autoFocus, values, acts, onModel }, handle) {
  const [text, setTextRaw] = useState(() => draft.get(s.callsign));
  const [files, setFiles] = useState<File[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** идёт ход: сообщение можно отправить следующим или сейчас */
  const turn = s.state === "busy" || s.state === "starting";
  const dead = s.state === "stopped" || s.state === "failed" || s.state === "stopping";
  const slash = /^\/(\S*)$/.exec(text);
  const commands = useCall(sessionCall, slash && !dead ? { to: s.callsign, method: "commands" } : null);
  /** «@слово» в конце — файлы папки сессии; чтение идёт общим входом с кэшем: отказ виден в полосе наверху */
  const file = slash ? null : /(?:^|\s)@(\S*)$/.exec(text);
  const found = useCall(sessionFiles, file && !dead ? { to: s.callsign, q: file[1]! } : null);
  const setText = (t: string) => (setTextRaw(t), draft.set(s.callsign, t));

  useImperativeHandle(handle, () => ({
    setText: (t) => (setText(t), ref.current?.focus()),
    giveBack: (t) => (setText(returned(draft.get(s.callsign), t)), ref.current?.focus()),
    addFiles: (list) => setFiles((x) => [...x, ...list]),
    focus: () => ref.current?.focus(),
  }));

  // «/» в начале — команды сессии; «@слово» в конце — файлы её папки
  useEffect(() => {
    if (slash) setPicks(commandPicks(commands.data, slash[1]));
    else if (file && !dead) {
      // пока список для новых букв не пришёл, стоит прежний: подсказки не мигают при наборе
      if (found.data) setPicks(found.data.files.slice(0, 8).map((p) => ({ label: p, insert: text.slice(0, text.length - file[1]!.length) + p + " " })));
    } else setPicks([]);
    setAt(0);
  }, [text, s.callsign, commands.data, found.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (priority: Priority = "next") => {
    const body = text.trim();
    if (!body && !files.length) return;
    const q = sideQuestion(body);
    const model = modelAsk(body);
    setText("");
    if (q) return talk.aside(q);
    if (model !== null) return onModel?.(model);
    let attached: FileOut[];
    try {
      attached = await Promise.all(files.map(upload));
    } catch (e) {
      // файл не загрузился: сообщение не уходит, текст и файлы остаются в поле
      setText(body);
      return void notifications.show({ color: "red", message: `Файл не загружен: ${sayError(e)}` });
    }
    setFiles([]);
    void talk.send(body, attached.length ? attached : undefined, turn ? priority : undefined);
  };
  const choose = (p: Pick) => {
    setText(p.insert);
    setPicks([]);
    ref.current?.focus();
  };
  const empty = !text.trim() && !files.length;

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
          placeholder={dead ? "Сессия не работает" : "Сообщение сессии"} aria-label="Сообщение сессии"
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
        {turn && <Tooltip label="Прервать ход"><ActionIcon size="lg" variant="default" aria-label="Прервать ход" onClick={() => act(sessionCall, { to: s.callsign, method: "interrupt" })}><IconPlayerStop size={17} /></ActionIcon></Tooltip>}
        {/* пока идёт ход, срочностей две и обе — кнопками: молния — сейчас, стрелка — следующим */}
        {turn && <Tooltip label="Сейчас: прервёт ход"><ActionIcon size="lg" variant="default" aria-label="Отправить сейчас" disabled={empty} onClick={() => void send("now")}><IconBolt size={17} /></ActionIcon></Tooltip>}
        <Tooltip label={turn ? "Следующим: после нынешнего шага" : "Отправить"}><ActionIcon size="lg" variant="filled" aria-label={turn ? "Отправить следующим" : "Отправить"} disabled={dead || empty} onClick={() => void send()}><IconArrowUp size={18} /></ActionIcon></Tooltip>
      </Group>
      {/* ряд под полем есть всегда: у стоящей сессии документ правится так же — модель той, что не запустилась, меняют здесь */}
      <div className="composer-opts">
        {values}
        {acts}
      </div>
    </div>
  );
});
