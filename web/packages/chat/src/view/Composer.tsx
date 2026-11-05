// Ввод: текст, вложения, подсказки «/» и «@», режим разрешений. Текст и вложения — состояние этого компонента: буква ввода не трогает стор.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, AtSign, FileText, Lightbulb, Paperclip, Slash, Square, X } from "lucide-react";
import { Area, Btn, IconBtn, isLive, PERM_MODES, permModeName, RowBtn, Sel, sessionLabel, sessionOf, useApp, useModule } from "@switchboard/web-ui";
import type { Attachment, Chats } from "../store.ts";

const SIDE = "/btw";
const SIDE_ABOUT = "Вопрос сбоку, в разговор не попадёт";
const LIST_MAX = 20;

type Item = { value: string; label: string; about?: string; file?: boolean };

async function readFile(f: File): Promise<Attachment> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return { name: f.name, media_type: f.type || "application/octet-stream", data: btoa(raw) };
}

/** Что подсказывать по тексту до каретки. */
const commandQuery = (text: string) => /^\/(\S*)$/.exec(text)?.[1];
const fileQuery = (text: string) => /(?:^|\s)@(\S*)$/.exec(text)?.[1];

function ModeSelect({ callsign }: { callsign: string }) {
  const app = useApp();
  const chats = useModule<Chats>();
  const mode = app.use(() => sessionOf(app, callsign)?.mode as string | undefined);
  const live = app.use(() => isLive(sessionOf(app, callsign)?.state));
  const models = app.use(() => chats.conv(callsign).models);
  const model = app.use(() => chats.conv(callsign).view.model ?? "");
  useEffect(() => {
    if (mode !== undefined && live) void chats.loadModels(callsign);
  }, [mode !== undefined, live, callsign]); // eslint-disable-line react-hooks/exhaustive-deps
  if (mode === undefined || !live) return null;
  // модель сессии в списке SDK; не нашлась — запись по умолчанию
  const found = models?.find((m) => m.value !== "default" && model.includes(m.value)) ?? models?.find((m) => m.value === "default");
  const list = PERM_MODES.filter(([value]) => value !== "auto" || found?.supportsAutoMode || mode === "auto");
  return (
    <Sel
      className="chat-mode"
      aria-label="Режим разрешений"
      title="Режим разрешений"
      data-mode={mode}
      value={mode}
      onChange={(e) => void chats.act(callsign, "setPermissionMode", [e.currentTarget.value])}
    >
      {list.some(([value]) => value === mode) ? null : <option value={mode}>{permModeName(mode) ?? mode}</option>}
      {list.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </Sel>
  );
}

export function Composer({ callsign }: { callsign: string }) {
  const app = useApp();
  const chats = useModule<Chats>();
  const [text, setText] = useState(() => chats.draft(callsign));
  const [files, setFiles] = useState<Attachment[]>([]);
  const [caret, setCaret] = useState(text.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textNow = useRef(text);
  const asked = useRef(0);

  const canAct = app.use(() => chats.canAct(callsign));
  const canFiles = app.use(() => chats.can(callsign, "session.files"));
  const busy = app.use(() => ["busy", "waiting"].includes(String(sessionOf(app, callsign)?.state)));
  const commands = app.use(() => chats.conv(callsign).commands);
  const hint = app.use(() => chats.conv(callsign).view.suggestion);
  const name = app.use(() => sessionLabel(app, callsign).text);

  const put = (value: string) => {
    textNow.current = value;
    setText(value);
    setCaret(value.length);
    setSelected(0);
    chats.setDraft(callsign, value);
  };

  useEffect(() => {
    chats.bindComposer(callsign, {
      text: () => textNow.current,
      put(value, more) {
        put(value);
        setFiles((have) => [...have, ...more]);
      },
    });
    return () => chats.bindComposer(callsign, null);
  }, [callsign]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = field.current!;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const before = text.slice(0, caret);
  const cq = canAct && dismissed !== text ? commandQuery(before) : undefined;
  const fq = canFiles && dismissed !== text ? fileQuery(before) : undefined;

  // команды — один запрос на разговор; файлы — на каждый набор, поздний ответ на старый запрос отброшен
  useEffect(() => {
    if (cq !== undefined) void chats.loadCommands(callsign);
  }, [cq !== undefined, commands === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fq === undefined) return setFound([]);
    const turn = ++asked.current;
    void app.read<string[]>("session.files", { callsign, query: fq, limit: LIST_MAX }).then((r) => {
      if (turn === asked.current) setFound(r.ok ? r.result : []);
    });
  }, [fq]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: Item[] =
    cq !== undefined
      ? [...(commands ?? []).map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, about: c.description })), { value: SIDE, label: SIDE, about: SIDE_ABOUT }].filter((c) => c.value.slice(1).startsWith(cq.toLowerCase())).slice(0, LIST_MAX)
      : fq !== undefined
        ? found.map((path) => ({ value: path, label: path, file: true }))
        : [];
  const cur = Math.min(selected, Math.max(0, items.length - 1));

  function accept(item: Item) {
    if (item.file) {
      const start = before.lastIndexOf("@") + 1;
      put(`${text.slice(0, start)}${item.value} ${text.slice(caret)}`);
    } else put(`${item.value} `);
    field.current?.focus();
  }

  function submit() {
    const body = text.trim();
    if (!body && !files.length) return;
    if (canAct && !files.length && body.startsWith(`${SIDE} `)) void chats.side(callsign, body.slice(SIDE.length).trim());
    else chats.send(callsign, body, files);
    put("");
    setFiles([]);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setSelected((cur + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      }
      if (e.key === "Escape") return setDismissed(text);
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && items[cur].value !== text)) {
        e.preventDefault();
        return accept(items[cur]);
      }
    }
    if (e.key === "Tab" && !text && hint) {
      e.preventDefault();
      return put(hint);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const add = async (list: FileList | File[] | null | undefined) => {
    const read = await Promise.all([...(list ?? [])].map(readFile));
    if (read.length) setFiles((have) => [...have, ...read]);
  };

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!e.clipboardData?.files?.length) return;
    e.preventDefault();
    void add(e.clipboardData.files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    void add(e.dataTransfer?.files);
  }

  const canSend = !!text.trim() || files.length > 0;
  return (
    <div className="chat-under">
      {!text && hint ? (
        <Btn type="button" className="chat-hint" onClick={() => put(hint)}>
          <Lightbulb size={13} />
          <span>{hint}</span>
          <kbd>Tab</kbd>
        </Btn>
      ) : null}
      {items.length ? (
        <div className="chat-sug" data-kind={cq !== undefined ? "cmd" : "file"} role="listbox">
          {items.map((item, i) => (
            <RowBtn key={item.value} role="option" className="chat-sugi" aria-selected={i === cur} onClick={() => accept(item)}>
              {item.file ? <FileText size={13} /> : null}
              <b>{item.label}</b>
              {item.about ? <span>{item.about}</span> : null}
            </RowBtn>
          ))}
        </div>
      ) : null}
      <form
        className={drag ? "chat-comp drag" : "chat-comp"}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        {files.length ? (
          <div className="chat-files">
            {files.map((f, i) => (
              <span key={`${i}:${f.name}`} className="chat-file">
                {f.media_type.startsWith("image/") ? <img src={`data:${f.media_type};base64,${f.data}`} alt="" /> : <FileText size={13} />}
                {f.name}
                <IconBtn aria-label={`убрать ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X size={12} />
                </IconBtn>
              </span>
            ))}
          </div>
        ) : null}
        <Area
          ref={field}
          className="chat-inp"
          rows={1}
          value={text}
          aria-label={`Написать ${name}`}
          placeholder={busy ? `В очередь ${name}` : `Написать ${name}`}
          onInput={(e) => {
            const el = e.currentTarget;
            textNow.current = el.value;
            setText(el.value);
            setCaret(el.selectionStart ?? el.value.length);
            setSelected(0);
            chats.setDraft(callsign, el.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div className="chat-tools">
          <IconBtn className="chat-tb" aria-label="Вложить файл" title="Вложить файл" onClick={() => picker.current?.click()}>
            <Paperclip size={16} />
          </IconBtn>
          {canFiles ? (
            <IconBtn
              className="chat-tb"
              aria-label="Файл папки"
              title="Файл папки"
              onClick={() => {
                put(`${text}${text && !/\s$/.test(text) ? " " : ""}@`);
                field.current?.focus();
              }}
            >
              <AtSign size={16} />
            </IconBtn>
          ) : null}
          {canAct ? (
            <IconBtn
              className="chat-tb"
              aria-label="Команда"
              title="Команда"
              onClick={() => {
                put("/");
                field.current?.focus();
              }}
            >
              <Slash size={16} />
            </IconBtn>
          ) : null}
          <ModeSelect callsign={callsign} />
          <span className="chat-grow" />
          {busy && canAct ? (
            <Btn type="button" bad className="chat-stop" onClick={() => void chats.act(callsign, "interrupt")}>
              <Square size={11} />
              Прервать
            </Btn>
          ) : null}
          <IconBtn type="submit" className="chat-send" aria-label="Отправить" disabled={!canSend}>
            <ArrowUp size={18} />
          </IconBtn>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void add(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
      </form>
    </div>
  );
}
