// Блок кода: язык, «копировать», подсветка; html и svg — ещё и просмотр в песочнице.
import { useState } from "react";
import { Code2, Eye } from "lucide-react";
import { CopyButton } from "./CopyButton.tsx";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { useHighlighted } from "./highlight.tsx";

/** Текст узла разметки с вложенными. */
export function textOfNode(n: unknown): string {
  const x = n as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (x?.type === "text") return x.value ?? "";
  return (x?.children ?? []).map(textOfNode).join("");
}

const PREVIEW = new Set(["html", "svg"]);

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const previewable = PREVIEW.has(lang.toLowerCase());
  const [view, setView] = useState(false);
  const nodes = useHighlighted(code, lang.toLowerCase());
  return (
    <div className="cb" data-lang={lang || undefined}>
      <div className="cb-h">
        <span className="cb-l">{lang}</span>
        {previewable ? (
          <button type="button" className="cb-b" aria-pressed={view} onClick={() => setView(!view)}>
            {view ? <Code2 size={13} /> : <Eye size={13} />}
            {view ? "Код" : "Просмотр"}
          </button>
        ) : null}
        <CopyButton text={code} />
      </div>
      {view ? (
        <HtmlFrame html={code} />
      ) : (
        <pre>
          <code className={lang ? `hljs language-${lang}` : "hljs"}>{nodes}</code>
        </pre>
      )}
    </div>
  );
}
