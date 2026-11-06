// Копирование: значок и подпись говорят, как вышло.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const SHOWN_MS = 1500;

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [state, setState] = useState<"" | "done" | "denied">("");
  useEffect(() => {
    if (!state) return;
    const timer = setTimeout(() => setState(""), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => setState((await navigator.clipboard?.writeText(text).then(() => true, () => false)) ? "done" : "denied");
  const Icon = state === "done" ? Check : Copy;
  const word = { "": label, done: "скопировано", denied: "буфер недоступен" }[state];
  return (
    <button type="button" className="cb-b" aria-label="Копировать" title="Копировать" onClick={copy}>
      <Icon size={13} aria-hidden="true" />
      {label !== undefined && word}
    </button>
  );
}
