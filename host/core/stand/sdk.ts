// Поддельный Agent SDK: query() как у настоящего — процесс через spawnClaudeCodeProcess (канал keeper),
// initialize в начале, ввод из очереди, сообщения из вывода процесса, canUseTool, хуки и формы MCP — внутри Host.
// Методы query записываются в calls; close() закрывает ввод процесса, как настоящий SDK.
import type { Options, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { lineReader } from "./wire.ts";
import type { Wire } from "./wire.ts";

type Params = { prompt: AsyncIterable<SDKUserMessage>; options?: Options };

export class FakeQuery {
  readonly options: Options;
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  proc: SpawnedProcess | null = null;
  closed = false;
  private buf: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private init: Promise<Record<string, unknown>>;
  private initOk!: (r: Record<string, unknown>) => void;
  private initFail!: (e: Error) => void;
  private initDone = false;
  private mcp: Set<string>;

  constructor(p: Params) {
    this.options = p.options ?? {};
    this.mcp = new Set(Object.keys(this.options.mcpServers ?? {}));
    this.init = new Promise((res, rej) => {
      this.initOk = res;
      this.initFail = rej;
    });
    this.init.catch(() => {});
    const spawn = this.options.spawnClaudeCodeProcess;
    if (!spawn) {
      // проба без процесса у keeper
      this.initDone = true;
      this.initOk({});
    } else {
      const proc = spawn({ command: "claude", args: ["--output-format", "stream-json"], cwd: this.options.cwd, env: this.options.env ?? {}, signal: new AbortController().signal });
      this.proc = proc;
      proc.stdout.on("data", lineReader((x) => this.fromProc(x)));
      proc.stdout.on("end", () => this.end());
      proc.on("exit", () => this.end());
      proc.on("error", () => this.end());
      this.write({ $: "initialize", hooks: Object.keys(this.options.hooks ?? {}) });
    }
    void (async () => {
      for await (const m of p.prompt) {
        if (this.closed) return;
        this.write({ $: "user", message: m });
      }
    })();
  }

  /** process id канала keeper: callsign сессии */
  get id(): string | undefined {
    return (this.proc as unknown as { id?: string } | null)?.id;
  }

  private write(x: Wire): void {
    if (this.proc && !this.proc.stdin.writableEnded) this.proc.stdin.write(JSON.stringify(x) + "\n");
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.initDone) this.initFail(new Error("процесс claude вышел до initialize"));
    this.wake?.();
  }

  private async fromProc(x: Record<string, any>): Promise<void> {
    const o = this.options;
    if (!("$" in x)) {
      this.buf.push(x);
      this.wake?.();
      return;
    }
    if (x.$ === "initialized") {
      this.initDone = true;
      this.initOk({ commands: [], models: [], account: {} });
    } else if (x.$ === "can_use_tool") {
      const r = await o.canUseTool!(x.tool, x.input, { signal: new AbortController().signal, toolUseID: x.toolUseID } as never);
      this.write({ $: "permission", toolUseID: x.toolUseID, result: r });
    } else if (x.$ === "hook") {
      const out: unknown[] = [];
      for (const m of o.hooks?.[x.event as keyof NonNullable<Options["hooks"]>] ?? []) {
        if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(String(x.input.tool_name ?? ""))) continue;
        for (const h of m.hooks) out.push(await h(x.input, x.toolUseID, { signal: new AbortController().signal }));
      }
      this.write({ $: "hook_result", id: x.id, result: out });
    } else if (x.$ === "elicit") {
      const r = await o.onElicitation!(x.request, { signal: new AbortController().signal, requestId: x.id });
      this.write({ $: "elicit_result", id: x.id, result: r });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any, void> {
    for (;;) {
      while (this.buf.length) yield this.buf.shift();
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }

  initializationResult(): Promise<Record<string, unknown>> {
    return this.init;
  }

  async interrupt(): Promise<void> {
    this.calls.push({ name: "interrupt", args: [] });
    this.write({ $: "interrupt" });
  }

  async setMcpServers(servers: Record<string, unknown>) {
    this.calls.push({ name: "setMcpServers", args: [servers] });
    const next = new Set(Object.keys(servers));
    const added = [...next].filter((n) => !this.mcp.has(n));
    const removed = [...this.mcp].filter((n) => !next.has(n));
    this.mcp = next;
    return { added, removed, errors: {} };
  }

  /** close: ввод процесса закрыт — keeper закрывает ввод claude, процесс выходит сам. */
  close(): void {
    this.calls.push({ name: "close", args: [] });
    this.closed = true;
    if (this.proc) this.proc.stdin.end();
    else this.end();
  }
}

const RECORDED = [
  "setModel", "applyFlagSettings", "getContextUsage", "supportedCommands", "supportedModels", "supportedAgents",
  "mcpServerStatus", "setPermissionMode", "setMaxThinkingTokens", "toggleMcpServer", "reconnectMcpServer", "rewindFiles",
  "stopTask", "backgroundTasks", "renameSession", "enableRemoteControl", "claudeAuthenticate", "claudeOAuthCallback", "claudeOAuthWaitForCompletion", "accountInfo",
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
];
for (const name of RECORDED) {
  (FakeQuery.prototype as unknown as Record<string, unknown>)[name] = async function (this: FakeQuery, ...args: unknown[]) {
    this.calls.push({ name, args });
    return {};
  };
}

/** Поддельный SDK: query(), функции сессии и команда claude. Всё вызванное — в журналах для проверок. */
export class FakeSdk {
  readonly version: string;
  readonly queries: FakeQuery[] = [];
  readonly fnCalls: Array<{ name: string; args: unknown[] }> = [];
  /** разговоры без файла: claude ещё не прошёл первый ход */
  readonly noFile = new Set<string>();
  readonly cliCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];

  constructor(version = "0.3.311") {
    this.version = version;
  }

  query = (p: Params) => {
    const q = new FakeQuery(p);
    this.queries.push(q);
    return q as never;
  };

  functions = new Proxy({} as Record<string, (...a: unknown[]) => Promise<unknown>>, {
    get: (_t, name: string) => async (...args: unknown[]) => {
      this.fnCalls.push({ name, args });
      if (name === "getSessionInfo" && this.noFile.has(args[0] as string)) return undefined;
      return name === "getSessionMessages" ? [] : {};
    },
  });

  cli = async (args: string[], env: Record<string, string | undefined>) => {
    this.cliCalls.push({ args, env });
    return { code: 0, out: "" };
  };

  /** Все query() сессии по порядку запуска. */
  of(callsign: string): FakeQuery[] {
    return this.queries.filter((q) => q.id === callsign);
  }

  /** Нынешний query() сессии. */
  last(callsign: string): FakeQuery | undefined {
    return this.of(callsign).at(-1);
  }
}
