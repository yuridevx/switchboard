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
const schema = {
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

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeRaw, [rehypeSanitize, schema]] as never;
/** Приставку id сносок ставит санитайзер, вторая им не нужна. */
const remarkRehypeOptions = { clobberPrefix: "" };

/** Ссылка сноски на текст и обратно: её делает разметка, а не адрес страницы. */
const FOOTNOTE = /^#fn(ref)?-/;
const FOOTNOTE_ID = "user-content-";

/** Адрес ссылки: как у библиотеки, но без адресов этой страницы с # (её маршрут и приглашение) и без приглашений куда бы то ни было. */
function safeHref(url: string): string {
  const u = defaultUrlTransform(url);
  const at = u.indexOf("#");
  if (at < 0 || FOOTNOTE.test(u)) return u;
  let hash = u.slice(at + 1);
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // негодное экранирование не открывает маршрут: остаётся как есть
  }
  if (hash.startsWith("invite=")) return "";
  return URL.canParse(u, location.href) && new URL(u, location.href).origin === location.origin ? "" : u;
}

/** Адреса: картинки — как у библиотеки и data:image; ссылки — safeHref. */
const urlTransform = (url: string, key: string) => (key === "href" ? safeHref(url) : key === "src" && url.startsWith("data:image/") ? url : defaultUrlTransform(url));

/** Сноска: прокрутка к цели внутри своего текста, адрес страницы (её маршрут) не меняется. */
function FootnoteLink({ href, ...p }: ComponentProps<"a"> & { href: string }) {
  const id = FOOTNOTE_ID + href.slice(1);
  return (
    <a
      {...p}
      href={`#${id}`}
      onClick={(e) => {
        e.preventDefault();
        const box = e.currentTarget.closest(".md");
        [...(box?.querySelectorAll("[id]") ?? [])].find((x) => x.id === id)?.scrollIntoView();
      }}
    />
  );
}

const components: Components = {
  a: ({ node: _n, href, ...p }) => (href && FOOTNOTE.test(href) ? <FootnoteLink {...p} href={href} /> : <a {...p} href={href || undefined} target="_blank" rel="noopener noreferrer" />),
  img: ({ node: _n, alt, ...p }) => <img {...p} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
  table: ({ node: _n, ...p }) => (
    <div className="md-table">
      <table {...p} />
    </div>
  ),
  pre: ({ node, children }) => {
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
    if (!code)
      return (
        <div className="cb">
          <pre>{children}</pre>
        </div>
      );
    const cls = code?.type === "element" ? (code.properties.className as string[] | undefined) : undefined;
    const lang = cls?.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
    return <CodeBlock code={textOfNode(code).replace(/\n$/, "")} lang={lang} />;
  },
};

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  // поток дописывает кусочками: разбор не мешает вводу и прокрутке
  const shown = useDeferredValue(text);
  return (
    <div className={live ? "md caret" : "md"}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform} remarkRehypeOptions={remarkRehypeOptions}>
        {shown}
      </ReactMarkdown>
    </div>
  );
});
