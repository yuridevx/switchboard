// Образец ленты для галереи стенда: сообщения SDK той же свёрткой и теми же строками, что и лента; кнопки молчат.
import { useMemo } from "react";
import { fold, type Msg } from "./fold.ts";
import type { Env } from "./store.ts";
import { EnvCtx, Rows } from "./view/Rows.tsx";

const silent = (view: Env["view"]): Env => ({
  callsign: "site@laptop",
  wide: true,
  view,
  send: () => undefined,
  rewind: () => null,
  canAct: () => true,
  label: (cs) => cs,
  waiting: () => false,
  act: () => {},
  again: () => {},
  cancel: () => {},
  probe: () => {},
  apply: () => {},
  cancelRewind: () => {},
  fill: () => {},
});

export function Sample({ msgs }: { msgs: Msg[] }) {
  const env = useMemo(() => {
    const view = fold(msgs);
    return { view, env: silent(() => view) };
  }, [msgs]);
  return (
    <EnvCtx.Provider value={env.env}>
      <Rows rows={env.view.rows} />
    </EnvCtx.Provider>
  );
}
