import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Host, McpServerConfig, Module, Session } from "@switchboard/host";
import { kindOf, READ_MS, withLimit } from "@switchboard/protocol";
import { FLEET_PREFIX, settings } from "@switchboard/records";
import type { Settings } from "@switchboard/records";
import { prompt } from "./prompt.ts";
import { toolsOf } from "./tools.ts";

/** Пропуск сессии для сервера MCP флота: раздел сессии модуля fleet. */
type Pass = { kid: string; key: string };

type TurnEnd = { type: string; subtype?: string; is_error?: boolean; result?: string };

/** Текст итога хода: что уйдёт родителю. */
function outcome({ subtype, is_error: failed, result }: TurnEnd): string {
  if (failed && result) return `ход кончился ошибкой: ${result}`;
  return failed || subtype !== "success" ? `ход кончился: ${subtype}` : (result ?? "");
}

export function make() {
  let host: Host;
  let records: Settings;

  const tools = (me: string) => toolsOf(me, () => ({ host, records }));

  /** Родителю без смены того, кто дал ему задачу. */
  function tell(s: Session, parent: string, text: string, lost: string): void {
    const { callsign } = s.info;
    void host.request("message", { to: parent, text, report: true, from: callsign }).then((r) => {
      if (!r.ok) host.log({ kind: "note", ev: "report", word: r.error, callsign, why: `${lost}: ${r.error}` });
    });
  }

  const parentOf = (s: Session) => s.field("parent") as string | undefined;

  /** Ход кончился, а начал его родитель, — итог ему сам. */
  function report(s: Session, end: TurnEnd): void {
    const parent = parentOf(s);
    if (parent && parent === s.info.from && kindOf(parent) === "session") tell(s, parent, outcome(end), `итог хода родителю ${parent} не доставлен`);
  }

  /** Ведомый поднялся впервые: ведущий узнаёт, кто он. Пара сразу и пара позже идут одним путём. */
  function introduce(s: Session): void {
    const parent = parentOf(s);
    if (s.info.start !== "spawn" || !s.field("wing") || !parent) return;
    const slot = (s.field("slot") as { name?: string } | undefined)?.name;
    const pieces = ((s.field("profile") as Array<{ id: string }> | undefined) ?? []).map((p) => p.id);
    const said = [s.field("model"), s.field("effort"), slot, ...pieces].filter(Boolean);
    tell(s, parent, `ведомый ${s.info.callsign} поднят${said.length ? `: ${said.join(", ")}` : ""}. Задачу ему — fleet.send, итог его хода придёт сам.`, `весть о ведомом родителю ${parent} не доставлена`);
  }

  /** Процесс ведомого умер посреди хода ведущего: итога не будет, ход не повторяется. */
  function broken(s: Session): void {
    const parent = parentOf(s);
    if (!s.field("wing") || !parent || parent !== s.info.from || (s.state !== "busy" && s.state !== "waiting")) return;
    tell(s, parent, `ход ведомого ${s.info.callsign} оборвался: процесс вышел, ход не повторяется`, `слово об обрыве родителю ${parent} не доставлено`);
  }

  /**
   * Пропуск сессии — один раз: keys.invite с адресом сессии и сразу gate.redeem, тот же путь, что у любого устройства; дальше — из раздела,
   * без сети. Отказ — строка журнала, сессия идёт без сервера switchboard.
   */
  async function passOf(s: Session): Promise<Pass | null> {
    const store = s.store<Pass>();
    const had = store.get();
    if (had) return had;
    const { callsign } = s.info;
    const refused = (step: string, r: { error: string; why?: unknown }) => {
      host.log({ kind: "refuse", ev: "session.pass", word: r.error, callsign, why: `${step}: ${r.why ?? r.error}` });
      return null;
    };
    const inv = await host.request("keys.invite", { addr: callsign });
    if (!inv.ok) return refused("keys.invite", inv as { error: string; why?: unknown });
    const { invite, kid } = inv.result as { invite: string; kid: string };
    const got = await host.request("gate.redeem", { invite });
    if (!got.ok) return refused("gate.redeem", got as { error: string; why?: unknown });
    const pass = { kid, key: (got.result as { key: string }).key };
    store.set(pass);
    host.log({ kind: "note", ev: "session.pass", callsign, why: `пропуск ${kid}` });
    return pass;
  }

  /** Сервер MCP флота в mcpServers сессии: документированная опция SDK, HTTP с заголовком; имя fleet уже у своего сервера. */
  async function switchboard(s: Session): Promise<Record<string, McpServerConfig>> {
    const mcp = host.worker("mcp");
    // предел меньше предела вклада ядра: молчание gate не выключает fleet в сессии, сессия идёт без сервера switchboard
    const late = () => (host.log({ kind: "refuse", ev: "session.pass", word: "timeout", callsign: s.info.callsign, why: `пропуск не выдан за ${READ_MS / 1000} с` }), null);
    const pass = mcp ? await withLimit(passOf(s), READ_MS, late) : null;
    return mcp && pass ? { switchboard: { type: "http" as const, url: `${mcp.replace(/\/$/, "")}/mcp`, headers: { Authorization: `Bearer ${pass.key}` } } } : {};
  }

  /** Сессию убрали — её пропуск отозван. */
  function revoke(s: Session): void {
    const pass = s.store<Pass>().get();
    if (!pass) return;
    const { callsign } = s.info;
    void host.request("keys.revoke", { kid: pass.kid }).then((r) => {
      if (!r.ok) host.log({ kind: "refuse", ev: "session.pass", word: r.error, callsign, why: `отзыв ${pass.kid}: ${r.error}` });
    });
  }

  const module: Module = {
    start(h) {
      host = h;
      records = settings({ read: (name, body) => h.read(name, body) as never, ask: (name, body) => h.request(name, body) as never, prefix: FLEET_PREFIX, scope: "global" });
    },
    stop: () => records.settled(),
    requests: {
      // просмотр профиля не знает сессии: в тексте имя-пример
      "fleet.prompt": () => ({ text: prompt(`сессия@${host.machine}`) }),
    },
    async session(s) {
      const { callsign } = s.info;
      // сессии говорят друг с другом только через fleet (слово пользователя 1 нояб.)
      const env = { CLAUDE_CODE_HARBOR_KITE: "0" };
      // ведомый снаружи не виден: задача приходит вводом, итог уходит сам, инструменты вынесли бы его адрес наружу
      if (s.field("wing")) return { env };
      return { mcpServers: { fleet: createSdkMcpServer({ name: "fleet", tools: tools(callsign) }), ...(await switchboard(s)) }, append: prompt(callsign), env };
    },
    on: {
      event(s, msg) {
        if (msg.type === "result") report(s, msg as TurnEnd);
      },
      open: introduce,
      close: broken,
      remove: revoke,
    },
  };

  return { module, tools };
}
