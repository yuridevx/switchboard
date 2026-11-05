// Текст Claude: разметка markdown и разрешённый HTML. Всё, что страница не разрешила, снимает санитайзер; адреса — правила страницы ниже.
import { memo, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock, textOfNode } from "./CodeBlock.tsx";

const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "abbr", "cite", "figure", "figcaption", "picture", "source"],
  attributes: { ...defaultSchema.attributes, code: [["className", /^language-[\w+#-]+$/]], abbr: ["title"], source: ["srcSet", "media", "type"] },
  protocols: { ...defaultSchema.protocols, src: ["http", "https", "data"] },
};
const REHYPE = [rehypeRaw, [rehypeSanitize, SCHEMA]] as ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
const REMARK = [remarkGfm];
/** Сноски получают приставку от санитайзера, как и всякий id; адрес сноски он не трогает: приставку ему ставит ссылка. */
const REHYPE_OPTIONS = { clobberPrefix: "" };
const PREFIX = "user-content-";

/** Адрес ссылки без адресов этой страницы с # и без приглашений: чужой текст не меняет экран и не даёт войти. */
function safeHref(href: string | undefined): string | undefined {
  const at = href?.indexOf("#") ?? -1;
  if (!href || at < 0) return href;
  if (decodeHash(href.slice(at + 1)).startsWith("invite=")) return undefined;
  return URL.canParse(href, location.href) && new URL(href, location.href).origin === location.origin ? undefined : href;
}

const decodeHash = (hash: string) => {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
};

/** Сноска ведёт внутри своего текста: адрес страницы не меняется. */
function toFootnote(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  e.currentTarget.closest(".md")?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
}

const COMPONENTS: Components = {
  a({ node: _node, href, children, ...p }) {
    const props = p as Record<string, unknown>;
    if (href?.startsWith("#") && ("data-footnote-ref" in props || "data-footnote-backref" in props)) {
      const id = PREFIX + href.slice(1);
      return (
        <a {...p} href={`#${id}`} onClick={(e) => toFootnote(e, id)}>
          {children}
        </a>
      );
    }
    return (
      <a {...p} href={safeHref(href)} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ node: _node, src, ...p }) {
    const allowed = typeof src === "string" && (!/^data:/i.test(src) || /^data:image\//i.test(src));
    return <img {...p} src={allowed ? src : undefined} loading="lazy" referrerPolicy="no-referrer" />;
  },
  table({ node: _node, ...p }) {
    return (
      <div className="md-table">
        <table {...p} />
      </div>
    );
  },
  pre({ node, children }) {
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
    if (!code) {
      return (
        <div className="cb">
          <pre>{children as ReactNode}</pre>
        </div>
      );
    }
    const classes = code.type === "element" ? ((code.properties.className ?? []) as string[]) : [];
    const lang = classes.map((c) => /^language-(.+)$/.exec(c)?.[1]).find(Boolean) ?? "";
    return <CodeBlock code={textOfNode(code).replace(/\n$/, "")} lang={lang} />;
  },
};

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  return (
    <div className={live ? "md caret" : "md"}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} remarkRehypeOptions={REHYPE_OPTIONS} components={COMPONENTS} urlTransform={(url) => url}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
