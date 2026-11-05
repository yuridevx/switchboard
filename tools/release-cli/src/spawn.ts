// Снесено: запуск процесса с пределом пишется заново.
export async function run(_cmd: string, _args: string[], _cwd: string, _o?: { limitMs?: number }): Promise<{ code: number | null; out: string }> {
  throw new Error("снесено");
}
