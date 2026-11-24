// Markdown ответа модели: отдельный кусок сборки, грузится при первом тексте.
// Таблицы и сноски; сырой HTML — через очистку; блок кода — с копированием; HTML — с просмотром в песочнице, SVG — картинкой; ссылки открываются в новой вкладке.
import { CopyButton } from "@mantine/core";
import { isValidElement, lazy, Suspense, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Sheet } from "./files.tsx";
import { fenceHtml, HtmlFrame, showKind, SvgView, textOf } from "./html.tsx";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const Mermaid = lazy(() => import("./Mermaid.tsx"));

const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "abbr", "cite", "figure", "figcaption", "picture", "source"],
  attributes: { ...defaultSchema.attributes, code: [["className", /^language-[\w+#-]+$/]], abbr: ["title"], source: ["srcSet", "media", "type"] },
  protocols: { ...defaultSchema.protocols, src: ["http", "https", "data"] },
};
// очистка — до подсветки: классы подсветки ставит уже наш код
const REHYPE = [rehypeRaw, [rehypeSanitize, SCHEMA], rehypeHighlight] as ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
/** Сноски без своей приставки: приставку ставит очистка, иначе вышла бы двойная. */
const NO_PREFIX = { clobberPrefix: "" };
const PREFIX = "user-content-";

/** Адрес, который не уводит страницу: приглашение из текста не принимается, ссылка на эту же страницу с # открыла бы её экран. */
export function safeHref(href: string | undefined): string | undefined {
  const at = href?.indexOf("#") ?? -1;
  if (!href || at < 0) return href;
  let hash = href.slice(at + 1);
  try { hash = decodeURIComponent(hash); } catch { /* адрес как есть */ }
  if (hash.startsWith("invite=")) return undefined;
  return URL.canParse(href, location.href) && new URL(href, location.href).origin === location.origin ? undefined : href;
}

function toFootnote(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  e.currentTarget.closest(".md")?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
}

function Code({ lang, code, children }: { lang: string; code: string; children: ReactNode }) {
  // показ блока — тем же правилом, что показ файла: язык блока вместо расширения
  const kind = showKind(lang, code);
  const scheme = kind === "mermaid";
  const shown = kind === "image" || kind === "html" || scheme;
  // схема показывается сразу: её пишут, чтобы на неё смотреть
  const [view, setView] = useState(scheme);
  const [whole, setWhole] = useState(false);
  return (
    <div className="codeblock">
      <div className="codebar">
        <span className="muted mono">{lang}</span>
        {shown && <button type="button" className="linkbtn" aria-pressed={view} onClick={() => setView((v) => !v)}>{view ? "Код" : scheme ? "Схема" : "Просмотр"}</button>}
        <CopyButton value={code}>{({ copied, copy }) => <button type="button" className="linkbtn" onClick={copy}>{copied ? "Скопировано" : "Копировать"}</button>}</CopyButton>
      </div>
      <Sheet opened={whole} onClose={() => setWhole(false)} title="Схема"><Suspense><Mermaid code={code} /></Suspense></Sheet>
      {view && scheme ? <Suspense><Mermaid code={code} onClick={() => setWhole(true)} /></Suspense> : view && kind === "image" ? <SvgView code={code} /> : view && kind === "html" ? <HtmlFrame html={code} /> : <pre>{children}</pre>}
    </div>
  );
}

// одни и те же функции на каждый показ: новая функция — для React новый компонент, и блоки кода со схемами собирались бы заново на каждом куске ответа
const COMPONENTS: ComponentProps<typeof ReactMarkdown>["components"] = {
  a: ({ node: _, href, children, ...rest }) => {
    // сноска и возврат от неё — прокруткой внутри текста: адрес страницы занят экранами
    if (href?.startsWith("#") && ("data-footnote-ref" in rest || "data-footnote-backref" in rest)) {
      const id = PREFIX + href.slice(1);
      return <a {...rest} href={`#${id}`} onClick={(e) => toFootnote(e, id)}>{children}</a>;
    }
    return <a href={safeHref(href)} target="_blank" rel="noreferrer noopener">{children}</a>;
  },
  // data: — только картинка
  img: ({ node: _, src, ...rest }) => <img {...rest} src={typeof src === "string" && (!/^data:/i.test(src) || /^data:image\//i.test(src)) ? src : undefined} loading="lazy" referrerPolicy="no-referrer" />,
  pre: ({ children }) => {
    const el = Array.isArray(children) ? children[0] : children;
    const cls = isValidElement(el) ? String((el.props as { className?: string }).className ?? "") : "";
    return <Code lang={/language-([\w-]+)/.exec(cls)?.[1] ?? ""} code={textOf(children).replace(/\n$/, "")}>{children}</Code>;
  },
};
const asIs = (url: string) => url;

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={REHYPE}
        remarkRehypeOptions={NO_PREFIX}
        urlTransform={asIs}
        components={COMPONENTS}
      >
        {fenceHtml(text)}
      </ReactMarkdown>
    </div>
  );
}
