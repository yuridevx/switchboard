// Ввод: текст, вложения, подсказки «/» и «@», режим разрешений, «Прервать». Поле живёт в сторе разговора: черновик переживает экран, буква ввода страницу не будит.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Area, Btn, IconBtn, isLive, PERM_MODES, permModeName, RowBtn, Sel, sessionOf, useApp, useModule } from "@switchboard/web-ui";
import type { Att, Talks } from "../talk.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";

const SIDE = "/btw";
const SIDE_ABOUT = "Вопрос сбоку, в разговор не попадёт";
const LIST_MAX = 20;
type Item = { value: string; about?: string; file?: boolean };

async function attOf(f: File): Promise<Att> {
  let raw = "";
  for (const b of new Uint8Array(await f.arrayBuffer())) raw += String.fromCharCode(b);
  return { name: f.name, media_type: f.type || "application/octet-stream", data: btoa(raw) };
}

function ModeSelect() {
  const { cs, view, act } = useEnv();
  const app = useApp();
  const talks = useModule<Talks>();
  const mode = app.use(() => sessionOf(app, cs)?.mode as string | undefined);
  const live = app.use(() => isLive(sessionOf(app, cs)?.state));
  const models = app.use(() => talks.get(cs).models);
  useEffect(() => {
    if (mode !== undefined && live) void talks.models(cs);
  }, [mode !== undefined, live, cs]); // eslint-disable-line react-hooks/exhaustive-deps
  if (mode === undefined || !live) return null;
  // модель сессии в списке SDK; не нашлась — запись по умолчанию
  const list = Array.isArray(models) ? models : [];
  const found = list.find((m) => m.value !== "default" && view.model?.includes(m.value)) ?? list.find((m) => m.value === "default");
  const modes = PERM_MODES.filter(([value]) => value !== "auto" || found?.supportsAutoMode || mode === "auto");
  return (
    <Sel className="chat-mode" title="Режим разрешений" aria-label="Режим разрешений" data-mode={mode} value={mode} onChange={(e) => act("setPermissionMode", [e.currentTarget.value])}>
      {modes.some(([value]) => value === mode) ? null : <option value={mode}>{permModeName(mode) ?? mode}</option>}
      {modes.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </Sel>
  );
}

export function Composer() {
  const env = useEnv();
  const app = useApp();
  const talks = useModule<Talks>();
  const { cs } = env;
  // чужая правка поля будит ввод выборкой, своя буква — redraw
  app.use(() => talks.get(cs).draft);
  const text = talks.get(cs).draft;
  const [, redraw] = useState(0);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  const files = app.use(() => talks.get(cs).files);
  const commands = app.use(() => talks.get(cs).commands);
  const busy = app.use(() => ["busy", "waiting"].includes(String(sessionOf(app, cs)?.state)));
  const canFiles = app.use(() => talks.can(cs, "session.files"));
  const hint = env.view.hint;

  const put = (value: string, at: number | null = null) => {
    talks.typed(cs, value);
    setCaret(at);
    setSelected(0);
    redraw((n) => n + 1);
  };

  useLayoutEffect(() => {
    const el = field.current!;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  // подсказка — по тексту до каретки
  const before = text.slice(0, caret ?? text.length);
  const on = dismissed !== text;
  const cq = env.canAct && on ? /^\/(\S*)$/.exec(before)?.[1] : undefined;
  const fq = canFiles && on ? /(?:^|\s)@(\S*)$/.exec(before)?.[1] : undefined;

  useEffect(() => {
    if (cq !== undefined) void talks.commands(cs);
  }, [cq !== undefined, commands === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  // команды — один запрос на разговор; файлы — на каждый набор, поздний ответ на старый запрос отброшен
  useEffect(() => {
    if (fq === undefined) return setFound([]);
    const turn = ++asked.current;
    void app.read<string[]>("session.files", { callsign: cs, query: fq, limit: LIST_MAX }).then((r) => {
      if (turn === asked.current) setFound(r.ok ? r.result : []);
    });
  }, [fq]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: Item[] =
    cq !== undefined
      ? [...(Array.isArray(commands) ? commands : []).map((c) => ({ value: `/${c.name}`, about: c.description })), { value: SIDE, about: SIDE_ABOUT }].filter((c) => c.value.slice(1).startsWith(cq.toLowerCase())).slice(0, LIST_MAX)
      : fq !== undefined
        ? found.map((path) => ({ value: path, file: true }))
        : [];
  const cur = Math.min(selected, Math.max(0, items.length - 1));

  function accept(item: Item) {
    if (item.file) {
      const start = before.lastIndexOf("@") + 1;
      put(`${text.slice(0, start)}${item.value} ${text.slice(before.length)}`);
    } else put(`${item.value} `);
    field.current?.focus();
  }

  function submit() {
    const body = text.trim();
    if (!body && !files.length) return;
    if (env.canAct && !files.length && body.startsWith(`${SIDE} `)) void talks.side(cs, body.slice(SIDE.length).trim());
    else talks.send(cs, body, files);
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
    const read = await Promise.all([...(list ?? [])].map(attOf));
    if (read.length) talks.edit(cs, (t) => void t.files.push(...read));
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

  return (
    <div className="chat-under">
      {!text && hint ? (
        <Btn type="button" className="chat-hint" onClick={() => put(hint)}>
          <Icon name="lightbulb" />
          <span>{hint}</span>
          <kbd>Tab</kbd>
        </Btn>
      ) : null}
      {items.length ? (
        <div className="chat-sug" data-kind={cq !== undefined ? "cmd" : "file"} role="listbox">
          {items.map((item, i) => (
            <RowBtn key={item.value} role="option" className="chat-sugi" aria-selected={i === cur} onClick={() => accept(item)}>
              {item.file ? <Icon name="file-text" /> : null}
              <b>{item.value}</b>
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
                {f.media_type.startsWith("image/") ? <img src={`data:${f.media_type};base64,${f.data}`} alt="" /> : <Icon name="file-text" />}
                {f.name}
                <IconBtn aria-label={`убрать ${f.name}`} onClick={() => talks.edit(cs, (t) => void t.files.splice(i, 1))}>
                  <Icon name="x" size={12} />
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
          aria-label={`Написать ${env.label}`}
          placeholder={busy ? `В очередь ${env.label}` : `Написать ${env.label}`}
          onInput={(e) => {
            const el = e.currentTarget;
            put(el.value, el.selectionStart ?? el.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div className="chat-tools">
          <IconBtn className="chat-tb" aria-label="Вложить файл" title="Вложить файл" onClick={() => picker.current?.click()}>
            <Icon name="paperclip" size={16} />
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
              <Icon name="at-sign" size={16} />
            </IconBtn>
          ) : null}
          {env.canAct ? (
            <IconBtn
              className="chat-tb"
              aria-label="Команда"
              title="Команда"
              onClick={() => {
                put("/");
                field.current?.focus();
              }}
            >
              <Icon name="slash" size={16} />
            </IconBtn>
          ) : null}
          <ModeSelect />
          <span className="chat-grow" />
          {busy && env.canAct ? (
            <Btn type="button" bad className="chat-stop" onClick={() => env.act("interrupt", [])}>
              <Icon name="square" />
              Прервать
            </Btn>
          ) : null}
          <IconBtn type="submit" className="chat-send" aria-label="Отправить" disabled={!text.trim() && !files.length}>
            <Icon name="arrow-up" size={18} />
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
