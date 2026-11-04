// Галерея карточек — модуль стенда снимков и тестов: на страницу не попадает. Экран #gallery рисует образцы теми же компонентами ленты.
import type { AppPart } from "@switchboard/web-core";
import base from "../../src/chat.css";
import css from "./gallery.css";
import { Gallery } from "./Gallery.tsx";

export const galleryPart: AppPart = {
  manifest: {
    name: "chat-gallery",
    type: "web",
    version: "1.0.0",
    provides: { gallery: 1 },
    uses: { "view@web-view": 19, "ui@web-ui": 1, "app@web-core": 2 },
    config: {},
  },
  module: () => ({
    screens: { gallery: { label: "Галерея", path: "gallery", view: Gallery, head: () => ({ title: "Галерея карточек" }) } },
    // области стилей — по модулю: карточкам нужны стили чата и здесь
    css: `${base}\n${css}`,
  }),
};
