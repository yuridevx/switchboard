// Сведения сбоку широкой карточки: кто дал задачу, папка, профиль, дерево сессий, серверы MCP, ссылка в claude.ai.
import { useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { isLive, profileNameOf, remoteOf, useApp, useMachineLoad, Btn, LinkBtn } from "@switchboard/web-ui";
import type { Mcp } from "./session.ts";
import { Kv } from "./WidePops.tsx";

/** Состояние сервера MCP словом. */
const MCP_WORD: Record<string, string> = { connected: "подключён", failed: "ошибка", "needs-auth": "нужен вход", pending: "подключается", disabled: "выключен" };

/** Серверы MCP сессии на время открытых сведений и действия над ними; отказ — тост. */
function useMcp(callsign: string, live: boolean) {
  const app = useApp();
  const q = useMachineLoad<Mcp[]>(machineOf(callsign) ?? "", "session.call", { callsign, method: "mcpServerStatus", args: [] }, live);
  async function change(method: string, args: unknown[]) {
    const r = await app.request("session.call", { callsign, method, args });
    if (!r.ok) return app.toast(`${method}: ${r.error}`);
    q.reload();
  }
  return {
    list: Array.isArray(q.data) ? q.data : null,
    toggleMcp: (m: Mcp) => change("toggleMcpServer", [m.name, m.status === "disabled"]),
    reconnectMcp: (m: Mcp) => change("reconnectMcpServer", [m.name]),
    /** Вход сервера MCP: адрес страницы входа. Окно после ответа запроса браузер блокирует: страницу открывает ссылка. */
    async loginMcp(m: Mcp): Promise<string | undefined> {
      const r = await app.request<{ authUrl?: string } | null>("session.call", { callsign, method: "mcpAuthenticate", args: [m.name] });
      if (!r.ok) return void app.toast(`mcpAuthenticate: ${r.error}`);
      if (!r.result?.authUrl) app.toast("mcpAuthenticate: ссылки нет");
      return r.result?.authUrl;
    },
  };
}

type McpActs = Pick<ReturnType<typeof useMcp>, "toggleMcp" | "reconnectMcp" | "loginMcp">;

function McpRow({ m, toggleMcp, reconnectMcp, loginMcp }: McpActs & { m: Mcp }) {
  const [url, setUrl] = useState<string | undefined>();
  const off = m.status === "disabled";
  return (
    <div className="cw-mcp">
      <div className="cw-sw">
        <span>{m.name}</span>
        {m.status ? <em className="cw-mcp-st" data-state={m.status}>{MCP_WORD[m.status] ?? m.status}</em> : null}
        <Btn data-mcp={m.name} onClick={() => void toggleMcp(m)}>
          {off ? "вкл" : "выкл"}
        </Btn>
      </div>
      <div className="cw-mcp-a">
        {off ? null : (
          <Btn ghost data-mcp-re={m.name} onClick={() => void reconnectMcp(m)}>
            Переподключить
          </Btn>
        )}
        {m.status === "needs-auth" ? (
          <Btn ghost data-mcp-login={m.name} onClick={() => void loginMcp(m).then(setUrl)}>
            Войти
          </Btn>
        ) : null}
        {url ? (
          <LinkBtn ghost data-mcp-url={m.name} href={url} target="_blank" rel="noopener noreferrer">
            Открыть страницу входа ↗
          </LinkBtn>
        ) : null}
      </div>
    </div>
  );
}

export function WideAside({ callsign, s }: { callsign: string; s: SessionRecord | undefined }) {
  const app = useApp();
  const { list: mcp, toggleMcp, reconnectMcp, loginMcp } = useMcp(callsign, isLive(s?.state));
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
                        <Btn ghost key={k} className="kid" onClick={() => app.open("card", { callsign: k })}>
                          {k}
                        </Btn>
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
