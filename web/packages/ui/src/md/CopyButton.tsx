// «Копировать»: после нажатия — галочка на полторы секунды; буфер недоступен — словом у кнопки с подписью, у значка — без отметки.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const SHOWN_MS = 1500;
const WORDS = { done: "скопировано", bad: "буфер недоступен" };

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [outcome, setOutcome] = useState<"" | "done" | "bad">("");
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(""), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [outcome]);
  function copy() {
    const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (!clipboard) return setOutcome("bad");
    void clipboard.writeText(text).then(
      () => setOutcome("done"),
      () => setOutcome("bad"),
    );
  }
  return (
    <button type="button" className="cb-b" aria-label="Копировать" title="Копировать" onClick={copy}>
      {outcome === "done" ? <Check size={13} /> : <Copy size={13} />}
      {label ? (outcome ? WORDS[outcome] : label) : null}
    </button>
  );
}
