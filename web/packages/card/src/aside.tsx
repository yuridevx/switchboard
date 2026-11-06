// Сведения сбоку: кто дал задачу, дерево, серверы MCP.
import { useState } from "react";
import { Btn, isLive, LinkBtn, Note, profileNameOf, remoteOf, sessionOf, useApp, useMachineLoad } from "@switchboard/web-ui";

type Server = { name: string; status: string };
const STATUS: Record<string, string> = { pending: "подключается", disabled: "выключен", "needs-auth": "нужен вход", connected: "подключён", failed: "ошибка" };

function Servers({ callsign, machine }: { callsign: string; machine: string }) {
  const app = useApp();
  const live = app.use(() => isLive(sessionOf(app, callsign)?.state));
  const can = app.use(() => app.can(machine, "session.call") === true);
  const list = useMachineLoad<Server[]>(machine, "session.call", { callsign, method: "mcpServerStatus", args: [] }, live);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const call = async <T,>(method: string, name: string, ...rest: unknown[]) => {
    const r = await app.request<T>("session.call", { callsign, method, args: [name, ...rest] });
    if (!r.ok) app.toast(`${callsign}: ${method}: ${r.error}`);
    return r;
  };
  const change = async (method: string, name: string, ...rest: unknown[]) => {
    if ((await call(method, name, ...rest)).ok) list.reload();
  };
  async function login(name: string) {
    const r = await call<{ authUrl?: string }>("mcpAuthenticate", name);
    if (!r.ok) return;
    if (r.result?.authUrl) setUrls({ ...urls, [name]: r.result.authUrl });
    else app.toast(`${callsign}: mcpAuthenticate: ссылки нет`);
  }
  if (!live || !can) return null;
  return (
    <section data-sec="mcp">
      <h4>Серверы MCP</h4>
      {list.error && (
        <Note tone="bad" data-refused="mcp">
          {list.error}
        </Note>
      )}
      {list.data?.map(({ name, status }) => (
        <div key={name} className="cw-mcp">
          <div className="cw-sw">
            <span>{name}</span>
            <em className="cw-mcp-st" data-state={status}>
              {STATUS[status] ?? status}
            </em>
          </div>
          <div className="cw-mcp-a">
            <Btn data-mcp={name} onClick={() => void change("toggleMcpServer", name, status === "disabled")}>
              {status === "disabled" ? "вкл" : "выкл"}
            </Btn>
            {status !== "disabled" && (
              <Btn ghost data-mcp-re={name} onClick={() => void change("reconnectMcpServer", name)}>
                Переподключить
              </Btn>
            )}
            {status === "needs-auth" && (
              <Btn ghost data-mcp-login={name} onClick={() => void login(name)}>
                Войти
              </Btn>
            )}
            {urls[name] && (
              <LinkBtn ghost data-mcp-url={name} href={urls[name]} target="_blank" rel="noopener noreferrer">
                Открыть страницу входа ↗
              </LinkBtn>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

export function Aside({ callsign, machine }: { callsign: string; machine: string }) {
  const app = useApp();
  const s = app.use(() => sessionOf(app, callsign));
  const kids = app.use(() => (app.roster()?.sessions ?? []).filter((x) => x.parent === callsign).map((x) => x.callsign));
  if (!s) return <aside className="cw-info" aria-label="Сведения" />;
  const remote = remoteOf(s);
  const tree = !!s.parent || kids.length > 0;
  return (
    <aside className="cw-info" aria-label="Сведения">
      <section>
        <h4>Сведения</h4>
        <dl className="cw-kv">
          {s.by ? (
            <>
              <dt>задачу дал</dt>
              <dd>{String(s.by)}</dd>
            </>
          ) : null}
          {s.dir ? (
            <>
              <dt>папка</dt>
              <dd>{String(s.dir)}</dd>
            </>
          ) : null}
          {profileNameOf(s) ? (
            <>
              <dt>профиль</dt>
              <dd>{profileNameOf(s)}</dd>
            </>
          ) : null}
        </dl>
        {remote && (
          <a className="cw-mi flat" href={remote} target="_blank" rel="noopener">
            Открыть в claude.ai ↗
          </a>
        )}
      </section>
      {tree && (
        <section>
          <h4>Дерево</h4>
          <dl className="cw-kv">
            {s.parent ? (
              <>
                <dt>открыла</dt>
                <dd>{String(s.parent)}</dd>
              </>
            ) : null}
          </dl>
          {kids.length > 0 && (
            <dl className="cw-kv">
              <dt>ведёт</dt>
              <dd>
                {kids.map((k) => (
                  <Btn key={k} ghost className="kid" onClick={() => app.open("card", { callsign: k })}>
                    {k}
                  </Btn>
                ))}
              </dd>
            </dl>
          )}
        </section>
      )}
      <Servers callsign={callsign} machine={machine} />
    </aside>
  );
}
