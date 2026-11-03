// Запись ленты → карточка; в фокусе — ещё и свёрнутые шаги хода. memo: новое сообщение рисует одну карточку.
import { memo } from "react";
import { ListCollapse } from "lucide-react";
import type { Steps } from "../state/focus.ts";
import type { Item } from "../state/types.ts";
import { Disclosure } from "../ui/Disclosure.tsx";
import { kindOf } from "./tools/kinds.tsx";
import { steps as stepsWord } from "./format.ts";
import { Reply } from "./Reply.tsx";
import { SysRow } from "./SysRow.tsx";
import { InCard, MeCard, PeerCard } from "./UserCards.tsx";

export const ItemView = memo(function ItemView({ it }: { it: Item }) {
  switch (it.kind) {
    case "user":
      return it.from ? <PeerCard it={it} /> : <MeCard it={it} />;
    case "in":
      return <InCard it={it} />;
    case "sys":
      return <SysRow sys={it.sys} at={it.at} />;
    case "assistant":
      return <Reply it={it} />;
  }
});

/** Сводка: «12 шагов · Команда ×5 · Правка ×3 · размышлял». */
function stepsLine(s: Steps): string {
  const counts = Object.entries(s.tools).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((n, [, k]) => n + k, 0);
  const names = counts.map(([name, k]) => `${kindOf({ name, input: {} }).label}${k > 1 ? ` ×${k}` : ""}`);
  return [total ? stepsWord(total) : null, ...names, s.thought ? "размышлял" : null].filter(Boolean).join(" · ") || "служебные строки";
}

export function StepsRow({ steps }: { steps: Steps }) {
  return (
    <Disclosure
      className="chat-steps"
      title={
        <>
          <ListCollapse size={14} />
          {stepsLine(steps)}
        </>
      }
    >
      {steps.items.map((it) => (
        <ItemView key={it.id} it={it} />
      ))}
    </Disclosure>
  );
}
