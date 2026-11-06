// Образец ленты для галереи стенда: сообщения SDK той же свёрткой и теми же строками, что и лента; кнопки молчат.
import { useMemo } from "react";
import { fold, type Msg } from "./fold.ts";
import { EnvCtx, type Env } from "./view/env.ts";
import { Rows } from "./view/Rows.tsx";

const quiet = () => {};

export function Sample({ msgs }: { msgs: Msg[] }) {
  const env = useMemo<Env>(() => ({ cs: "site@laptop", wide: true, canAct: true, view: fold(msgs), sends: {}, rewind: null, label: "site", waiting: () => false, act: quiet, again: quiet, cancel: quiet, probe: quiet, apply: quiet, cancelRewind: quiet, fill: quiet }), [msgs]);
  return (
    <EnvCtx.Provider value={env}>
      <Rows rows={env.view.rows} />
    </EnvCtx.Provider>
  );
}
