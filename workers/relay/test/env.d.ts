// Привязки relay в тестах: настоящие из wrangler.test.jsonc плюс методы управления поддельных Worker.
type Ctl = {
  setMode(m: string): Promise<void>;
  received(): Promise<Record<string, any>[]>;
  setReturn(fs: Record<string, unknown>[]): Promise<void>;
  setContract(c: Record<string, number>): Promise<void>;
  clear(): Promise<void>;
};
declare namespace Cloudflare {
  interface Env {
    FLEET: DurableObjectNamespace<import("../src/fleet.ts").Fleet>;
    GATE: import("@switchboard/gate").GateApi & { setMode(m: string): Promise<void>; calls(): Promise<string[]>; clear(): Promise<void>; revokeLater(ids: string[]): Promise<void> };
    PROTO: number[];
    PARTICIPANTS: Record<string, string>;
    OWNER: string;
    PUSH: Ctl;
    LEDGER: Ctl;
    AUDIT: Ctl;
    ECHO: Ctl;
  }
}
