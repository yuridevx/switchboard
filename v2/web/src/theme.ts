// Тема: цвет есть только у состояния; всё остальное — тихая шкала «чернил».
import { createTheme, defaultVariantColorsResolver, type MantineColorsTuple, type VariantColorsResolver } from "@mantine/core";

const ink: MantineColorsTuple = ["#f1f5f3", "#e1e8e5", "#c3d0cb", "#a2b6ae", "#869f96", "#738f85", "#5f7a71", "#3f564e", "#22332d", "#16201d"];

/** Залитая кнопка основного цвета: фон и текст — переменными темы, чтобы в тёмной теме на светлой плашке стоял тёмный текст. */
const variantColorResolver: VariantColorsResolver = (input) => {
  const base = defaultVariantColorsResolver(input);
  const primary = !input.color || input.color === "ink";
  if (input.variant === "filled" && primary) return { ...base, background: "var(--fill-bg)", hover: "var(--fill-bg-hover)", color: "var(--fill-fg)", border: "none" };
  return base;
};

export const theme = createTheme({
  fontFamily: "Onest, system-ui, -apple-system, Segoe UI, sans-serif",
  fontFamilyMonospace: "JetBrains Mono, ui-monospace, Cascadia Mono, Consolas, monospace",
  headings: { fontFamily: "Onest, system-ui, sans-serif", fontWeight: "600" },
  colors: { ink },
  primaryColor: "ink",
  primaryShade: { light: 9, dark: 1 },
  variantColorResolver,
  defaultRadius: "sm",
  cursorType: "pointer",
  fontSizes: { xs: "12px", sm: "13.5px", md: "15px", lg: "17px", xl: "20px" },
  components: {
    Tooltip: { defaultProps: { openDelay: 400, withArrow: false } },
    Modal: { defaultProps: { centered: true, overlayProps: { backgroundOpacity: 0.35, blur: 2 } } },
    Badge: { defaultProps: { variant: "light", radius: "sm" }, styles: { label: { textTransform: "none", fontWeight: 500 } } },
    Tabs: { defaultProps: { keepMounted: false } },
  },
});
