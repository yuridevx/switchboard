// Снесено.
export type ShellOptions = Record<string, unknown>;
export async function boot(_o: ShellOptions): Promise<void> {
  throw new Error("снесено");
}
