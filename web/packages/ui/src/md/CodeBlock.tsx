// Блок кода: язык, подсветка, копирование; HTML и SVG — ещё и просмотр в песочнице.
import { useState } from "react";
import { Code2, Eye } from "lucide-react";
import { CopyButton } from "./CopyButton.tsx";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { useHighlighted } from "./highlight.tsx";

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [view, setView] = useState(false);
  const nodes = useHighlighted(code, lang);
  const Icon = view ? Code2 : Eye;
  return (
    <div className="cb" data-lang={lang || undefined}>
      <div className="cb-h">
        <span className="cb-l">{lang}</span>
        {/^(html|svg)$/i.test(lang) && (
          <button type="button" className="cb-b" aria-pressed={view} onClick={() => setView(!view)}>
            <Icon size={13} aria-hidden="true" />
            {view ? "Код" : "Просмотр"}
          </button>
        )}
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
