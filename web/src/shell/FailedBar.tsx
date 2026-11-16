// Полоса отказов чтения: экран читает данные, чтение не прошло, а своего блока с причиной у экрана нет — строка наверху: запрос, адресат, причина.
// Своего списка у полосы нет: она показывает кэш чтений страницы — запросы в отказе, у которых есть читатель. Чтение прошло или экран закрыт — строки нет.
// Отказ, чья причина уже стоит на экране блоком «Повторить», полоса не повторяет; когда связи нет, говорит полоса связи — одна на всё.
import { CallError } from "@sb/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { sayError } from "../api.ts";
import { useInPlace } from "../common.tsx";

/** Строки полосы: по одной на отказавшее чтение. */
export function failedReads(qc: QueryClient, inPlace: readonly unknown[]): string[] {
  const rows = qc
    .getQueryCache()
    .findAll({ predicate: (q) => q.state.status === "error" && q.getObserversCount() > 0 })
    .filter((q) => !inPlace.includes(q.state.error) && !(q.state.error instanceof CallError && q.state.error.word === "offline"))
    .map((q) => {
      const [name, input] = q.queryKey as [string, { to?: unknown } | null | undefined];
      return `${name}${typeof input?.to === "string" ? ` · ${input.to}` : ""} — ${sayError(q.state.error)}`;
    });
  return [...new Set(rows)];
}

export function FailedBar() {
  const qc = useQueryClient();
  const inPlace = useInPlace((s) => s.errors);
  const rows = useSyncExternalStore((on) => qc.getQueryCache().subscribe(on), () => JSON.stringify(failedReads(qc, inPlace)));
  return <>{(JSON.parse(rows) as string[]).map((row) => <div key={row} className="banner bad" role="alert">Не загрузилось: {row}</div>)}</>;
}
