// «Копировать»: после нажатия — галочка на полторы секунды; буфер недоступен — без отметки.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const SHOWN_MS = 1500;

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const h = setTimeout(() => setDone(false), SHOWN_MS);
    return () => clearTimeout(h);
  }, [done]);
  return (
    <button type="button" className="cb-b" aria-label="Копировать" title="Копировать" onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true), () => {})}>
      {done ? <Check size={13} /> : <Copy size={13} />}
      {label ? (done ? "скопировано" : label) : null}
    </button>
  );
}
