// Текст ответа: markdown с таблицами и списками задач, встроенный HTML — через санитайзер. Скрипты, обработчики и опасные адреса
// до страницы не доходят (на ней ключ флота). Полный документ и блоки html, svg — в CodeBlock, в отдельной песочнице.
// memo: поток дописывает только последний текст, готовые ответы заново не разбираются.
import { memo, useDeferredValue, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock, textOfNode } from "./CodeBlock.tsx";

/** Что разрешено во встроенном HTML: разметка текста, без скриптов и стилей. Язык блока кода — только language-*. */
const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "abbr", "cite", "figure", "figcaption", "picture", "source"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-[\w+#-]+$/]],
    abbr: ["title"],
    source: ["srcSet", "media", "type"],
  },
  protocols: { ...defaultSchema.protocols, src: ["http", "https", "data"] },
};

const REMARK = [remarkGfm];
const REHYPE = [rehypeRaw, [rehypeSanitize, SCHEMA]] as never;
/** Приставку id сносок ставит санитайзер, вторая им не нужна. */
const REMARK_REHYPE = { clobberPrefix: "" };

/** Ссылка сноски на текст и обратно: её делает разметка, а не адрес страницы. */
const FOOTNOTE = /^#fn(ref)?-/;
const FOOTNOTE_ID = "user-content-";

/** Часть после # без экранирования; негодное экранирование не открывает маршрут: остаётся как есть. */
function decodedHash(url: string, at: number): string {
  const hash = url.slice(at + 1);
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/** Адрес ссылки: как у библиотеки, но без адресов этой страницы с # (её маршрут и приглашение) и без приглашений куда бы то ни было. */
function safeHref(url: string): string {
  const u = defaultUrlTransform(url);
  const at = u.indexOf("#");
  if (at < 0 || FOOTNOTE.test(u)) return u;
  if (decodedHash(u, at).startsWith("invite=")) return "";
  return URL.canParse(u, location.href) && new URL(u, location.href).origin === location.origin ? "" : u;
}

/** Адреса: картинки — как у библиотеки и data:image; ссылки — safeHref. */
function urlTransform(url: string, key: string): string {
  if (key === "href") return safeHref(url);
  return key === "src" && url.startsWith("data:image/") ? url : defaultUrlTransform(url);
}

/** Сноска: прокрутка к цели внутри своего текста, адрес страницы (её маршрут) не меняется. */
function FootnoteLink({ href, ...p }: ComponentProps<"a"> & { href: string }) {
  const target = FOOTNOTE_ID + href.slice(1);
  return (
    <a
      {...p}
      href={`#${target}`}
      onClick={(e) => {
        e.preventDefault();
        const text = e.currentTarget.closest(".md");
        [...(text?.querySelectorAll("[id]") ?? [])].find((x) => x.id === target)?.scrollIntoView();
      }}
    />
  );
}

const COMPONENTS: Components = {
  a: ({ node: _node, href, ...p }) => (href && FOOTNOTE.test(href) ? <FootnoteLink {...p} href={href} /> : <a {...p} href={href || undefined} target="_blank" rel="noopener noreferrer" />),
  img: ({ node: _node, alt, ...p }) => <img {...p} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
  table: ({ node: _node, ...p }) => (
    <div className="md-table">
      <table {...p} />
    </div>
  ),
  pre({ node, children }) {
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
    if (code?.type !== "element") {
      return (
        <div className="cb">
          <pre>{children}</pre>
        </div>
      );
    }
    const classes = code.properties.className as string[] | undefined;
    const lang = classes?.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
    return <CodeBlock code={textOfNode(code).replace(/\n$/, "")} lang={lang} />;
  },
};

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  // поток дописывает кусочками: разбор не мешает вводу и прокрутке
  const shown = useDeferredValue(text);
  return (
    <div className={live ? "md caret" : "md"}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS} urlTransform={urlTransform} remarkRehypeOptions={REMARK_REHYPE}>
        {shown}
      </ReactMarkdown>
    </div>
  );
});
