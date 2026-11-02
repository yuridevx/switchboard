// Шесть модулей вместе на стенде Host: fleet, questions, push, watch, chat, journal.
// Гейт ядра пропускает набор; вопрос сессии, давшей задачу, проходит путь fleet → questions → fleet.answer → SDK.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import fleetPkg from "@switchboard/host-fleet";
import questionsPkg from "@switchboard/host-questions";
import pushPkg from "@switchboard/host-push";
import watchPkg from "@switchboard/host-watch";
import chatPkg from "@switchboard/host-chat";
import journalPkg from "@switchboard/host-journal";
import fleetJson from "../module.json" with { type: "json" };
import questionsJson from "../../questions/module.json" with { type: "json" };
import pushJson from "../../push/module.json" with { type: "json" };
import watchJson from "../../watch/module.json" with { type: "json" };
import chatJson from "../../chat/module.json" with { type: "json" };
import journalJson from "../../journal/module.json" with { type: "json" };
import { make as makeFleet } from "../src/fleet.ts";
import { make as makeQuestions } from "../../questions/src/questions.ts";
import { make as makePush } from "../../push/src/push.ts";
import { make as makeWatch } from "../../watch/src/watch.ts";
import { make as makeChat } from "../../chat/src/chat.ts";
import { make as makeJournal } from "../../journal/src/journal.ts";

const { standHost, until } = stand;
type Stand = stand.Stand;

let st: Stand | null = null;
afterEach(async () => {
  await st?.close();
  st = null;
});

const entry = (m: unknown, mod: Module) => ({ manifest: m as Manifest, module: mod });

describe("шесть модулей вместе", () => {
  it("пакеты отдают объект модуля; гейт ядра пропускает набор; hello несёт контракт всех шести", async () => {
    for (const m of [fleetPkg, questionsPkg, pushPkg, watchPkg, chatPkg, journalPkg]) expect(typeof m).toBe("object");
    const fleet = makeFleet();
    st = await standHost({
      modules: [
        entry(watchJson, makeWatch()),
        entry(pushJson, makePush()),
        entry(questionsJson, makeQuestions()),
        entry(fleetJson, fleet.module),
        entry(chatJson, makeChat()),
        entry(journalJson, makeJournal()),
      ],
    });
    expect(st.startError).toBeNull();
    expect(Object.keys(st.relay.hellos[0].contract as object).sort()).toEqual(
      ["answer", "answered", "decide.AskUserQuestion", "elicit", "machine.journal", "message", "notify", "question", "question.list", "session.events", "session.files", "session.history", "session.prompt", "session.unwatch", "session.watch", "session.watchers"],
    );
    const call = async (me: string, name: string, args: Record<string, unknown>) =>
      (await fleet.tools(me).find((t) => t.name === name)!.handler(args as never, {})) as { content: Array<{ text: string }> };

    await st.open("api@laptop");
    await st.open("profiles@laptop");
    // api даёт задачу profiles сообщением флота
    expect((await call("api@laptop", "send", { to: "profiles@laptop", text: "Мигрируй базы" })).content[0].text).toBe("доставлено: profiles@laptop");
    const pr = st.proc("profiles@laptop");
    await until(() => pr.inputs.length === 1);
    // profiles спрашивает: вопрос уходит api@laptop
    const asked = pr.ask("AskUserQuestion", { questions: [{ question: "Какую базу первой?", header: "База", multiSelect: false, options: [{ label: "прод" }, { label: "стенд" }] }] }, "toolu_peer");
    const q = await until(() => st!.relay.frames("question")[0]);
    expect(q).toMatchObject({ from: "profiles@laptop", to: ["api@laptop"], question: "toolu_peer" });
    // relay доставляет кадр Host машины laptop — её questions кладёт вопрос во ввод api
    st.relay.deliver(q);
    const api = st.proc("api@laptop");
    await until(() => api.inputs.length === 1);
    expect(api.inputs[0].message.content).toContain('<fleet-question from="profiles@laptop" question="toolu_peer">');
    // модель api отвечает инструментом fleet.answer
    expect((await call("api@laptop", "answer", { to: "profiles@laptop", question: "toolu_peer", answers: { "Какую базу первой?": "стенд" } })).content[0].text).toBe("принято");
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Какую базу первой?": "стенд" } } });
    const done = st.relay.frames("answered")[0];
    expect(done).toMatchObject({ by: "api@laptop", to: ["api@laptop"] });
    st.relay.deliver(done as Frame);
    await new Promise((r) => setTimeout(r, 20));
    expect(st.journal().filter((l) => l.word === "unknown_request")).toEqual([]);
    expect(st.journal().filter((l) => l.word === "module_error")).toEqual([]);
  });
});
