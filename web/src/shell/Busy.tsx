// Знак «экран загрузился»: aria-busy у области экрана — true, пока идут чтения экрана или грузится его кусок сборки.
// Проверки страницы ждут этот знак, а не время: полоса отказов чтения и содержимое экрана читаются, когда чтения экрана ответили.
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { useLocation } from "react-router";
import { create } from "zustand";

/** Сколько ленивых экранов ещё грузят свой кусок сборки. */
const useLoading = create<{ n: number }>(() => ({ n: 0 }));

/** Заглушка ленивого экрана: пока грузится его кусок сборки, экран занят. */
export function Loading() {
  useLayoutEffect(() => {
    useLoading.setState((s) => ({ n: s.n + 1 }));
    return () => useLoading.setState((s) => ({ n: s.n - 1 }));
  }, []);
  return null;
}

/** Область экрана. Свободна с того адреса, на котором её эффект застал тишину: эффект области идёт после эффектов экрана внутри неё,
 *  и чтения экрана к этому времени уже начались. Новый адрес — снова занята до своего эффекта: прежнее «свободна» к нему не относится. */
export function Screen({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const at = useLocation().key;
  // перерисовать область, когда чтение началось или кончилось и когда кусок сборки догрузился
  useIsFetching();
  useLoading((s) => s.n);
  const [quiet, setQuiet] = useState<string | null>(null);
  useEffect(() => setQuiet(qc.isFetching() === 0 && useLoading.getState().n === 0 ? at : null));
  return <div className="screen" aria-busy={quiet !== at}>{children}</div>;
}
