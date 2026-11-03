// Сведения сбоку широкой карточки: кто дал задачу, папка, профиль, дерево сессий, серверы MCP, ссылка в claude.ai.
import { useApp, type SessionRecord } from "@switchboard/web-core";
import { profileName, profileNameOf, remoteOf } from "@switchboard/web-ui";
import type { Mcp } from "./session.ts";
import { Kv } from "./WidePops.tsx";

export function WideAside({ callsign, s, mcp, toggleMcp }: { callsign: string; s: SessionRecord | undefined; mcp: Mcp[] | null; toggleMcp(m: Mcp): Promise<void> }) {
  const app = useApp();
  const kids = app.use(() => (app.roster()?.sessions ?? []).filter((x) => x.parent === callsign).map((x) => x.callsign));
  const remote = remoteOf(s);
  const from = typeof s?.by === "string" ? s.by : "";
  return (
    <aside className="cw-info" aria-label="Сведения">
      {s ? (
        <>
          <div>
            <h4>Сведения</h4>
            <dl className="cw-kv">
              {from ? <Kv k="задачу дал" v={from} /> : null}
              {typeof s.dir === "string" ? <Kv k="папка" v={s.dir} /> : null}
              <Kv k="профиль" v={profileNameOf(s) ?? "без профиля"} />
            </dl>
          </div>
          {typeof s.parent === "string" || kids.length ? (
            <div>
              <h4>Дерево</h4>
              <dl className="cw-kv">
                {typeof s.parent === "string" ? <Kv k="открыла" v={s.parent} /> : null}
                {kids.length ? (
                  <>
                    <dt>ведёт</dt>
                    <dd>
                      {kids.map((k) => (
                        <button key={k} className="cw-b ghost kid" onClick={() => app.open("card", { callsign: k })}>
                          {k}
                        </button>
                      ))}
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>
          ) : null}
          {mcp?.length ? (
            <div>
              <h4>Серверы MCP</h4>
              {mcp.map((m) => (
                <div key={m.name} className="cw-sw">
                  <span>{m.name}</span>
                  <button className="cw-b" data-mcp={m.name} onClick={() => void toggleMcp(m)}>
                    {m.status === "disabled" ? "вкл" : "выкл"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {remote ? (
            <a className="cw-mi flat" href={remote} target="_blank" rel="noopener">
              Открыть в claude.ai ↗
            </a>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
