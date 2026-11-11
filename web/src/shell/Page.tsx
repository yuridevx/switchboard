// Страница шага: форма, просмотр или подтверждение целой страницей вместо окна поверх экрана.
// Встаёт на место экрана в оболочке, пока открыта; в адресе — ?do=<имя шага>, «Назад» браузера её закрывает.
import { ActionIcon, Button, Group } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useInRouterContext, useLocation, useNavigate, useSearchParams } from "react-router";
import { create } from "zustand";

/** Сколько страниц шага открыто и ставили ли мы запись в историю браузера. */
const useSteps = create<{ n: number }>(() => ({ n: 0 }));
let pushed = false;
export const HOST = "page-host";

/** Запись истории на шаг: «Назад» убирает её — и страница закрывается. */
function Url({ name, onClose }: { name: string; onClose: () => void }) {
  const [params, setParams] = useSearchParams();
  const mine = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // шаг сменил шаг (форма → итог): запись истории одна
    const replace = params.has("do");
    setParams((p) => (p.set("do", name), p), { replace });
    if (!replace) pushed = true;
  }, []);
  const at = params.get("do");
  useEffect(() => {
    // шаг наш с момента, когда встал в адрес; пропал из адреса после этого — «Назад»
    if (at === name) return void (mine.current = true);
    if (!mine.current) return;
    pushed = false;
    close.current();
  }, [at]);
  return null;
}

/** Убирает из адреса шаг, страницы которого уже нет: закрыли кнопкой, вернулись «Назад» к пройденному шагу или перезагрузили страницу. Стоит в оболочке. */
export function StepUrl() {
  const n = useSteps((s) => s.n);
  const loc = useLocation();
  const go = useNavigate();
  useEffect(() => {
    if (n || !new URLSearchParams(loc.search).has("do")) return;
    // после текущих переходов: шаг мог закрыться вместе с уходом на другой экран
    const t = setTimeout(() => {
      if (useSteps.getState().n || !/[?&]do=/.test(location.hash)) return;
      if (pushed) (pushed = false, history.back());
      else go(loc.pathname, { replace: true });
    }, 0);
    return () => clearTimeout(t);
  }, [n, loc.search, loc.pathname]);
  return null;
}

type Props = { opened: boolean; onClose: () => void; title: ReactNode; /** имя шага в адресе */ name?: string; /** узкая колонка формы или вся ширина (таблицы) */ wide?: boolean; children: ReactNode };

export function Page(p: Props) {
  return p.opened ? <Open {...p} /> : null;
}

function Open({ onClose, title, name = "step", wide, children }: Props) {
  const routed = useInRouterContext();
  const [host] = useState(() => document.getElementById(HOST));
  useEffect(() => {
    useSteps.setState((s) => ({ n: s.n + 1 }));
    return () => useSteps.setState((s) => ({ n: s.n - 1 }));
  }, []);
  const body = (
    <section className="steppage" data-step={name}>
      <header className="pane-head">
        <ActionIcon variant="subtle" aria-label="Назад" onClick={onClose}><IconArrowLeft size={18} /></ActionIcon>
        <h1 className="trunc">{title}</h1>
      </header>
      <div className="scroll"><div className={`page stepbody${wide ? " wide" : ""}`}>{children}</div></div>
    </section>
  );
  return <>{routed && <Url name={name} onClose={onClose} />}{host ? createPortal(body, host) : body}</>;
}

/** Страница раздела со своим адресом (#/new, #/find…): тот же вид, «Назад» — по истории, без истории — на главный экран. */
export function RoutePage({ title, wide, children }: { title: ReactNode; wide?: boolean; children: ReactNode }) {
  const go = useNavigate();
  const back = () => ((history.state as { idx?: number } | null)?.idx ? go(-1) : go("/"));
  return (
    <section className="steppage">
      <header className="pane-head">
        <ActionIcon variant="subtle" aria-label="Назад" onClick={back}><IconArrowLeft size={18} /></ActionIcon>
        <h1 className="trunc">{title}</h1>
      </header>
      <div className="scroll"><div className={`page stepbody${wide ? " wide" : ""}`}>{children}</div></div>
    </section>
  );
}

/** Страница, открытая из кода: подтверждение опасного действия или шаг со своим содержимым. Одна на всю страницу. */
type Asked = { title: string; name?: string; body?: ReactNode | ((close: () => void) => ReactNode); confirm?: string; onConfirm?: () => unknown };
const useAsked = create<{ asked: Asked | null }>(() => ({ asked: null }));
export const openStep = (asked: Asked) => useAsked.setState({ asked });

export function Steps() {
  const asked = useAsked((s) => s.asked);
  const close = () => useAsked.setState({ asked: null });
  if (!asked) return null;
  return (
    <Page opened onClose={close} title={asked.title} name={asked.name ?? "confirm"}>
      <div style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 8 }}>{typeof asked.body === "function" ? asked.body(close) : asked.body}</div>
      {asked.confirm && (
        <Group mt="md" gap="sm">
          <Button color="red" onClick={() => (close(), void asked.onConfirm?.())}>{asked.confirm}</Button>
          <Button variant="default" onClick={close}>Отмена</Button>
        </Group>
      )}
    </Page>
  );
}
