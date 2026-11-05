// Блок кода: язык, подсветка, копирование; html и svg — ещё просмотр в песочнице.
import { Code2, Eye } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { useHighlighted } from "./highlight.tsx";
import { HtmlFrame } from "./HtmlFrame.tsx";

/** Текст узла разметки с вложенными. */
export function textOfNode(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (n?.type === "text") return n.value ?? "";
  return n?.children?.map(textOfNode).join("") ?? "";
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [preview, setPreview] = useState(false);
  const shows = /^(html|svg)$/i.test(lang);
  const lines = useHighlighted(code, lang);
  const Icon = preview ? Code2 : Eye;
  return (
    <div className="cb" data-lang={lang || undefined}>
      <div className="cb-h">
        <span className="cb-l">{lang}</span>
        {shows && (
          <button type="button" className="cb-b" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            <Icon size={13} aria-hidden="true" />
            {preview ? "Код" : "Просмотр"}
          </button>
        )}
        <CopyButton text={code} />
      </div>
      {preview ? (
        <HtmlFrame html={code} />
      ) : (
        <pre>
          <code className={lang ? `hljs language-${lang}` : "hljs"}>{lines}</code>
        </pre>
      )}
    </div>
  );
}
