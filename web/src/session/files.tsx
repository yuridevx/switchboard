// Файлы в ленте: то, что сессия отправила человеку (file_send), сайт, который она подняла (site_publish), и то, что человек загрузил сессии.
// В разговоре — имя, хэш и размер; содержимое страница берёт из хранилища по хэшу. Одно место на вид показа и на лист «целиком».
import { ActionIcon } from "@mantine/core";
import { CallError } from "@sb/protocol";
import { IconArrowsMaximize, IconDownload, IconFile } from "@tabler/icons-react";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { download, type FileRef, useBytes } from "../lib/files.ts";
import { bytesWord } from "../lib/time.ts";
import { sayWord } from "../lib/words.ts";
import { Page } from "../shell/Page.tsx";
import { extOf, HtmlFrame, IMAGE_TYPES, showKind } from "./html.tsx";

const Mermaid = lazy(() => import("./Mermaid.tsx"));

/** Чем показать текст Markdown: даёт лента. */
export type Md = (text: string) => ReactNode;

/** Вид показа файла — по его имени: правило одно на всю ленту. */
const kindOf = (name: string) => showKind(extOf(name));

/** Картинка из байтов: свой адрес страницы на время показа. */
function Picture({ name, bytes, full }: { name: string; bytes: ArrayBuffer; full?: boolean }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[extOf(name).toLowerCase()] })), [bytes, name]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className={full ? "filepic" : "pic"} src={url} alt="" />;
}

/** Файл по виду. full — целой страницей: картинка в свой размер, рамка HTML во всю высоту. */
function Body({ name, bytes, md, full }: { name: string; bytes: ArrayBuffer; md: Md; full?: boolean }) {
  const kind = kindOf(name);
  if (kind === "image") return <Picture name={name} bytes={bytes} full={full} />;
  const text = new TextDecoder().decode(bytes);
  if (kind === "html") return <div className={full ? "fileframe full" : "fileframe"}><HtmlFrame html={text} title={name} /></div>;
  if (kind === "mermaid") return <Suspense><Mermaid code={text} /></Suspense>;
  if (kind === "markdown") return <>{md(text)}</>;
  return <pre className="filetext">{text}</pre>;
}

/** Лист «целиком»: одна страница на любой показ — файл, сайт, картинку ленты, схему. */
export function Sheet({ title, opened, onClose, children }: { title: ReactNode; opened: boolean; onClose: () => void; children: ReactNode }) {
  return <Page name="file" wide opened={opened} onClose={onClose} title={title}>{children}</Page>;
}

/** Вызов инструмента глазами ленты: ввод и ответ. */
export type Call = { input?: Record<string, unknown>; result?: { text: string; error?: boolean } };
function answer<T>(call: Call): T | null {
  if (!call.result || call.result.error) return null;
  try { return JSON.parse(call.result.text) as T; } catch { return null; }
}
/** Отказ словом: ответ инструмента начинается со слова отказа; отказ запроса несёт слово сам. */
const refusal = (e: unknown): string => (e instanceof CallError ? sayWord(e.word) : typeof e === "string" ? sayWord(/^[a-z_]+/.exec(e)?.[0]) || e : "Ошибка");

const Save = ({ file }: { file: FileRef }) => (
  <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Скачать ${file.name}`} onClick={() => void download(file)}><IconDownload size={15} /></ActionIcon>
);

/** Содержимое из хранилища под строкой файла: показ по виду и лист «целиком» с тем же содержимым — второго запроса нет. */
function Stored({ file, title, md }: { file: FileRef; title: string; md: Md }) {
  const q = useBytes(file.hash);
  const [open, setOpen] = useState(false);
  if (q.error) return <div className="filefail">{refusal(q.error)}</div>;
  if (!q.data) return <div className="filewait" aria-busy="true" />;
  const whole = <Sheet title={title} opened={open} onClose={() => setOpen(false)}><Body name={file.name} bytes={q.data} md={md} full /></Sheet>;
  if (kindOf(file.name) === "image") {
    return <><button type="button" className="picbtn fill" aria-label={`Открыть целиком: ${title}`} onClick={() => setOpen(true)}><Body name={file.name} bytes={q.data} md={md} /></button>{whole}</>;
  }
  return (
    <>
      <ActionIcon className="filemax" variant="subtle" color="gray" size="sm" aria-label={`Открыть целиком: ${title}`} onClick={() => setOpen(true)}><IconArrowsMaximize size={15} /></ActionIcon>
      <Body name={file.name} bytes={q.data} md={md} />
      {whole}
    </>
  );
}

/** Файл, отправленный сессией: подпись, имя, размер и «скачать» строкой; под ней — сам файл, если его вид показывается. */
export function Sent({ call, md }: { call: Call; md: Md }) {
  const path = String(call.input?.path ?? "");
  const title = typeof call.input?.title === "string" ? call.input.title : "";
  const file = answer<FileRef>(call);
  const seen = file && kindOf(file.name) !== null;
  return (
    <div className={`codeblock fileshow${seen ? " seen" : ""}`} data-file={path}>
      <div className="codebar">
        {title && <span className="filetitle">{title}</span>}
        <span className="muted mono trunc">{path}</span>
        {file && <span className="muted filesize">{bytesWord(file.size)}</span>}
        {file && <Save file={file} />}
      </div>
      {call.result?.error ? <div className="filefail">{refusal(call.result.text)}</div> : file && seen ? <Stored file={file} title={title || file.name} md={md} /> : null}
    </div>
  );
}

/** Сайт, поднятый сессией: подпись и адрес строкой; под ней — сам сайт в рамке. Адрес открывается в новой вкладке. */
export function Site({ call }: { call: Call }) {
  const dir = String(call.input?.dir ?? "");
  const title = typeof call.input?.title === "string" ? call.input.title : "";
  const site = answer<{ url: string; files: number; size: number }>(call);
  const [open, setOpen] = useState(false);
  const frame = (full: boolean) => site && <div className={full ? "fileframe full" : "fileframe"}><iframe className="htmlframe" title={title || dir} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerPolicy="no-referrer" src={site.url} /></div>;
  return (
    <div className="codeblock fileshow seen" data-site={dir}>
      <div className="codebar">
        {title && <span className="filetitle">{title}</span>}
        {site ? <a className="mono trunc" href={site.url} target="_blank" rel="noreferrer noopener">{site.url.replace(/^https?:\/\//, "")}</a> : <span className="muted mono trunc">{dir}</span>}
        {site && <span className="muted filesize">{site.files} · {bytesWord(site.size)}</span>}
      </div>
      {call.result?.error ? <div className="filefail">{refusal(call.result.text)}</div> : site && (
        <>
          <ActionIcon className="filemax" variant="subtle" color="gray" size="sm" aria-label={`Открыть целиком: ${title || dir}`} onClick={() => setOpen(true)}><IconArrowsMaximize size={15} /></ActionIcon>
          {frame(false)}
          <Sheet title={title || dir} opened={open} onClose={() => setOpen(false)}>{frame(true)}</Sheet>
        </>
      )}
    </div>
  );
}

/** Файл, который человек загрузил сессии: картинка — превью с листом «целиком», остальное — имя, размер и «скачать». */
export function Attachment({ file, md }: { file: { name: string; hash?: string; size?: number }; md: Md }) {
  const stored = file.hash && file.size !== undefined ? (file as FileRef) : null;
  if (stored && kindOf(file.name) === "image") return <div className="me-pic" data-file={file.name}><Stored file={stored} title={file.name} md={md} /></div>;
  return (
    <div className="me-file" data-file={file.name}>
      <IconFile size={13} /> <span className="trunc">{file.name}</span>
      {stored && <span className="filesize">{bytesWord(stored.size)}</span>}
      {stored && <Save file={stored} />}
    </div>
  );
}
