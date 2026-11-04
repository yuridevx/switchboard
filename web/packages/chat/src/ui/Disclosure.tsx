// Свёрнутая строка: заголовок-кнопка и содержимое по нажатию.
import { DisclosureBtn } from "@switchboard/web-ui";
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function Disclosure({ title, className, open: initial = false, children }: { title: ReactNode; className?: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={className ? `dis ${className}` : "dis"}>
      <DisclosureBtn className="dis-h" open={open} onClick={() => setOpen(!open)}>
        {title}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </DisclosureBtn>
      {open ? <div className="dis-b">{children}</div> : null}
    </div>
  );
}
