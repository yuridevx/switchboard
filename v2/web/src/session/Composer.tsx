// Ввод в сессию: многострочный, вложения, «/» команды, «@» файлы; пока сессия занята — в очередь; «Прервать».
import { message, sessionCall, sessionFiles, type SessionRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, FileButton, Group, Paper, Textarea, Tooltip } from "@mantine/core";
import { IconArrowUp, IconPaperclip, IconPlayerStop, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { act, api } from "../api.ts";

type Pick = { label: string; about?: string; insert: string };

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function Composer({ s, autoFocus, say, unsay, bind }: {
  s: SessionRow; autoFocus?: boolean;
  /** своё сообщение — в ленту сразу; отказ отправки убирает его; bind связывает его с номером сообщения в очереди сессии */
  say?: (text: string, queued: boolean) => string; unsay?: (id: string) => void; bind?: (local: string, uuid: string) => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [at, setAt] = useState(0);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = s.state === "busy" || s.state === "starting";
  const dead = s.state === "stopped" || s.state === "failed" || s.state === "stopping";

  // «/» в начале — команды сессии; «@слово» в конце — файлы её папки
  useEffect(() => {
    let alive = true;
    const slash = /^\/(\S*)$/.exec(text);
    const file = /(?:^|\s)@(\S*)$/.exec(text);
    if (slash) {
      api.call(sessionCall, { to: s.callsign, method: "commands" }).then((r: any) => alive && setPicks(((r?.commands ?? []) as Array<{ name: string; about?: string }>).filter((c) => c.name.startsWith("/" + slash[1])).map((c) => ({ label: c.name, about: c.about, insert: c.name + " " }))), () => {});
    } else if (file) {
      api.call(sessionFiles, { to: s.callsign, q: file[1] }).then((r) => alive && setPicks(r.files.slice(0, 8).map((p) => ({ label: p, insert: text.slice(0, text.length - file[1].length) + p + " " }))), () => {});
    } else setPicks([]);
    setAt(0);
    return () => void (alive = false);
  }, [text, s.callsign]);

  const send = async () => {
    const body = text.trim();
    if ((!body && !files.length) || sending) return;
    setSending(true);
    const attached = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || "application/octet-stream", base64: await toBase64(f) })));
    const shown = body ? say?.(body, busy) : undefined;
    setText("");
    const r = await act(message, { to: s.callsign, text: body, ...(attached.length ? { files: attached } : {}) });
    setSending(false);
    if (r) {
      setFiles([]);
      const uuid = (r as { uuid?: string }).uuid;
      if (shown && uuid) bind?.(shown, uuid);
    } else {
      // не ушло: текст возвращается в поле, показанное заранее — из ленты
      if (shown) unsay?.(shown);
      setText(body);
    }
  };
  const choose = (p: Pick) => {
    setText(p.insert);
    setPicks([]);
    ref.current?.focus();
  };

  return (
    <div style={{ position: "relative" }}>
      {picks.length > 0 && (
        <Paper withBorder shadow="sm" p={4} style={{ position: "absolute", bottom: "100%", left: 0, right: 0, marginBottom: 6, zIndex: 5 }} role="listbox">
          {picks.map((p, i) => (
            <div key={p.label} role="option" aria-selected={i === at} className={`row${i === at ? " sel" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr)", padding: "5px 10px" }} onMouseDown={(e) => (e.preventDefault(), choose(p))}>
              <span className="trunc"><span className="mono">{p.label}</span>{p.about && <span className="muted"> — {p.about}</span>}</span>
            </div>
          ))}
        </Paper>
      )}
      {files.length > 0 && (
        <Group gap={6} mb={6}>
          {files.map((f, i) => <Badge key={i} rightSection={<IconX size={12} style={{ cursor: "pointer" }} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} />}>{f.name}</Badge>)}
        </Group>
      )}
      <Group gap={8} align="end" wrap="nowrap">
        <FileButton multiple onChange={(l) => setFiles((x) => [...x, ...l])}>
          {(props) => <Tooltip label="Приложить файл"><ActionIcon {...props} variant="subtle" size="lg" aria-label="Приложить файл"><IconPaperclip size={18} /></ActionIcon></Tooltip>}
        </FileButton>
        <Textarea
          ref={ref} id={"composer-" + s.callsign} autosize minRows={1} maxRows={10} style={{ flex: 1 }} autoFocus={autoFocus} disabled={dead}
          placeholder={dead ? "Сессия не работает" : busy ? "Сообщение встанет в очередь" : "Сообщение сессии"} aria-label="Сообщение сессии"
          value={text} onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (picks.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) (e.preventDefault(), setAt((i) => (i + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length));
            else if (picks.length && (e.key === "Enter" || e.key === "Tab")) (e.preventDefault(), choose(picks[at]));
            else if (e.key === "Escape") setPicks([]);
            else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), void send());
          }}
        />
        {busy && <Button className="wide-only" variant="default" leftSection={<IconPlayerStop size={15} />} onClick={() => act(sessionCall, { to: s.callsign, method: "interrupt" })}>Прервать</Button>}
        {busy && <Tooltip label="Прервать ход"><ActionIcon className="narrow-only" size="lg" variant="default" aria-label="Прервать ход" onClick={() => act(sessionCall, { to: s.callsign, method: "interrupt" })}><IconPlayerStop size={17} /></ActionIcon></Tooltip>}
        <ActionIcon size="lg" variant="filled" aria-label={busy ? "В очередь" : "Отправить"} loading={sending} disabled={dead || (!text.trim() && !files.length)} onClick={send}><IconArrowUp size={18} /></ActionIcon>
      </Group>
    </div>
  );
}
