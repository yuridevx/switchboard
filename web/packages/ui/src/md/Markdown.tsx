// Текст Claude: разметка с таблицами и сносками, сырой HTML через очистку; адрес и пропуск приложения текст не трогает.
import { memo, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.tsx";

const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "abbr", "cite", "figure", "figcaption", "picture", "source"],
  attributes: { ...defaultSchema.attributes, code: [["className", /^language-[\w+#-]+$/]], abbr: ["title"], source: ["srcSet", "media", "type"] },
  protocols: { ...defaultSchema.protocols, src: ["http", "https", "data"] },
};
const REHYPE = [rehypeRaw, [rehypeSanitize, SCHEMA]] as ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
const REMARK = [remarkGfm];
/** Сноски без своей приставки: приставку ставит очистка, иначе вышла бы двойная. */
const NO_PREFIX = { clobberPrefix: "" };
const PREFIX = "user-content-";

function unescaped(hash: string) {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/** Адрес, который не уводит приложение: приглашение из текста не принимается, ссылка на эту страницу с # открыла бы её экран. */
function safeHref(href: string | undefined) {
  const at = href?.indexOf("#") ?? -1;
  if (!href || at < 0) return href;
  if (unescaped(href.slice(at + 1)).startsWith("invite=")) return undefined;
  return URL.canParse(href, location.href) && new URL(href, location.href).origin === location.origin ? undefined : href;
}

function toFootnote(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  e.currentTarget.closest(".md")?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
}

type Tree = { type: string; value?: string; children?: Tree[] };
const textOf = (n: Tree): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

const COMPONENTS: Components = {
  a({ node: _, href, ...rest }) {
    if (href?.startsWith("#") && ("data-footnote-ref" in rest || "data-footnote-backref" in rest)) {
      const id = PREFIX + href.slice(1);
      return <a {...rest} href={`#${id}`} onClick={(e) => toFootnote(e, id)} />;
    }
    return <a {...rest} href={safeHref(href)} target="_blank" rel="noopener noreferrer" />;
  },
  /** data: — только картинка. */
  img({ node: _, src, ...rest }) {
    const allowed = typeof src === "string" && (!/^data:/i.test(src) || /^data:image\//i.test(src));
    return <img {...rest} src={allowed ? src : undefined} loading="lazy" referrerPolicy="no-referrer" />;
  },
  table: ({ node: _, ...rest }) => (
    <div className="md-table">
      <table {...rest} />
    </div>
  ),
  pre({ node, children }) {
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
    if (code?.type !== "element") {
      return (
        <div className="cb">
          <pre>{children as ReactNode}</pre>
        </div>
      );
    }
    const classes = (code.properties.className ?? []) as string[];
    const lang = classes.map((c) => /^language-(.+)$/.exec(c)?.[1]).find(Boolean) ?? "";
    return <CodeBlock code={textOf(code).replace(/\n$/, "")} lang={lang} />;
  },
};

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  return (
    <div className={live ? "md caret" : "md"}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} remarkRehypeOptions={NO_PREFIX} components={COMPONENTS} urlTransform={(url) => url}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
