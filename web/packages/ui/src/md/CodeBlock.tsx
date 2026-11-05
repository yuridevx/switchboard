// Блок кода: язык, «копировать», подсветка; html и svg — ещё и просмотр в песочнице.
import { useState } from "react";
import { Code2, Eye } from "lucide-react";
import { CopyButton } from "./CopyButton.tsx";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { useHighlighted } from "./highlight.tsx";

/** Текст узла разметки с вложенными. */
export function textOfNode(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | undefined;
  return n?.type === "text" ? (n.value ?? "") : (n?.children ?? []).map(textOfNode).join("");
}

const WITH_PREVIEW = new Set(["html", "svg"]);

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const lower = lang.toLowerCase();
  const [preview, setPreview] = useState(false);
  const highlighted = useHighlighted(code, lower);
  return (
    <div className="cb" data-lang={lang || undefined}>
      <div className="cb-h">
        <span className="cb-l">{lang}</span>
        {WITH_PREVIEW.has(lower) ? (
          <button type="button" className="cb-b" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            {preview ? <Code2 size={13} /> : <Eye size={13} />}
            {preview ? "Код" : "Просмотр"}
          </button>
        ) : null}
        <CopyButton text={code} />
      </div>
      {preview ? (
        <HtmlFrame html={code} />
      ) : (
        <pre>
          <code className={lang ? `hljs language-${lang}` : "hljs"}>{highlighted}</code>
        </pre>
      )}
    </div>
  );
}
