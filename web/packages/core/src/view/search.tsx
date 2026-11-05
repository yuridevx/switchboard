// Поиск Ctrl K: разделы и то, что отдают экраны.
import { useEffect, useRef, useState } from "react";
import { Dot, In, Note, RowBtn } from "@switchboard/web-ui";
import type { Params } from "../types.ts";
import { useCore } from "./place.tsx";

const MAX = 40;

type Row = { label: string; hint?: string; dot?: string; screen: string; params?: Params };

/** Живые разделы и их строки; строка ведёт на экран своего модуля или из его uses. */
function useRows(q: string): Row[] {
  const { page, mods } = useCore();
  const needle = q.toLowerCase();
  return mods.sections
    .filter((s) => page.failed[s.mod.name] === undefined)
    .flatMap((s) => {
      const own = s.label.toLowerCase().includes(needle) ? [{ label: s.label, hint: s.def.group ?? "раздел", screen: s.name }] : [];
      const found = (s.def.find && mods.call(s.mod, `поиске ${s.name}`, () => s.def.find!(q))) || [];
      return [...own, ...found.filter((r) => mods.screens.has(r.screen) && mods.reaches(s.mod, mods.screens.get(r.screen), r.screen))];
    })
    .slice(0, MAX);
}

function Palette({ close }: { close(): void }) {
  const { route } = useCore();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const rows = useRows(q);
  useEffect(() => input.current?.focus(), []);
  const go = (r: Row) => {
    route.open(r.screen, r.params);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && rows[0]) go(rows[0]);
  };
  return (
    <>
      <div className="sb-palveil" onClick={close} />
      <div className="sb-pal" role="dialog" aria-label="Перейти">
        <In ref={input} className="sb-palin" aria-label="Перейти" onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
        <div className="sb-palres" role="listbox">
          {rows.map((r, i) => (
            <RowBtn key={`${r.screen}${r.label}${i}`} className={i ? "sb-palit" : "sb-palit first"} role="option" onClick={() => go(r)}>
              {r.dot && <Dot kind={r.dot} />}
              <span className="l">{r.label}</span>
              {r.hint && <span className="k">{r.hint}</span>}
            </RowBtn>
          ))}
          {!rows.length && <Note style={{ padding: "10px 12px" }}>Ничего не нашлось</Note>}
        </div>
      </div>
    </>
  );
}

export function Search() {
  const { page } = useCore();
  const open = page.use(() => page.search && !page.stop);
  const set = (on: boolean) => {
    page.search = on;
    page.changed();
  };
  useEffect(() => {
    if (!page.wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !(e.code === "KeyK" || /^[kл]$/i.test(e.key))) return;
      e.preventDefault();
      set(!page.search);
    };
    const doc = page.win.document;
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="sb-palw" hidden={!open}>
      {open && <Palette close={() => set(false)} />}
    </div>
  );
}
