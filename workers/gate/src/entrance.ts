// Снесено: заглушка входа, реализация пишется заново.
import type { Frame } from "@switchboard/protocol";
import type { GateApi } from "../contract.ts";

export async function entrance(_req: Request, _gate: GateApi, _frame: (f: Frame) => Frame[] | Promise<Frame[]>, _log?: (line: string) => void): Promise<Response> {
  return new Response("снесено", { status: 500 });
}
