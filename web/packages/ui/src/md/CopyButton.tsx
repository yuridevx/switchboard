// Копирование в буфер: галочка на полторы секунды, отказ буфера — словом.
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const SHOWN_MS = 1500;

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [state, setState] = useState<"" | "done" | "denied">("");
  useEffect(() => {
    if (!state) return;
    const timer = setTimeout(() => setState(""), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = () => {
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("нет буфера"))).then(
      () => setState("done"),
      () => setState("denied"),
    );
  };
  const Icon = state === "done" ? Check : Copy;
  const word = { "": label, done: "скопировано", denied: "буфер недоступен" }[state];
  return (
    <button type="button" className="cb-b" aria-label="Копировать" title="Копировать" onClick={copy}>
      <Icon size={13} aria-hidden="true" />
      {label !== undefined && word}
    </button>
  );
}
