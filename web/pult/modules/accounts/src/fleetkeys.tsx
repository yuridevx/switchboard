// Ключи флота: ключ API — один раз на весь флот, слот на любой машине. Форма спрашивает адрес, ключ и модели и собирает из них переменные окружения;
// свои переменные и настройки Claude — в «Дополнительно». Форма встаёт на место списка: строки не сдвигаются.
import { useState } from "react";
import { Btn, Confirm, In, machineLabel, machinesWith, modelEnv, MODELS, Note, plural, slotOf, useApp, useLoad, type FleetKey, type FleetKeysAnswer } from "@switchboard/web-ui";

type Pair = { k: string; v: string };
const URL_ENV = "ANTHROPIC_BASE_URL";
const ASKED = new Set<string>([URL_ENV, ...MODELS.map(modelEnv)]);
const extraOf = (env: Record<string, string>): Pair[] => Object.entries(env).filter(([k]) => !ASKED.has(k)).map(([k, v]) => ({ k, v }));

type Form = { name: string; key: string; url: string; models: Record<string, string>; env: Pair[]; settings: string; edit: boolean };
/** новый ключ — окно 200K: у чужой модели окна в миллион нет */
const NEW: Form = { name: "", key: "", url: "", models: {}, env: [{ k: "CLAUDE_CODE_DISABLE_1M_CONTEXT", v: "1" }], settings: "", edit: false };
const formOf = (name: string, k: FleetKey): Form => ({
  name,
  key: "",
  url: k.env[URL_ENV] ?? "",
  models: Object.fromEntries(MODELS.map((m) => [m, k.env[modelEnv(m)] ?? ""])),
  env: extraOf(k.env),
  settings: Object.keys(k.settings).length ? JSON.stringify(k.settings, null, 2) : "",
  edit: true,
});
const envOf = (f: Form): Record<string, string> => ({
  ...(f.url.trim() ? { [URL_ENV]: f.url.trim() } : {}),
  ...Object.fromEntries(MODELS.filter((m) => f.models[m]?.trim()).map((m) => [modelEnv(m), f.models[m].trim()])),
  ...Object.fromEntries(f.env.filter((p) => p.k.trim()).map((p) => [p.k.trim(), p.v])),
});

function KeyForm({ form, set, save, cancel, error }: { form: Form; set(f: Form): void; save(): void; cancel(): void; error: string }) {
  const row = (i: number, p: Partial<Pair>) => set({ ...form, env: form.env.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="ac-kform" data-key-form={form.edit ? form.name : ""}>
      <div className="ac-kgrid">
        <label>
          <span>Имя</span>
          <In mono data-f="kname" value={form.name} disabled={form.edit} onChange={() => {}} onInput={(e) => set({ ...form, name: e.currentTarget.value })} />
        </label>
        <label>
          <span>Значение ключа</span>
          <In mono type="password" data-f="kkey" value={form.key} placeholder={form.edit ? "прежний" : ""} onChange={() => {}} onInput={(e) => set({ ...form, key: e.currentTarget.value })} />
        </label>
        <label className="ac-kwide">
          <span>Адрес</span>
          <In mono data-f="kurl" value={form.url} placeholder="https://" onChange={() => {}} onInput={(e) => set({ ...form, url: e.currentTarget.value })} />
        </label>
        {MODELS.map((m) => (
          <label key={m}>
            <span>{`Модель вместо ${m}`}</span>
            <In mono data-f={`km-${m}`} value={form.models[m] ?? ""} onChange={() => {}} onInput={(e) => set({ ...form, models: { ...form.models, [m]: e.currentTarget.value } })} />
          </label>
        ))}
      </div>
      <div className="ac-kh2">Дополнительно</div>
      <div className="ac-kfield">
        <span>Свои переменные окружения</span>
        <div className="ac-kenv">
          {form.env.map((p, i) => (
            <div key={i} className="ac-kpair" data-env-row={i}>
              <In mono data-f={`ek-${i}`} aria-label="имя переменной" value={p.k} onChange={() => {}} onInput={(e) => row(i, { k: e.currentTarget.value })} />
              <span>=</span>
              <In mono data-f={`ev-${i}`} aria-label="значение" value={p.v} onChange={() => {}} onInput={(e) => row(i, { v: e.currentTarget.value })} />
              <button type="button" className="ac-kx" aria-label={`убрать ${p.k}`} onClick={() => set({ ...form, env: form.env.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <Btn dash data-act="env-add" onClick={() => set({ ...form, env: [...form.env, { k: "", v: "" }] })}>
            ＋ переменная
          </Btn>
        </div>
      </div>
      <label className="ac-kfield">
        <span>Настройки Claude поверх профиля</span>
        <textarea className={error ? "ac-json bad" : "ac-json"} data-f="ksettings" spellCheck={false} rows={4} placeholder='{ "modelOverrides": { … } }' value={form.settings} onChange={() => {}} onInput={(e) => set({ ...form, settings: e.currentTarget.value })} />
      </label>
      {error ? <span className="ac-kerr" role="alert">{error}</span> : null}
      <div className="ac-kbtn">
        <Btn onClick={cancel}>Отмена</Btn>
        <Btn pri data-act="key-save" disabled={!form.name.trim() || (!form.edit && !form.key)} onClick={save}>
          Сохранить
        </Btn>
      </div>
    </div>
  );
}

function KeyLine({ name, k, users, edit, remove }: { name: string; k: FleetKey; users: string[]; edit(): void; remove(): void }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; word: string } | null>(null);
  /** ключ проверяет машина: запрос уходит с неё, как уйдёт у сессии */
  const machine = app.use(() => machinesWith(app, "machine.key_check"))[0];
  const models = MODELS.filter((m) => k.env[modelEnv(m)]);
  const extra = extraOf(k.env);
  async function check() {
    setChecking(true);
    setChecked(null);
    const r = await app.request<{ ok: boolean; word: string }>("machine.key_check", { machine, name });
    setChecking(false);
    const from = machineLabel(app, machine).text;
    setChecked(r.ok ? { ...r.result, word: `${from}: ${r.result.word}` } : { ok: false, word: `machine.key_check: ${r.error}` });
  }
  return (
    <div className="ac-key" data-key={name}>
      <span className="ac-id">
        <b className="ac-kn">{name}</b>
        <small>{`${users.length} ${plural(users.length, "сессия", "сессии", "сессий")}`}</small>
      </span>
      <div className="ac-kbody">
        {k.env[URL_ENV] ? <code>{k.env[URL_ENV]}</code> : null}
        {models.length ? (
          <div className="ac-kline">
            {models.map((m) => (
              <span key={m}>
                <i>{m}</i>
                <code>{k.env[modelEnv(m)]}</code>
              </span>
            ))}
          </div>
        ) : null}
        {extra.length || Object.keys(k.settings).length ? (
          <div className="ac-kline ac-kdim">
            {extra.map((p) => (
              <code key={p.k}>{`${p.k}=${p.v}`}</code>
            ))}
            {Object.keys(k.settings).length ? <code>{JSON.stringify(k.settings)}</code> : null}
          </div>
        ) : null}
        {checked ? <span className={checked.ok ? "ac-kres" : "ac-kres bad"} data-checked="" role="status">{checked.word}</span> : null}
      </div>
      <span className="ac-kact">
        <Btn data-act="key-check" disabled={checking || !machine} onClick={() => void check()}>
          {checking ? "Проверяю…" : "Проверить ключ"}
        </Btn>
        <Btn data-act="key-edit" onClick={edit}>
          Изменить
        </Btn>
        <Btn bad data-act="key-remove" onClick={() => setAsking(true)}>
          Удалить…
        </Btn>
      </span>
      {asking ? (
        <div className="ac-kask">
          <Confirm
            text={`Удалить ключ ${name}? ${users.length ? `${users.length} ${plural(users.length, "сессия потеряет", "сессии потеряют", "сессий потеряют")} его на следующем старте: ${users.join(", ")}` : "Сессии им не пользуются."}`}
            act="Удалить"
            cancel={() => setAsking(false)}
            run={remove}
          />
        </div>
      ) : null}
    </div>
  );
}

export function FleetKeys() {
  const app = useApp();
  const list = useLoad<FleetKeysAnswer>(() => app.read<FleetKeysAnswer>("fleetkeys.list", {}), []);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const keys = Object.entries(list.data?.keys ?? {});
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const using = (name: string) => sessions.filter((s) => slotOf(s)?.name === name).map((s) => s.callsign);
  const open = (f: Form) => {
    setForm(f);
    setError("");
  };

  async function save() {
    if (!form) return;
    let settings: Record<string, unknown> | undefined;
    if (form.settings.trim()) {
      try {
        settings = JSON.parse(form.settings);
      } catch {
        return setError("В настройках ошибка: это не JSON. Проверьте скобки и кавычки.");
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return setError("Настройки — объект в фигурных скобках: { … }");
    }
    const r = await app.request("fleetkeys.set", { name: form.name.trim(), env: envOf(form), ...(settings ? { settings } : {}), ...(form.key ? { value: form.key } : {}) });
    if (!r.ok) return setError(`fleetkeys.set: ${r.error}${(r as { why?: string }).why ? ` — ${(r as { why?: string }).why}` : ""}`);
    app.toast(`ключ ${form.name} сохранён`, "ok");
    setForm(null);
    list.reload();
  }
  if (form) {
    return (
      <div className="ac-keys" data-fleet-keys="">
        <KeyForm form={form} set={setForm} save={() => void save()} cancel={() => setForm(null)} error={error} />
      </div>
    );
  }
  return (
    <div className="ac-keys" data-fleet-keys="">
      {list.error ? <Note tone="bad">{`fleetkeys.list: ${list.error}`}</Note> : null}
      {keys.map(([name, k]) => (
        <KeyLine
          key={name}
          name={name}
          k={k}
          users={using(name)}
          edit={() => open(formOf(name, k))}
          remove={() =>
            void app.request("fleetkeys.remove", { name }).then((r) => {
              app.toast(r.ok ? `ключ ${name} удалён` : `fleetkeys.remove: ${r.error}`, r.ok ? "ok" : "bad");
              list.reload();
            })
          }
        />
      ))}
      <div className="ac-kh">
        <Btn dash data-act="key-new" onClick={() => open(NEW)}>
          ＋ ключ
        </Btn>
      </div>
    </div>
  );
}
