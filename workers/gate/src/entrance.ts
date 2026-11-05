// Снесено: вход Worker'ов отказывает словом, пока не написан заново.
import type { Frame } from "@switchboard/protocol";
import type { GateApi } from "../contract.ts";

export async function entrance(_req: Request, _gate: GateApi, _frame: (f: Frame) => Frame[] | Promise<Frame[]>, _log?: (line: string) => void): Promise<Response> {
  return Response.json({ type: "reply", id: "", ok: false, error: "снесено" }, { status: 500 });
}
