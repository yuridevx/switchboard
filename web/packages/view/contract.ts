// Контракт web-view — рантайм страницы: React одним файлом, одна копия на странице. Модули пишут импорт из "react";
// упаковка заменяет его на этот модуль и оставляет внешним, поэтому в файле модуля рантайма нет.
// Файл модуля сборки — пустой default и manifest: ядро запускает его как любой другой модуль.
import json from "./module.json" with { type: "json" };

export {
  Children, Component, Fragment, PureComponent, StrictMode, Suspense, cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo, startTransition,
  use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version,
} from "react";
export { createPortal, flushSync } from "react-dom";
export { createRoot } from "react-dom/client";
export { jsx, jsxs } from "react/jsx-runtime";

export const manifest = json;
export default {};
