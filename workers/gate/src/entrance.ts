// снесено
export async function entrance(_req: Request, _gate: unknown, _handle: (f: never) => unknown, _log?: (line: string) => void): Promise<Response> {
  return new Response("снесено", { status: 501 });
}
