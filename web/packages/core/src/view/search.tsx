// Поиск Ctrl K: разделы и то, что экраны отдают в find.
import { useState } from "react";
import { Dot, In, RowBtn } from "@switchboard/web-ui";
import type { Hit } from "../sections.ts";
import { useCore } from "./context.ts";

export function Search({ close }: { close(): void }) {
  const { snap, sections, address } = useCore();
  const [query, setQuery] = useState("");
  const hits = snap.use(() => sections.hits(query));
  const pick = (hit: Hit) => {
    close();
    address.go(hit.screen, hit.params);
  };
  return (
    <>
      <div className="sb-palveil" onClick={close} />
      <div className="sb-pal" role="dialog" aria-label="Перейти">
        <In
          autoFocus
          className="sb-palin"
          placeholder="Сессия, проект, раздел или команда"
          aria-label="Перейти"
          value={query}
          onChange={() => {}}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              pick(hits[0]);
            }
            if (e.key === "Escape") close();
          }}
        />
        <div className="sb-palres" role="listbox">
          {hits.map((hit, i) => (
            <RowBtn key={`${hit.screen}?${JSON.stringify(hit.params)}?${hit.label}`} className={i === 0 ? "sb-palit first" : "sb-palit"} role="option" onClick={() => pick(hit)}>
              {hit.dot ? <Dot kind={hit.dot} /> : null}
              <span className="l">{hit.label}</span>
              {hit.hint ? <span className="k">{hit.hint}</span> : null}
            </RowBtn>
          ))}
          {hits.length ? null : (
            <div className="sb-note" style={{ padding: "10px 12px" }}>
              Ничего не нашлось
            </div>
          )}
        </div>
      </div>
    </>
  );
}
