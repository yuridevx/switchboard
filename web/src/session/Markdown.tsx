// Markdown ответа модели: отдельный кусок сборки, грузится при первом тексте.
// Таблицы и сноски; сырой HTML — через очистку; блок кода — с копированием; HTML — с просмотром в песочнице, SVG — картинкой; ссылки открываются в новой вкладке.
import { CopyButton } from "@mantine/core";
import { isValidElement, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { fenceHtml, HtmlFrame, previewKind, SvgView, textOf } from "./html.tsx";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

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
  const kind = previewKind(lang, code);
  const [view, setView] = useState(false);
  return (
    <div className="codeblock">
      <div className="codebar">
        <span className="muted mono">{lang}</span>
        {kind && <button type="button" className="linkbtn" aria-pressed={view} onClick={() => setView((v) => !v)}>{view ? "Код" : "Просмотр"}</button>}
        <CopyButton value={code}>{({ copied, copy }) => <button type="button" className="linkbtn" onClick={copy}>{copied ? "Скопировано" : "Копировать"}</button>}</CopyButton>
      </div>
      {view && kind === "svg" ? <SvgView code={code} /> : view ? <HtmlFrame html={code} /> : <pre>{children}</pre>}
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={REHYPE}
        remarkRehypeOptions={NO_PREFIX}
        urlTransform={(url) => url}
        components={{
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
        }}
      >
        {fenceHtml(text)}
      </ReactMarkdown>
    </div>
  );
}
