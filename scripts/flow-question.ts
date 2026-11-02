// Живой вопрос человеку: клиент даёт задачу, сессия спрашивает AskUserQuestion, вопрос приходит клиенту,
// клиент отвечает answer, модель продолжает с ответом. env: FLOW_CLIENT_KEY, FLOW_CALLSIGN.
import { client } from "./client.ts";

const callsign = process.env.FLOW_CALLSIGN!;
const questions: Array<Record<string, unknown>> = [];
const answered: Array<Record<string, unknown>> = [];
const l = client(process.env.FLOW_CLIENT_KEY!, {
  onFrame: (f) => {
    if (f.type === "question") questions.push(f);
    if (f.type === "answered") answered.push(f);
  },
});
const wait = async (what: string, ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) throw new Error("не дождался: " + what);
    await new Promise((r) => setTimeout(r, 500));
  }
};
try {
  await wait("связь", () => l.state === "open", 15000);
  const p = await l.request({
    type: "session.prompt",
    v: 1,
    callsign,
    text: "Спроси меня инструментом AskUserQuestion: какой цвет выбрать — «синий» или «зелёный». Получив ответ, напиши одним словом выбранный цвет.",
  });
  console.log("prompt:", p.ok ? "ok" : JSON.stringify(p));
  await wait("кадр question", () => questions.length > 0, 120000);
  const q = questions[0] as { question: string; from: string; kind: string; questions: Array<{ question: string; options: Array<{ label: string }> }> };
  console.log(`question от ${q.from}: ${q.kind} · «${q.questions[0].question}» · ${q.questions[0].options.map((o) => o.label).join(" / ")}`);
  const pick = q.questions[0].options.find((o) => /зел/i.test(o.label))?.label ?? q.questions[0].options[0].label;
  const a = await l.request({ type: "answer", v: 1, callsign, question: q.question, answers: { [q.questions[0].question]: pick } });
  console.log("answer:", JSON.stringify(a));
  const again = await l.request({ type: "answer", v: 1, callsign, question: q.question, answers: { [q.questions[0].question]: pick } });
  console.log("второй ответ:", (again as { error?: string }).error ?? "ok");
  await wait("модель назвала цвет", async () => {
    const h = JSON.stringify(await l.request({ type: "session.history", v: 1, callsign, before: null, limit: 10 }));
    return /"text":"[^"]*зел/i.test(h);
  }, 120000);
  console.log(`question: ok · ответ «${pick}» дошёл до модели; answered кадров: ${answered.length}`);
} catch (e) {
  console.log("question: FAIL ·", (e as Error).message);
  process.exitCode = 1;
} finally {
  l.close(1000, "done");
}
