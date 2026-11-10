// Запросы, которых в договоре может ещё не быть: сервер добавляет их своей волной. Есть в договоре — берётся оттуда, нет — описан здесь,
// и до выкладки сервера на них отвечает только мок. Форма — та, которую ждёт страница.
import { contract, request, z, type RequestDef } from "@sb/protocol";

function have<I, O>(name: string, make: () => RequestDef<I, O>): RequestDef<I, O> {
  return (contract.request(name) as RequestDef<I, O> | undefined) ?? make();
}

/** Ссылка на файл Keeper сборки флота для человека: с ней ставят новую машину. */
export const buildsLink = have("builds.keeper", () =>
  request("builds.keeper", {
    owner: "builds", target: "service",
    input: z.object({ os: z.enum(["windows", "linux"]), arch: z.string().optional() }),
    output: z.object({ build: z.number(), file: z.string(), url: z.string(), sha256: z.string(), command: z.string().optional() }),
  }),
);
