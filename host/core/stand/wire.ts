// Провод поддельного claude: строки JSON между поддельным SDK и поддельным процессом у поддельного keeper.
// Сообщения SDK идут как есть; служебные строки — с полем "$".
//   SDK → процесс: initialize · user · interrupt · permission · hook_result · elicit_result
//   процесс → SDK: initialized · can_use_tool · hook · elicit
export type Wire =
  | { $: "initialize"; hooks: string[] }
  | { $: "user"; message: unknown }
  | { $: "interrupt" }
  | { $: "permission"; toolUseID: string; result: unknown }
  | { $: "hook_result"; id: string; result: unknown[] }
  | { $: "elicit_result"; id: string; result: unknown }
  | { $: "initialized" }
  | { $: "can_use_tool"; tool: string; input: Record<string, unknown>; toolUseID: string }
  | { $: "hook"; id: string; event: string; input: Record<string, unknown>; toolUseID?: string }
  | { $: "elicit"; id: string; request: unknown };

/** Делит поток байт на строки JSON. */
export function lineReader(onLine: (x: any) => void): (b: Buffer | string) => void {
  let buf = "";
  return (b) => {
    buf += typeof b === "string" ? b : b.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const t = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (t) onLine(JSON.parse(t));
    }
  };
}
