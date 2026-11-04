// Снесено: галерея вернётся с новой реализацией.
import type { AppPart } from "@switchboard/web-core";

export const galleryPart: AppPart = {
  manifest: { name: "chat-gallery", type: "web", version: "1.0.0", provides: { gallery: 1 }, uses: { "view@web-view": 19, "ui@web-ui": 1, "app@web-core": 2 }, config: {} },
  module: () => ({ screens: { gallery: { label: "Галерея", path: "gallery", view: () => "снесено", head: () => ({ title: "снесено" }) } } }),
};
