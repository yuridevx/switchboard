// Договор — это код: запрос описан один раз, со схемой ввода и ответа. Им пользуются страница, Host, службы, сервер MCP и скрипты.
import { z } from "zod";

/** Куда идёт запрос: сессии, машине (Host), keeper машины, службе или объекту флота. */
export type Target = "session" | "machine" | "keeper" | "service" | "fleet";

export interface RequestDef<I = unknown, O = unknown> {
  kind: "request";
  name: string;
  /** модуль-хозяин: у имени один хозяин */
  owner: string;
  target: Target;
  /** только админ флота */
  admin?: boolean;
  /** только машина (Host или Keeper своим пропуском) */
  machineOnly?: boolean;
  /** без пропуска (приём приглашения) */
  open?: boolean;
  /** описание для модели: запрос с ним — инструмент сервера MCP */
  tool?: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
}

export interface FrameDef<P = unknown> {
  kind: "frame";
  name: string;
  owner: string;
  payload: z.ZodType<P>;
}

export type AnyDef = RequestDef<any, any> | FrameDef<any>;

const all = new Map<string, AnyDef>();

function add<D extends AnyDef>(d: D): D {
  const was = all.get(d.name);
  if (was) throw new Error(`имя ${d.name} уже у ${was.owner}, второй хозяин — ${d.owner}`);
  all.set(d.name, d);
  return d;
}

export function request<I, O>(
  name: string,
  d: { owner: string; target: Target; admin?: boolean; machineOnly?: boolean; open?: boolean; tool?: string; input: z.ZodType<I>; output: z.ZodType<O> },
): RequestDef<I, O> {
  return add({ kind: "request", name, ...d });
}

export function frame<P>(name: string, d: { owner: string; payload: z.ZodType<P> }): FrameDef<P> {
  return add({ kind: "frame", name, ...d });
}

/** Все имена договора. */
export const contract = {
  get: (name: string): AnyDef | undefined => all.get(name),
  request: (name: string): RequestDef | undefined => {
    const d = all.get(name);
    return d && d.kind === "request" ? d : undefined;
  },
  all: (): AnyDef[] => [...all.values()],
  tools: (): RequestDef[] => [...all.values()].filter((d): d is RequestDef => d.kind === "request" && !!d.tool),
};

export type InputOf<D> = D extends RequestDef<infer I, any> ? I : never;
export type OutputOf<D> = D extends RequestDef<any, infer O> ? O : never;

/* Общие схемы адресов */
export const Callsign = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}@[a-z0-9][a-z0-9_-]{0,62}$/i, "позывной вида site@laptop");
export const MachineAddr = z.string().regex(/^@[a-z0-9][a-z0-9_-]{0,62}$/i, "машина вида @laptop");
export const KeeperAddr = z.string().regex(/^\.keeper@[a-z0-9][a-z0-9_-]{0,62}$/i, "keeper вида .keeper@laptop");
export const Person = z.string().regex(/^~[^\s@~]+@[^\s@~]+\.[^\s@~]+$/, "человек вида ~a@b.c");
export const Device = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}~[^\s@~]+@[^\s@~]+\.[^\s@~]+$/i, "устройство вида pult~a@b.c");
export const Name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/i);
export const Empty = z.object({});
export const Done = z.object({}).loose();
export { z };
