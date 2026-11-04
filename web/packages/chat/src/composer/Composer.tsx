// Ввод: поле растёт по тексту; Enter — отправить, Shift+Enter — строка; в занятую сессию сообщение встаёт в очередь; «Прервать», пока Claude работает.
// «/» — команды, «@» — файлы папки; вложения — скрепкой, вставкой и перетаскиванием; подсказка Claude — над полем, Tab подставляет.
// Текст — состояние этого компонента (курсор при наборе не прыгает); в хранилище уходит черновик, отказ отправки возвращает текст и вложения.
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, AtSign, FileText, Lightbulb, Paperclip, Slash, Square, X } from "lucide-react";
import { useApp } from "@switchboard/web-ui";
import { useChat, useConv } from "../context.ts";
import type { Attachment } from "../state/chat.ts";
import { toAttachment } from "./attach.ts";
import { ModeSelect } from "./ModeSelect.tsx";
import { useSuggest, type Suggest } from "./useSuggest.ts";

/** «/btw вопрос»: вопрос сбоку, а не сообщение. */
const SIDE = /^\/btw\s+([\s\S]+)/;

function SuggestList({ s, pick }: { s: Suggest; pick(insert: string): void }) {
  return (
    <div className="chat-sug" role="listbox" data-kind={s.kind}>
      {s.items.map((x, i) => (
        <button key={x.key} type="button" className="chat-sugi" role="option" aria-selected={i === s.sel} onClick={() => pick(x.insert)}>
          {s.kind === "file" ? <FileText size={13} /> : null}
          <b>{x.label}</b>
          {x.hint ? <span>{x.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

function Chips({ list, drop }: { list: Attachment[]; drop(a: Attachment): void }) {
  if (!list.length) return null;
  return (
    <div className="chat-files">
      {list.map((a, i) => (
        <span key={i} className="chat-file">
          {a.media_type.startsWith("image/") ? <img src={`data:${a.media_type};base64,${a.data}`} alt="" /> : <FileText size={13} />}
          {a.name}
          <button type="button" aria-label={`убрать ${a.name}`} onClick={() => drop(a)}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function Composer({ callsign }: { callsign: string }) {
  const app = useApp();
  const chat = useChat();
  const inp = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => chat.draft(callsign));
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);

  const name = app.use(() => chat.nameOf(callsign));
  const busy = app.use(() => chat.inTurn(callsign));
  const canFiles = app.use(() => chat.can(callsign, "session.files"));
  const canCall = app.use(() => chat.canCall(callsign));
  const suggestion = useConv(callsign, (c) => c.feed.suggestion);
  const mode = app.use(() => chat.sessionOf(callsign)?.mode as string | undefined);
  const returned = useConv(callsign, (c) => c.returned);
  const suggest = useSuggest(callsign, text);

  // отказ отправки: что вернулось в поле, решил стор, — черновик; вложения возвращаются к набранным
  const [returnedSeen, setReturnedSeen] = useState(returned);
  if (returned !== returnedSeen) {
    setReturnedSeen(returned);
    if (returned) {
      setText(chat.draft(callsign));
      setPending([...pending, ...returned.attachments]);
    }
  }

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
    if (side) {
      chat.setDraft(callsign, "");
      void chat.askSide(callsign, side[1].trim());
      setText("");
      return;
    }
    chat.send(callsign, value, pending);
    setPending([]);
    setText("");
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
    if (e.key === "Tab" && !text && suggestion) {
      e.preventDefault();
      return change(suggestion);
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

  const place = busy ? `В очередь ${name}` : `Написать ${name}`;
  return (
    <div className="chat-under">
      {suggestion && !text ? (
        <button type="button" className="chat-hint" onClick={() => pick(suggestion)}>
          <Lightbulb size={13} />
          <span>{suggestion}</span>
          <kbd>Tab</kbd>
        </button>
      ) : null}
      {suggest ? <SuggestList s={suggest} pick={pick} /> : null}
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
        <Chips list={pending} drop={(a) => setPending((p) => p.filter((x) => x !== a))} />
        <textarea
          ref={inp}
          className="chat-inp"
          rows={1}
          placeholder={place}
          aria-label={`Написать ${name}`}
          value={text}
          onInput={(e) => change(e.currentTarget.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div className="chat-tools">
          <button type="button" className="chat-tb" aria-label="Вложить файл" title="Вложить файл" onClick={() => picker.current!.click()}>
            <Paperclip size={16} />
          </button>
          {canFiles ? (
            <button
              type="button"
              className="chat-tb"
              aria-label="Файл папки"
              title="Файл папки"
              onClick={() => {
                change(text + (text && !text.endsWith(" ") ? " @" : "@"));
                inp.current!.focus();
              }}
            >
              <AtSign size={16} />
            </button>
          ) : null}
          {canCall ? (
            <button type="button" className="chat-tb" aria-label="Команда" title="Команда" onClick={() => pick("/")}>
              <Slash size={16} />
            </button>
          ) : null}
          {canCall && mode ? <ModeSelect callsign={callsign} mode={mode} /> : null}
          <span className="chat-grow" />
          {busy && canCall ? (
            <button type="button" className="chat-stop" onClick={() => void chat.call(callsign, "interrupt")}>
              <Square size={11} />
              Прервать
            </button>
          ) : null}
          <button className="chat-send" aria-label="Отправить" type="submit" disabled={!text.trim() && !pending.length}>
            <ArrowUp size={18} />
          </button>
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
