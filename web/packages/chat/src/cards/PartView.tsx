// Часть ответа Claude: текст, размышление или карточка инструмента. Шаги субагента — те же части (рекурсия PartView → ToolCard → SubAgent).
import { BrainCircuit } from "lucide-react";
import { isHtmlDocument } from "../state/parse.ts";
import type { Part } from "../state/types.ts";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { ToolCard } from "./tools/ToolCard.tsx";

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const t = text.trim();
  // пока идёт — последние строки; потом свёрнутая строка, по нажатию весь текст
  if (live) {
    return (
      <div className="chat-think live">
        <div className="chat-think-h">
          <BrainCircuit size={14} />
          Размышляет…
        </div>
        {t ? <div className="chat-think-t">{t.slice(-400)}</div> : null}
      </div>
    );
  }
  if (!t) {
    return (
      <div className="chat-think">
        <div className="chat-think-h">
          <BrainCircuit size={14} />
          Размышлял
        </div>
      </div>
    );
  }
  return (
    <Disclosure
      className="chat-think"
      title={
        <>
          <BrainCircuit size={14} />
          Размышлял
        </>
      }
    >
      <div className="chat-think-t">
        <Markdown text={t} />
      </div>
    </Disclosure>
  );
}

export function PartView({ p }: { p: Part }) {
  if (p.kind === "think") return <Thinking text={p.text} live={p.live} />;
  if (p.kind === "tool") return <ToolCard id={p.id} />;
  // полный HTML-документ показывается страницей, а не разбирается как разметка
  if (!p.live && isHtmlDocument(p.text)) return <CodeBlock code={p.text.trim()} lang="html" />;
  return (
    <div className="chat-txt">
      <Markdown text={p.text} live={p.live} />
    </div>
  );
}
