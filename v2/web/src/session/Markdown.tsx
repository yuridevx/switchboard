// Markdown ответа модели: отдельный кусок сборки, грузится при первом тексте.
// Блок кода — с копированием; HTML — с просмотром в песочнице; ссылки открываются в новой вкладке.
import { CopyButton } from "@mantine/core";
import { isValidElement, useState, type ReactNode } from "react";
import { HtmlFrame, looksHtml, textOf } from "./html.tsx";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function Code({ lang, code, children }: { lang: string; code: string; children: ReactNode }) {
  const html = looksHtml(lang, code);
  const [view, setView] = useState(false);
  return (
    <div className="codeblock">
      <div className="codebar">
        <span className="muted mono">{lang}</span>
        {html && <button type="button" className="linkbtn" aria-pressed={view} onClick={() => setView((v) => !v)}>{view ? "Код" : "Просмотр"}</button>}
        <CopyButton value={code}>{({ copied, copy }) => <button type="button" className="linkbtn" onClick={copy}>{copied ? "Скопировано" : "Копировать"}</button>}</CopyButton>
      </div>
      {view ? <HtmlFrame html={code} /> : <pre>{children}</pre>}
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
          pre: ({ children }) => {
            const el = Array.isArray(children) ? children[0] : children;
            const cls = isValidElement(el) ? String((el.props as { className?: string }).className ?? "") : "";
            return <Code lang={/language-([\w-]+)/.exec(cls)?.[1] ?? ""} code={textOf(children).replace(/\n$/, "")}>{children}</Code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
