// Поиск Ctrl K: разделы и то, что отдают экраны.
import { useEffect, useRef, useState } from "react";
import { Dot, In, Note, RowBtn } from "@switchboard/web-ui";
import type { Params } from "../types.ts";
import { useCore } from "./place.tsx";

const LIMIT = 40;

type Hit = { label: string; hint?: string; dot?: string; screen: string; params?: Params };

/** Живые разделы и их строки: строка ведёт на экран своего модуля или из его uses. */
function useHits(q: string): Hit[] {
  const { page, mods } = useCore();
  return page.use(() =>
    mods.sections
      .filter((s) => page.failed[s.mod.name] === undefined)
      .flatMap((s) => {
        const group = page.wide ? s.def.group : (s.def.narrowGroup ?? s.def.group);
        const own: Hit[] = s.label.toLowerCase().includes(q) ? [{ label: s.label, hint: group ?? "раздел", screen: s.name }] : [];
        const found = (s.def.find && mods.call(s.mod, `экране ${s.name}`, () => s.def.find!(q))) || [];
        return [...own, ...found.filter((h) => mods.screens.has(h.screen) && mods.reaches(s.mod, mods.screens.get(h.screen), h.screen))];
      })
      .slice(0, LIMIT),
  );
}

function Box() {
  const { page, route } = useCore();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const rows = useHits(q.toLowerCase());
  useEffect(() => input.current?.focus(), []);
  const go = (h: Hit) => {
    page.toggleSearch();
    route.open(h.screen, h.params);
  };
  return (
    <>
      <div className="sb-palveil" onClick={page.toggleSearch} />
      <div className="sb-pal" role="dialog" aria-label="Перейти">
        <In
          ref={input}
          className="sb-palin"
          aria-label="Перейти"
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") page.toggleSearch();
            if (e.key === "Enter" && rows[0]) go(rows[0]);
          }}
        />
        <div className="sb-palres" role="listbox">
          {rows.map((h, i) => (
            <RowBtn key={`${h.screen}:${h.label}:${i}`} role="option" className={i === 0 ? "sb-palit first" : "sb-palit"} onClick={() => go(h)}>
              {h.dot && <Dot kind={h.dot} />}
              <span className="l">{h.label}</span>
              {h.hint && <span className="k">{h.hint}</span>}
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
  useEffect(() => {
    const doc = page.win.document;
    const onKey = (e: KeyboardEvent) => {
      if (!page.wide || !(e.ctrlKey || e.metaKey) || !(e.code === "KeyK" || e.key === "k" || e.key === "л") || !page.current || page.stop) return;
      e.preventDefault();
      page.toggleSearch();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [page]);
  return (
    <div className="sb-palw" hidden={!open}>
      {open && <Box />}
    </div>
  );
}
