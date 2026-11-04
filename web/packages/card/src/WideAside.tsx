// Сведения сбоку широкой карточки: кто дал задачу, папка, профиль, дерево сессий, серверы MCP, ссылка в claude.ai.
import { useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { profileName, profileNameOf, remoteOf, useApp } from "@switchboard/web-ui";
import type { Mcp } from "./session.ts";
import { Kv } from "./WidePops.tsx";

/** Состояние сервера MCP словом. */
const MCP_WORD: Record<string, string> = { connected: "подключён", failed: "ошибка", "needs-auth": "нужен вход", pending: "подключается", disabled: "выключен" };

type McpActs = { toggleMcp(m: Mcp): Promise<void>; reconnectMcp(m: Mcp): Promise<void>; loginMcp(m: Mcp): Promise<string | undefined> };

function McpRow({ m, toggleMcp, reconnectMcp, loginMcp }: McpActs & { m: Mcp }) {
  const [url, setUrl] = useState<string | undefined>();
  const off = m.status === "disabled";
  return (
    <div className="cw-mcp">
      <div className="cw-sw">
        <span>{m.name}</span>
        {m.status ? <em className="cw-mcp-st" data-state={m.status}>{MCP_WORD[m.status] ?? m.status}</em> : null}
        <button className="cw-b" data-mcp={m.name} onClick={() => void toggleMcp(m)}>
          {off ? "вкл" : "выкл"}
        </button>
      </div>
      <div className="cw-mcp-a">
        {off ? null : (
          <button className="cw-b ghost" data-mcp-re={m.name} onClick={() => void reconnectMcp(m)}>
            Переподключить
          </button>
        )}
        {m.status === "needs-auth" ? (
          <button className="cw-b ghost" data-mcp-login={m.name} onClick={() => void loginMcp(m).then(setUrl)}>
            Войти
          </button>
        ) : null}
        {url ? (
          <a className="cw-b ghost" data-mcp-url={m.name} href={url} target="_blank" rel="noopener noreferrer">
            Открыть страницу входа ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function WideAside({ callsign, s, mcp, toggleMcp, reconnectMcp, loginMcp }: McpActs & { callsign: string; s: SessionRecord | undefined; mcp: Mcp[] | null }) {
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
                <McpRow key={m.name} m={m} toggleMcp={toggleMcp} reconnectMcp={reconnectMcp} loginMcp={loginMcp} />
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
