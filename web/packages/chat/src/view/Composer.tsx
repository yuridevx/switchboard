// Ввод: поле растёт по тексту; Enter — отправить, Shift+Enter — строка; в занятую сессию сообщение встаёт в очередь; «Прервать», пока Claude работает.
// «/» — команды, «@» — файлы папки; вложения — скрепкой, вставкой и перетаскиванием; подсказка Claude — над полем, Tab подставляет.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, AtSign, FileText, Lightbulb, Paperclip, Slash, Square, X } from "lucide-react";
import { Area, Btn, IconBtn, PERM_MODES, RowBtn, Sel, sessionLabel, sessionOf, useApp, useLoad, useModule } from "@switchboard/web-ui";
import type { ModelInfo } from "@switchboard/web-ui";
import type { Attachment, Chat } from "../state/chat.ts";

/** «/btw вопрос»: вопрос сбоку, а не сообщение. */
const SIDE = /^\/btw\s+([\s\S]+)/;
const AT = /(?:^|\s)@([^\s@]*)$/;
const SLASH = /^\/(\S*)$/;
const MAX = 20;
const AUTO = "auto";
/** Вопрос сбоку — своя команда чата: в списке claude его нет. */
const BTW = { name: "btw", description: "Вопрос сбоку, в разговор не попадёт" };
const NO_FILES = { ok: true as const, result: [] as string[] };

async function toAttachment(f: File): Promise<Attachment> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { name: f.name, media_type: f.type || "application/octet-stream", data: btoa(bin) };
}

type Suggestion = { key: string; label: string; hint?: string; insert: string };
type Suggest = { kind: "cmd" | "file"; items: Suggestion[]; sel: number; move(d: 1 | -1): void; close(): void };

/** Подсказки поля: «/» в начале — команды сессии, «@часть» в конце — файлы её папки. Выбор и закрытие относятся к тексту, при котором сделаны. */
function useSuggest(callsign: string, text: string): Suggest | null {
  const app = useApp();
  const chat = useModule<Chat>();
  const canCall = app.use(() => chat.canCall(callsign));
  const canFiles = app.use(() => chat.can(callsign, "session.files"));
  const slash = canCall ? SLASH.exec(text)?.[1] : undefined;
  const at = canFiles && slash === undefined ? AT.exec(text)?.[1] : undefined;
  const commands = app.use(() => chat.conv(callsign).commands);
  const files = useLoad(() => (at === undefined ? Promise.resolve(NO_FILES) : chat.files(callsign, at)), [chat, callsign, at]);
  const [picked, setPicked] = useState({ text: "", sel: 0 });
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const wantCommands = slash !== undefined;
  useEffect(() => {
    if (wantCommands) void chat.loadCommands(callsign);
  }, [chat, callsign, wantCommands]);
  const kind: Suggest["kind"] = slash !== undefined ? "cmd" : "file";
  const items: Suggestion[] =
    slash !== undefined
      ? [...(commands ?? []), BTW]
          .filter((c) => c.name.startsWith(slash))
          .slice(0, MAX)
          .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.description, insert: `/${c.name} ` }))
      : at !== undefined && !files.error
        ? (files.data ?? []).map((f) => ({ key: f, label: f, insert: text.replace(/@([^\s@]*)$/, `@${f} `) }))
        : [];
  if (!items.length || closedAt === text) return null;
  const sel = Math.min(picked.text === text ? picked.sel : 0, items.length - 1);
  return { kind, items, sel, move: (d) => setPicked({ text, sel: (sel + d + items.length) % items.length }), close: () => setClosedAt(text) };
}

/** Модель сессии в списке SDK: точное имя или короткое внутри полного; нет такой — та, что по умолчанию. */
function modelOf(models: ModelInfo[], model: string | undefined): ModelInfo | undefined {
  return models.find((m) => m.value === model) ?? models.find((m) => model?.includes(m.value)) ?? models.find((m) => m.value === "default");
}

/** Режим разрешений: значение — только из roster, выбор — запрос. */
function ModeSelect({ callsign, mode }: { callsign: string; mode: string }) {
  const app = useApp();
  const chat = useModule<Chat>();
  const model = app.use(() => chat.conv(callsign).view.model);
  const models = app.use(() => chat.conv(callsign).models);
  useEffect(() => void chat.loadModels(callsign), [chat, callsign]);
  const auto = !!modelOf(models ?? [], model)?.supportsAutoMode;
  const known = PERM_MODES.some(([v]) => v === mode);
  return (
    <Sel className="chat-mode" aria-label="Режим разрешений" title="Режим разрешений" data-mode={mode} value={mode} onChange={(e) => void chat.act(callsign, "setPermissionMode", [e.currentTarget.value])}>
      {PERM_MODES.filter(([v]) => v !== AUTO || auto || mode === AUTO).map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
      {known ? null : <option value={mode}>{mode}</option>}
    </Sel>
  );
}

export function Composer({ callsign }: { callsign: string }) {
  const app = useApp();
  const chat = useModule<Chat>();
  const inp = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => chat.draft(callsign));
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const name = app.use(() => sessionLabel(app, callsign).text);
  const state = app.use(() => sessionOf(app, callsign)?.state);
  const canCall = app.use(() => chat.canCall(callsign));
  const canFiles = app.use(() => chat.can(callsign, "session.files"));
  const mode = app.use(() => sessionOf(app, callsign)?.mode as string | undefined);
  const hint = app.use(() => chat.conv(callsign).view.hint);
  const fill = app.use(() => chat.conv(callsign).fill);
  const suggest = useSuggest(callsign, text);
  const busy = state === "busy" || state === "waiting";

  // текст вернул отказ или кнопка ленты: он уже в черновике; вложения — к набранным
  const filled = useRef(fill.n);
  useEffect(() => {
    if (fill.n === filled.current) return;
    filled.current = fill.n;
    setText(chat.draft(callsign));
    if (fill.files.length) setPending((p) => [...p, ...fill.files]);
  }, [fill, chat, callsign]);

  const change = (v: string) => {
    chat.setDraft(callsign, v);
    setText(v);
  };

  // поле растёт по тексту: высота из содержимого, предел — в стилях
  useLayoutEffect(() => {
    const el = inp.current!;
    el.style.height = "auto";
    if (el.scrollHeight) el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  function send() {
    const value = text.trim();
    if (!value && !pending.length) return;
    const side = canCall && !pending.length ? SIDE.exec(value) : null;
    if (side) void chat.side(callsign, side[1].trim());
    else chat.send(callsign, value, pending);
    setPending([]);
    change("");
  }

  function pick(insert: string) {
    change(insert);
    inp.current!.focus();
  }

  async function attach(files: File[]) {
    const added = await Promise.all(files.map(toAttachment));
    setPending((p) => [...p, ...added]);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return suggest.move(e.key === "ArrowDown" ? 1 : -1);
      }
      const cur = suggest.items[suggest.sel];
      // Enter на уже подставленном — отправить, а не подставить заново
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && cur.insert.trim() !== text.trim())) {
        e.preventDefault();
        return pick(cur.insert);
      }
      if (e.key === "Escape") return suggest.close();
    }
    if (e.key === "Tab" && !text && hint) {
      e.preventDefault();
      return change(hint);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    void attach(files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void attach([...e.dataTransfer.files]);
  }

  return (
    <div className="chat-under">
      {hint && !text ? (
        <Btn type="button" className="chat-hint" onClick={() => pick(hint)}>
          <Lightbulb size={13} />
          <span>{hint}</span>
          <kbd>Tab</kbd>
        </Btn>
      ) : null}
      {suggest ? (
        <div className="chat-sug" role="listbox" data-kind={suggest.kind}>
          {suggest.items.map((x, i) => (
            <RowBtn key={x.key} className="chat-sugi" role="option" aria-selected={i === suggest.sel} onClick={() => pick(x.insert)}>
              {suggest.kind === "file" ? <FileText size={13} /> : null}
              <b>{x.label}</b>
              {x.hint ? <span>{x.hint}</span> : null}
            </RowBtn>
          ))}
        </div>
      ) : null}
      <form
        className={dragging ? "chat-comp drag" : "chat-comp"}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {pending.length ? (
          <div className="chat-files">
            {pending.map((a, i) => (
              <span key={i} className="chat-file">
                {a.media_type.startsWith("image/") ? <img src={`data:${a.media_type};base64,${a.data}`} alt="" /> : <FileText size={13} />}
                {a.name}
                <IconBtn aria-label={`убрать ${a.name}`} onClick={() => setPending((p) => p.filter((x) => x !== a))}>
                  <X size={12} />
                </IconBtn>
              </span>
            ))}
          </div>
        ) : null}
        <Area ref={inp} className="chat-inp" rows={1} placeholder={busy ? `В очередь ${name}` : `Написать ${name}`} aria-label={`Написать ${name}`} value={text} onInput={(e) => change(e.currentTarget.value)} onKeyDown={onKey} onPaste={onPaste} />
        <div className="chat-tools">
          <IconBtn className="chat-tb" aria-label="Вложить файл" title="Вложить файл" onClick={() => picker.current!.click()}>
            <Paperclip size={16} />
          </IconBtn>
          {canFiles ? (
            <IconBtn
              className="chat-tb"
              aria-label="Файл папки"
              title="Файл папки"
              onClick={() => {
                change(text + (text && !text.endsWith(" ") ? " @" : "@"));
                inp.current!.focus();
              }}
            >
              <AtSign size={16} />
            </IconBtn>
          ) : null}
          {canCall ? (
            <IconBtn className="chat-tb" aria-label="Команда" title="Команда" onClick={() => pick("/")}>
              <Slash size={16} />
            </IconBtn>
          ) : null}
          {canCall && mode ? <ModeSelect callsign={callsign} mode={mode} /> : null}
          <span className="chat-grow" />
          {busy && canCall ? (
            <Btn bad type="button" className="chat-stop" onClick={() => void chat.act(callsign, "interrupt")}>
              <Square size={11} />
              Прервать
            </Btn>
          ) : null}
          <IconBtn className="chat-send" aria-label="Отправить" type="submit" disabled={!text.trim() && !pending.length}>
            <ArrowUp size={18} />
          </IconBtn>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            void attach(files);
          }}
        />
      </form>
    </div>
  );
}
