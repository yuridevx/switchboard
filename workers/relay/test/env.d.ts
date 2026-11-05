// Привязки relay в тестах: настоящие из wrangler.test.jsonc плюс методы управления поддельных Worker.
declare namespace Cloudflare {
  interface Env {
    FLEET: DurableObjectNamespace;
    GATE: import("@switchboard/gate").GateApi & { setMode(m: string): Promise<void>; calls(): Promise<string[]>; clear(): Promise<void> };
    PROTO: number[];
    GATE_DB: D1Database;
    GATE_MIGRATIONS: import("cloudflare:test").D1Migration[];
    LEDGER: { setMode(m: string): Promise<void>; received(): Promise<Record<string, any>[]>; clear(): Promise<void> };
  }
}
