// Что вид ленты берёт снаружи. На экране — настоящий разговор, в галерее — образец с молчащими кнопками.
import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DisclosureBtn } from "@switchboard/web-ui";
import type { Rewind, Send } from "../state/chat.ts";
import type { View } from "../state/fold.ts";

export type Env = {
  callsign: string;
  view: View;
  sends: Record<string, Send>;
  /** плашка отката под сообщением */
  rewind?: Rewind;
  canCall: boolean;
  wide: boolean;
  /** подпись сессии в строке «кто → вам» */
  label(callsign: string): string;
  /** хук: запрос разрешения этого инструмента ждёт человека */
  useWaiting(toolId: string): boolean;
  /** метод Host по нажатию: отказ показывает сам */
  act(method: string, args?: unknown[]): void;
  fillText(text: string): void;
  again(uuid: string): void;
  cancel(uuid: string): void;
  probeRewind(uuid: string): void;
  applyRewind(uuid: string): void;
  cancelRewind(): void;
};

export const EnvCtx = createContext<Env | null>(null);

export function useEnv(): Env {
  const e = useContext(EnvCtx);
  if (!e) throw new Error("лента вне разговора");
  return e;
}

/** Свёрнутая строка: заголовок-кнопка и тело. */
export function Dis({ head, className, open: first = false, children }: { head: ReactNode; className?: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(first);
  return (
    <div className={className ? `dis ${className}` : "dis"}>
      <DisclosureBtn className="dis-h" open={open} onClick={() => setOpen(!open)}>
        {head}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </DisclosureBtn>
      {open ? <div className="dis-b">{children}</div> : null}
    </div>
  );
}
