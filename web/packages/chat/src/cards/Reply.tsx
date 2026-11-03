// Ответ Claude: части по порядку; под готовым — «копировать ответ».
import type { AsstItem } from "../state/types.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { PartView } from "./PartView.tsx";

export function Reply({ it }: { it: AsstItem }) {
  const text = it.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n");
  const live = it.parts.some((p) => p.kind === "text" && p.live);
  return (
    <div className="chat-reply">
      {it.parts.map((p, i) => (
        <PartView key={p.kind === "tool" ? p.id : i} p={p} />
      ))}
      {text && !live ? (
        <div className="chat-acts">
          <CopyButton text={text} label="копировать" />
        </div>
      ) : null}
    </div>
  );
}
