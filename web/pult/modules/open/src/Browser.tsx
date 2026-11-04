// Проводник новой сессии: машины, последние места, адрес и папки родителя.
import type {} from "@switchboard/web-labels";
import { useOpen } from "./store.ts";
import { addrView, dirOfAddr, HOME, into } from "./form.ts";
import type { OpenForm } from "./useOpenForm.ts";
import { machineLabel, useApp } from "@switchboard/web-ui";

/** Имя машины: человеческое из меток, иначе адрес. Выборка: новое имя перерисует вызвавшего. */
export function useMachineLabels() {
  const app = useApp();
  const labels = app.use(() => Object.fromEntries((app.roster()?.machines ?? []).map((m) => [m.machine, machineLabel(app, m.machine)])));
  return (m: string) => labels[m] ?? machineLabel(app, m);
}

export function MachinesPane({ form }: { form: OpenForm }) {
  const app = useApp();
  const open = useOpen();
  const { f, online, pick } = form;
  const label = useMachineLabels();
  // порядок — по числу сессий: выборка следит за roster
  const sorted = app.use(() => open.byUse(online));
  return (
    <div className="op-bl" role="listbox" aria-label="Машины">
      {sorted.length ? (
        sorted.map((m) => {
          const l = label(m);
          return (
            <button key={m} role="option" aria-selected={f.machine === m} data-machine={m} onClick={() => pick(m, m === f.machine ? f.addr : HOME)}>
              <b className={l.human ? "hum" : undefined}>{l.text}</b>
            </button>
          );
        })
      ) : (
        <span className="op-none">машин нет</span>
      )}
    </div>
  );
}

export function FolderPane({ form }: { form: OpenForm }) {
  const app = useApp();
  const open = useOpen();
  const { f, set, online, pick, setAddr, start } = form;
  const label = useMachineLabels();
  const recents = app.use(open.recents);
  const { parent, tail, listed, shown, isNew } = addrView(f);
  const places = [{ m: f.machine, dir: HOME }, ...recents].filter((x, i, all) => online.includes(x.m) && all.findIndex((y) => y.m === x.m && y.dir === x.dir) === i);
  return (
    <div className="op-bf">
      {app.wide ? null : (
        <button className="op-bk" data-act="pick-machine" aria-expanded={f.pickM} onClick={() => set({ pickM: !f.pickM })}>
          {f.machine ? label(f.machine).text : "машина"}
        </button>
      )}
      {app.wide || !f.pickM ? null : <MachinesPane form={form} />}
      {places.length > 1 ? (
        <div className="op-rec" aria-label="Последние места">
          {places.map((x) => (
            <button key={`${x.m}|${x.dir}`} data-place={x.dir} data-place-machine={x.m} aria-pressed={x.m === f.machine && x.dir === dirOfAddr(f.addr)} onClick={() => pick(x.m, x.dir)}>
              {x.m === f.machine ? x.dir : `${label(x.m).text} ${x.dir}`}
            </button>
          ))}
        </div>
      ) : null}
      <input
        data-f="addr"
        value={f.addr}
        autoComplete="off"
        spellCheck={false}
        aria-label="Адрес папки"
        disabled={!f.machine}
        onInput={(e) => setAddr(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.shiftKey && shown.length && tail) {
            e.preventDefault();
            setAddr(into(parent, shown[0]));
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
        }}
      />
      {isNew ? (
        <div className="op-new" data-mark="new">
          новая папка, будет создана
        </div>
      ) : null}
      {listed?.word && listed.word !== "not_found" ? <div className="op-new">{listed.word === "no_access" ? "нет доступа к этой папке" : `machine.dirs: ${listed.word}`}</div> : null}
      <div className="op-dl">
        {shown.map((d) => (
          <button key={d} data-dir={d} onClick={() => setAddr(into(parent, d))}>
            <span>{`▸ ${d}`}</span>
          </button>
        ))}
        {!shown.length && listed && !listed.word && !isNew ? <span className="op-none">пусто</span> : null}
      </div>
    </div>
  );
}
