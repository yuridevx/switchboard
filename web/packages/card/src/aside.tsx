// Сведения сбоку: чья сессия, дерево и серверы MCP живого процесса.
import { useState } from "react";
import type { SessionRecord } from "@switchboard/relay";
import { Btn, isLive, LinkBtn, Note, profileNameOf, remoteOf, useApp, useLoad } from "@switchboard/web-ui";

const WORDS: Record<string, string> = { connected: "подключён", pending: "подключается", disabled: "выключен", "needs-auth": "нужен вход", failed: "ошибка" };
type Server = { name: string; status: string };

export function Aside({ callsign, session }: { callsign: string; session?: SessionRecord }) {
  const app = useApp();
  const live = isLive(session?.state);
  const canCall = app.use(() => app.can(callsign.split("@")[1], "session.call") === true);
  const kids = app.use(() => (app.roster()?.sessions ?? []).filter((s) => s.parent === callsign).map((s) => s.callsign));
  const servers = useLoad(() => (live && canCall ? app.read<Server[]>("session.call", { callsign, method: "mcpServerStatus", args: [] }) : Promise.resolve({ ok: false as const, error: "" })), [callsign, live, canCall]);
  const [links, setLinks] = useState<Record<string, string>>({});

  async function call(method: string, name: string, extra: unknown[] = []) {
    const r = await app.request<{ authUrl?: string } | null>("session.call", { callsign, method, args: [name, ...extra] });
    if (!r.ok) {
      app.toast(`${callsign}: ${method}: ${r.error}`);
      return null;
    }
    return r;
  }
  async function act(method: string, name: string, extra?: unknown[]) {
    if (await call(method, name, extra)) servers.reload();
  }
  async function login(name: string) {
    const r = await call("mcpAuthenticate", name);
    if (!r) return;
    if (r.result?.authUrl) setLinks((l) => ({ ...l, [name]: r.result!.authUrl! }));
    else app.toast(`${callsign}: mcpAuthenticate: ссылки нет`);
  }

  if (!session) return <aside className="cw-info" aria-label="Сведения" />;
  return (
    <aside className="cw-info" aria-label="Сведения">
      <div>
        <h4>Сведения</h4>
        <dl className="cw-kv">
          {session.by ? (
            <>
              <dt>задачу дал</dt>
              <dd>{String(session.by)}</dd>
            </>
          ) : null}
          {session.dir ? (
            <>
              <dt>папка</dt>
              <dd>{String(session.dir)}</dd>
            </>
          ) : null}
          {profileNameOf(session) ? (
            <>
              <dt>профиль</dt>
              <dd>{profileNameOf(session)}</dd>
            </>
          ) : null}
        </dl>
      </div>
      {session.parent || kids.length ? (
        <div>
          <h4>Дерево</h4>
          <dl className="cw-kv">
            {session.parent ? (
              <>
                <dt>открыла</dt>
                <dd>{String(session.parent)}</dd>
              </>
            ) : null}
            {kids.length ? (
              <>
                <dt>ведёт</dt>
                <dd>
                  {kids.map((k) => (
                    <Btn key={k} ghost className="kid" onClick={() => app.open("card", { callsign: k })}>
                      {k}
                    </Btn>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
      {live && canCall ? (
        <div data-sec="mcp">
          <h4>Серверы MCP</h4>
          {servers.error ? (
            <Note tone="bad" data-refused="mcp">
              {servers.error}
            </Note>
          ) : null}
          {(servers.data ?? []).map(({ name, status }) => (
            <div key={name} className="cw-mcp">
              <div className="cw-sw">
                <span>{name}</span>
                <em className="cw-mcp-st" data-state={status}>
                  {WORDS[status] ?? status}
                </em>
                <Btn data-mcp={name} onClick={() => void act("toggleMcpServer", name, [status === "disabled"])}>
                  {status === "disabled" ? "вкл" : "выкл"}
                </Btn>
              </div>
              <div className="cw-mcp-a">
                {status === "disabled" ? null : (
                  <Btn ghost data-mcp-re={name} onClick={() => void act("reconnectMcpServer", name)}>
                    Переподключить
                  </Btn>
                )}
                {status === "needs-auth" ? (
                  <Btn ghost data-mcp-login={name} onClick={() => void login(name)}>
                    Войти
                  </Btn>
                ) : null}
                {links[name] ? (
                  <LinkBtn ghost data-mcp-url={name} href={links[name]} target="_blank" rel="noopener noreferrer">
                    Открыть страницу входа ↗
                  </LinkBtn>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {remoteOf(session) ? (
        <div className="cw-mcp-a">
          <a className="cw-mi flat" href={remoteOf(session)} target="_blank" rel="noopener">
            Открыть в claude.ai ↗
          </a>
        </div>
      ) : null}
    </aside>
  );
}
