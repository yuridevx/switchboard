// Поиск Ctrl K: разделы и то, что экраны отдают поиску.
import { useEffect, useRef, useState } from "react";
import { Dot, In, Note, RowBtn } from "@switchboard/web-ui";
import type { Params } from "../types.ts";
import type { Page } from "./shell.tsx";

const LIMIT = 40;
const EMPTY = { padding: "10px 12px" };
type Hit = { label: string; hint?: string; dot?: string; screen: string; params?: Params };

function hits({ modules, wide }: Page, q: string): Hit[] {
  return modules
    .sections()
    .flatMap((name): Hit[] => {
      const [e, s] = modules.screenOf(name)!;
      if (modules.off(e)) return [];
      const own: Hit[] = s.nav!.toLowerCase().includes(q) ? [{ label: s.nav!, hint: (wide ? s.group : (s.narrowGroup ?? s.group)) ?? "раздел", screen: name }] : [];
      const found = s.find ? (modules.trap(e, `экране ${name}`, () => s.find!(q)) ?? []) : [];
      return [...own, ...found.filter((h) => modules.screenFor(e, h.screen))];
    })
    .slice(0, LIMIT);
}

function Box({ page }: { page: Page }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const rows = page.bus.use(() => hits(page, q.toLowerCase()));
  useEffect(() => input.current?.focus(), []);
  const go = (h: Hit) => {
    page.search();
    page.open(h.screen, h.params);
  };
  return (
    <>
      <div className="sb-palveil" onClick={page.search} />
      <div className="sb-pal" role="dialog" aria-label="Перейти">
        <In
          ref={input}
          className="sb-palin"
          aria-label="Перейти"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") page.search();
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
          {!rows.length && <Note style={EMPTY}>Ничего не нашлось</Note>}
        </div>
      </div>
    </>
  );
}

export function Search({ page }: { page: Page }) {
  const { core, bus, doc, wide } = page;
  const open = bus.use(() => core.searching);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!wide || !(e.ctrlKey || e.metaKey) || !(e.code === "KeyK" || e.key === "k" || e.key === "л") || !core.current || core.stopped !== null) return;
      e.preventDefault();
      page.search();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [core, doc, page, wide]);
  return (
    <div className="sb-palw" hidden={!open}>
      {open && <Box page={page} />}
    </div>
  );
}
