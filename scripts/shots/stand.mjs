// Снесено: новый код — по лесам. BUNDLE и pageHtml — контракт scripts/design.
const gone = () => { throw new Error("stand: снесено"); };
export const OUT = "", launch = gone, prepare = gone, url = gone;
export const BUNDLE = { bundle: true, format: "iife", target: "es2022", loader: { ".css": "text" }, logLevel: "warning" };
export const pageHtml = (title, body) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
</head>
<body>
<div id="app"></div>
${body}
</body>
</html>
`;
