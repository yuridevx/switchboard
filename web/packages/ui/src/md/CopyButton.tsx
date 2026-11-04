// «Копировать»: после нажатия — галочка на полторы секунды; буфер недоступен — словом у кнопки с подписью, у значка — без отметки.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const SHOWN_MS = 1500;
const WORDS = { done: "скопировано", bad: "буфер недоступен" };

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [state, setState] = useState<"" | "done" | "bad">("");
  useEffect(() => {
    if (!state) return;
    const h = setTimeout(() => setState(""), SHOWN_MS);
    return () => clearTimeout(h);
  }, [state]);
  const copy = () => {
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (!clip) return setState("bad");
    void clip.writeText(text).then(
      () => setState("done"),
      () => setState("bad"),
    );
  };
  return (
    <button type="button" className="cb-b" aria-label="Копировать" title="Копировать" onClick={copy}>
      {state === "done" ? <Check size={13} /> : <Copy size={13} />}
      {label ? (state ? WORDS[state] : label) : null}
    </button>
  );
}
