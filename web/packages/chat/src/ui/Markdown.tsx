// Текст ответа: markdown с таблицами и списками задач, встроенный HTML — через санитайзер. Скрипты, обработчики и опасные адреса
// до страницы не доходят (на ней ключ флота). Полный документ и блоки html, svg — в CodeBlock, в отдельной песочнице.
// memo: поток дописывает только последний текст, готовые ответы заново не разбираются.
import { memo, useDeferredValue } from "react";
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

/** Адреса: как у библиотеки (ссылки без javascript: и прочего); картинки — ещё и data:image. */
const urlTransform = (url: string, key: string) => (key === "src" && url.startsWith("data:image/") ? url : defaultUrlTransform(url));

const components: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _n, alt, ...p }) => <img {...p} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
  table: ({ node: _n, ...p }) => (
    <div className="md-table">
      <table {...p} />
    </div>
  ),
  pre: ({ node }) => {
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
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
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>
        {shown}
      </ReactMarkdown>
    </div>
  );
});
