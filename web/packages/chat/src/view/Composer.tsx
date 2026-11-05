// Ввод: текст, вложения, подсказки «/» и «@», режим разрешений, «Прервать». Поле живёт в сторе разговора: черновик переживает экран.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Area, Btn, IconBtn, isLive, PERM_MODES, RowBtn, Sel, sessionOf, useApp, useModule, type ModelInfo } from "@switchboard/web-ui";
import { ArrowUp, AtSign, Lightbulb, Paperclip, SquareSlash } from "lucide-react";
import type { Att, Talks } from "../talk.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";

const LIMIT = 20;
const BTW = { name: "btw", description: "Вопрос сбоку, в разговор не попадёт" };
type Item = { label: string; hint?: string };

async function attOf(f: File): Promise<Att> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { name: f.name, media_type: f.type || "application/octet-stream", data: btoa(bin) };
}

/** Можно ли предложить «Авто»: модель сессии из ленты, иначе модель по умолчанию из списка SDK. */
function autoOk(models: ModelInfo[] | "loading" | undefined, model: string | undefined): boolean {
  if (!Array.isArray(models)) return false;
  const m = model ? models.find((x) => model.includes(x.value)) : models.find((x) => x.value === "default");
  return !!m?.supportsAutoMode;
}

export function Composer() {
  const env = useEnv();
  const app = useApp();
  const talks = useModule<Talks>();
  const cs = env.cs;
  const draft = app.use(() => talks.get(cs).draft);
  const files = app.use(() => talks.get(cs).files);
  const commands = app.use(() => talks.get(cs).commands);
  const models = app.use(() => talks.get(cs).models);
  const s = app.use(() => {
    const x = sessionOf(app, cs);
    return { state: x?.state as string | undefined, mode: (x as { mode?: string } | undefined)?.mode };
  });
  const live = isLive(s.state);
  const call = app.use(() => app.can(cs.slice(cs.lastIndexOf("@") + 1), "session.call") === true);
  const inp = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [closed, setClosed] = useState(false);
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] } | null>(null);
  const asked = useRef(0);

  const set = (text: string) => {
    setClosed(false);
    talks.edit(cs, (t) => void (t.draft = text));
  };
  const add = async (list: FileList | File[] | null | undefined) => {
    const atts = await Promise.all([...(list ?? [])].map(attOf));
    if (atts.length) talks.edit(cs, (t) => void t.files.push(...atts));
  };

  const cmd = /^\/(\S*)$/.exec(draft);
  const at = /(?:^|\s)@(\S*)$/.exec(draft);
  useEffect(() => {
    if (cmd && call) void talks.commands(cs);
  }, [!!cmd, call]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!at) return;
    const n = ++asked.current;
    void app.read<string[]>("session.files", { callsign: cs, query: at[1], limit: LIMIT }).then((r) => n === asked.current && setFound(r.ok ? { query: at[1], paths: r.result } : null));
  }, [at?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (live && s.mode) void talks.models(cs);
  }, [live, !!s.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = inp.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft]);

  const items: Item[] = closed
    ? []
    : cmd && call
      ? [...(Array.isArray(commands) ? commands : []), BTW].filter((c) => c.name.startsWith(cmd[1])).slice(0, LIMIT).map((c) => ({ label: `/${c.name}`, hint: c.description }))
      : at && found
        ? found.paths.map((p) => ({ label: p }))
        : [];
  const cur = Math.min(sel, Math.max(items.length - 1, 0));
  useEffect(() => setSel(0), [items.length, cmd?.[1], at?.[1]]);

  const choose = (it: Item) => {
    set(cmd ? `${it.label} ` : draft.replace(/@\S*$/, `@${it.label} `));
    inp.current?.focus();
  };
  const submit = () => {
    const text = draft.trim();
    if (!text && !files.length) return;
    const btw = /^\/btw\s+([\s\S]+)$/.exec(text);
    if (btw && !files.length && call) return void talks.side(cs, btw[1].trim());
    talks.send(cs, text, files);
  };
  const hint = !draft ? env.view.hint : undefined;
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((cur + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Escape" && items.length) setClosed(true);
    else if (e.key === "Tab" && (items.length || hint)) {
      e.preventDefault();
      if (items.length) choose(items[cur]);
      else set(hint!);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (items.length && items[cur].label !== draft.trim()) choose(items[cur]);
      else submit();
    }
  };
  const paste = (e: ClipboardEvent) => {
    if (!e.clipboardData?.files?.length) return;
    e.preventDefault();
    void add(e.clipboardData.files);
  };
  const dropped = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void add(e.dataTransfer?.files);
  };
  const modes = PERM_MODES.filter(([m]) => m !== "auto" || autoOk(models, env.view.model));
  if (s.mode && !modes.some(([m]) => m === s.mode)) modes.push([s.mode, s.mode]);

  return (
    <div className="chat-under">
      {hint && (
        <Btn className="chat-hint" onClick={() => set(hint)}>
          <Lightbulb size={13} aria-hidden="true" />
          <span>{hint}</span>
          <kbd>Tab</kbd>
        </Btn>
      )}
      {items.length > 0 && (
        <div className="chat-sug" role="listbox" data-kind={cmd ? "cmd" : "file"}>
          {items.map((it, i) => (
            <RowBtn key={it.label} className="chat-sugi" role="option" aria-selected={i === cur} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(it)}>
              {!cmd && <Icon name="file-text" size={13} />}
              <b>{it.label}</b>
              {it.hint && <span>{it.hint}</span>}
            </RowBtn>
          ))}
        </div>
      )}
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
        onDrop={dropped}
      >
        {files.length > 0 && (
          <div className="chat-files">
            {files.map((f, i) => (
              <span key={i} className="chat-file">
                {f.media_type.startsWith("image/") ? <img src={`data:${f.media_type};base64,${f.data}`} alt="" /> : <Icon name="file-text" size={13} />}
                {f.name}
                <IconBtn aria-label={`убрать ${f.name}`} onClick={() => talks.edit(cs, (t) => void t.files.splice(i, 1))}>
                  <Icon name="x" size={12} />
                </IconBtn>
              </span>
            ))}
          </div>
        )}
        <Area ref={inp} className="chat-inp" rows={1} aria-label="Написать сообщение" placeholder="Сообщение" value={draft} onInput={(e) => set(e.currentTarget.value)} onKeyDown={key} onPaste={paste} />
        <div className="chat-tools">
          <IconBtn className="chat-tb" title="Вложить файл" aria-label="Вложить файл" onClick={() => pick.current?.click()}>
            <Paperclip size={16} aria-hidden="true" />
          </IconBtn>
          <IconBtn
            className="chat-tb"
            title="Файл папки"
            aria-label="Файл папки"
            onClick={() => {
              set(!draft ? "@" : /\s$/.test(draft) ? `${draft}@` : `${draft} @`);
              inp.current?.focus();
            }}
          >
            <AtSign size={16} aria-hidden="true" />
          </IconBtn>
          {live && call && (
            <IconBtn
              className="chat-tb"
              title="Команда"
              aria-label="Команда"
              onClick={() => {
                set("/");
                inp.current?.focus();
              }}
            >
              <SquareSlash size={16} aria-hidden="true" />
            </IconBtn>
          )}
          {live && s.mode && (
            <Sel className="chat-mode" title="Режим разрешений" aria-label="Режим разрешений" data-mode={s.mode} value={s.mode} onChange={(e) => env.act("setPermissionMode", [e.target.value])}>
              {modes.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </Sel>
          )}
          <span className="chat-grow" />
          {(s.state === "busy" || s.state === "waiting") && (
            <Btn bad className="chat-stop" onClick={() => env.act("interrupt", [])}>
              <Icon name="square" />
              Прервать
            </Btn>
          )}
          <IconBtn className="chat-send" type="submit" aria-label="Отправить" disabled={!draft.trim() && !files.length}>
            <ArrowUp size={17} aria-hidden="true" />
          </IconBtn>
        </div>
        <input
          ref={pick}
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
