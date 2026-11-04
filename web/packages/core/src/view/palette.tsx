// Поиск Ctrl K: разделы и то, что экраны отдают в find.
import { useState } from "react";
import { Dot } from "@switchboard/web-ui";
import { useCore, type Hit } from "./core.ts";

export function Palette({ close }: { close(): void }) {
  const core = useCore();
  const [q, setQ] = useState("");
  const list = core.use(() => core.hits(q));
  const pick = (x: Hit) => {
    close();
    core.go(x.screen, x.params);
  };
  return (
    <>
      <div className="sb-palveil" onClick={close} />
      <div className="sb-pal" role="dialog" aria-label="Перейти">
        <input
          autoFocus
          className="sb-palin"
          placeholder="Сессия, проект, раздел или команда"
          aria-label="Перейти"
          value={q}
          onChange={() => {}}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && list[0]) {
              e.preventDefault();
              pick(list[0]);
            }
            if (e.key === "Escape") close();
          }}
        />
        <div className="sb-palres" role="listbox">
          {list.map((x, i) => (
            <button key={`${x.screen}?${JSON.stringify(x.params)}?${x.label}`} className={"sb-palit" + (i === 0 ? " first" : "")} role="option" onClick={() => pick(x)}>
              {x.dot ? <Dot kind={x.dot} /> : null}
              <span className="l">{x.label}</span>
              {x.hint ? <span className="k">{x.hint}</span> : null}
            </button>
          ))}
          {list.length ? null : (
            <div className="sb-note" style={{ padding: "10px 12px" }}>
              Ничего не нашлось
            </div>
          )}
        </div>
      </div>
    </>
  );
}
