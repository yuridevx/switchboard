// Прокрутка ленты: у низа — остаётся у низа, когда содержимое растёт (поток, раскрытая карточка); ушёл вверх — не дёргается, есть кнопка вниз.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const NEAR_PX = 80;

export function useStickToBottom(box: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>) {
  const stuck = useRef(true);
  const [away, setAway] = useState(false);

  const toBottom = useCallback(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setAway(false);
  }, [box]);

  useEffect(() => {
    const el = box.current;
    const inner = content.current;
    if (!el || !inner) return;
    let last = el.scrollTop;
    const onScroll = () => {
      // от низа уводит только прокрутка вверх: выросшее содержимое низ не отменяет
      if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX) stuck.current = true;
      else if (el.scrollTop < last) stuck.current = false;
      last = el.scrollTop;
      setAway(!stuck.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const grow = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    grow.observe(inner);
    // лента сжалась (полосы над вводом, выросшее поле): низ тоже должен остаться на месте
    grow.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      grow.disconnect();
    };
  }, [box, content]);

  return { away, toBottom };
}
