import { beforeAll, describe, expect, it } from "vitest";
import { createEngineClient, type CaseDef, type DialogueLine, type EngineClient, type Scene } from "@/engine";
import { cases } from "@/data";
import { createGameStore, type GameStore } from "@/stores/game/store";
import { memoryStorage, migrateSave, SAVE_KEY, SAVE_VERSION } from "@/stores/game/persist";
import { computeEnding } from "@/stores/game/endings";
import { applyFlag, deletesEvidence, futureConcepts, hintTierFree, isIrinaNote, tripFlags } from "@/stores/game/rules";
import { calendar, interrogationView, objectivesView, protocolView } from "@/stores/game/selectors";
import { RUNTIME_CASE } from "../runtime/fixture";

const C00 = cases.find((c) => c.id === "case-00-nulevoy-etazh")!;
const NOW = () => new Date("2026-10-13T12:00:00");

/** Доиграть всё, что на сцене: выбор — первый доступный (или по id) */
async function drain(store: GameStore, prefer: Record<string, string> = {}) {
  for (let i = 0; i < 500; i++) {
    const s = store.getState().session;
    if (!s?.stage) return;
    if (s.stage.awaiting === "choice") {
      const scene = (store.getState().session && cases.concat(STORY).find((c) => c.id === s.caseId))!.scenes.find(
        (x) => x.id === s.stage!.sceneId
      )!;
      await store.getState().choose(prefer[scene.id] ?? scene.choices![0].id);
    } else if (s.stage.awaiting === "present") {
      throw new Error(`сцена ${s.stage.sceneId} ждёт предъявления`);
    } else {
      await store.getState().advance();
    }
  }
  throw new Error("сцены не кончаются");
}

let shared: EngineClient;
beforeAll(async () => {
  shared = createEngineClient({ mode: "in-process" });
  await shared.init();
}, 120_000);

const makeStore = (storage = memoryStorage(), extra: Partial<Parameters<typeof createGameStore>[0]> = {}) =>
  createGameStore({ engine: () => shared, storage: () => storage, now: NOW, ...extra });

describe.skipIf(C00.objectives.length === 0)("стор v2: пролог case-00 целиком", () => {
  it("помощь в стандартном прологе не снимает оценку или мастерство", async () => {
    const store = makeStore();
    store.getState().setProfile({ playerName: "Тестов", mode: "standard", onboarded: true });
    await store.getState().boot();
    await store.getState().openCase(C00.id);
    await drain(store);
    const mastery = store.getState().season.mastery;
    for (let tier = 1; tier <= 4; tier++) {
      expect(store.getState().revealHint("p1")).toMatchObject({ tier, free: true });
    }
    expect(store.getState().season.mastery).toEqual(mastery);
    expect(store.getState().session!.hints.filter((h) => !h.free)).toHaveLength(0);
  });

  it("интро → эталоны задач → протокол с пакетной сверкой → разбор", async () => {
    const store = makeStore();
    store.getState().setProfile({ playerName: "Тестов", onboarded: true });
    await store.getState().boot();
    expect(store.getState().loading.status).toBe("ready");

    const cal = calendar(store.getState());
    expect(cal[0]).toMatchObject({ id: C00.id, status: "open" });

    expect(await store.getState().openCase(C00.id)).toBe(true);
    expect(store.getState().session).toMatchObject({ phase: "intro", stage: { sceneId: C00.introScene } });
    await drain(store, { intro: "ask_mug" });
    expect(store.getState().session!.phase).toBe("desk");
    expect(store.getState().session!.endedScenes).toEqual(expect.arrayContaining(["intro", "mug", "call"]));

    const ordered = [...C00.objectives].sort((a, b) => Number(Boolean(a.optional)) - Number(Boolean(b.optional)) || a.order - b.order);
    for (const o of ordered) {
      const before = store.getState().session!.queryCount;
      const ev = await store.getState().runQuery(o.solution);
      expect(ev?.result.error ?? null, o.id).toBeNull();
      expect(store.getState().session!.completed, o.id).toContain(o.id);
      expect(store.getState().session!.queryCount).toBe(before + 1);
      await drain(store);
    }
    const s = store.getState().session!;
    expect(s.evidence.length).toBe(C00.objectives.filter((o) => o.evidence).length);
    expect(s.log.length).toBe(ordered.length);
    expect(s.clock > "2026-12-02 18:05:00").toBe(true);
    expect(objectivesView(store.getState()).every((o) => o.state === "done")).toBe(true);

    // подсказка по уже решённой задаче не открывается
    expect(store.getState().revealHint("p1")).toBeNull();

    // протокол: один верный из двух при пачке 2 — ничего не подтверждено
    const proto = protocolView(store.getState())!;
    const place = proto.blanks.find((b) => b.id === "place")!;
    expect(place.options.find((o) => o.value === "ДК «Полярник»")?.available).toBe(true);
    expect(store.getState().setSlot("place", "ДК «Полярник»")).toBe(true);
    expect(store.getState().setSlot("place", "Нет такого варианта")).toBe(false);
    await store.getState().submitProtocol();
    expect(store.getState().session).toMatchObject({ protocolAttempts: 1, protocolFailures: 1, protocolConfirmed: [] });
    expect(store.getState().barks.some((b) => b.kind === "protocol")).toBe(true);

    expect(store.getState().setSlot("time", "2026-12-02 18:02:00")).toBe(true);
    await store.getState().submitProtocol();
    expect(store.getState().session!.protocolConfirmed).toEqual(["place", "time"]);
    expect(store.getState().session!.stage?.sceneId).toBe(C00.protocol!.successScene);
    await drain(store);

    const done = store.getState().session!;
    expect(done.phase).toBe("debrief");
    expect(done.debrief).toMatchObject({ caseId: C00.id, stats: { protocolAttempts: 2, queries: ordered.length, errors: 0 } });
    expect(done.debrief!.objectives.every((o) => o.done && o.playerSql)).toBe(true);
    expect(store.getState().season.solved[C00.id]).toMatchObject({ runs: 1 });
    expect(store.getState().season.caseQueryLog[C00.id]).toHaveLength(ordered.length);
    expect(store.getState().season.events).toEqual(expect.arrayContaining(["first_query", `case_solved:${C00.id}`]));

    store.getState().finishDebrief();
    expect(store.getState().session).toBeNull();
    expect(calendar(store.getState())[0].status).toBe("solved");
  }, 120_000);

  it("сохранение и загрузка: дело восстанавливается по журналу, база совпадает", async () => {
    const storage = memoryStorage();
    const a = makeStore(storage);
    await a.getState().boot();
    await a.getState().openCase(C00.id);
    await drain(a);
    const [p1, p2] = [...C00.objectives].sort((x, y) => x.order - y.order);
    await a.getState().runQuery(p1.solution);
    await a.getState().runQuery("SELECT nonsense FROM nowhere");
    await a.getState().runQuery(p2.solution);
    await drain(a);
    a.getState().revealHint();
    const sum = await shared.checksum();
    const saved = JSON.parse(storage.getItem(SAVE_KEY)!);
    expect(saved.version).toBe(SAVE_VERSION);
    expect(saved.state.session.journal.length).toBeGreaterThan(0);
    expect(saved.state.barks).toBeUndefined();

    const b = makeStore(storage, { skipHydration: true });
    expect(b.getState().session).toBeNull();
    await b.getState().boot();
    const s = b.getState().session!;
    expect(s.completed).toEqual(["p1", "p2"]);
    expect(s.errors).toBe(1);
    expect(s.hints).toHaveLength(1);
    expect(await shared.checksum()).toBe(sum);
    expect(b.getState().schema.length).toBeGreaterThan(0);
    const p3 = C00.objectives.find((o) => o.order === 3)!;
    await b.getState().runQuery(p3.solution);
    expect(b.getState().session!.completed).toContain(p3.id);
  }, 120_000);
});

// --- Фикстура сюжета: флаги выборов, допрос, событие, обвинение ---

const L = (id: string, text = "…", speaker = "dasha"): DialogueLine => ({ id, speaker, text });
const sc = (id: string, extra: Partial<Scene> = {}): Scene => ({ id, lines: [L(`c91.${id}.001`)], ...extra });

const STORY: CaseDef = {
  ...RUNTIME_CASE,
  id: "case-91-store",
  order: 91,
  protocol: undefined,
  outroScene: "outro",
  objectives: [
    { ...RUNTIME_CASE.objectives[0], sceneAfter: "int" },
    {
      ...RUNTIME_CASE.objectives[0],
      id: "a1",
      order: 2,
      validation: { type: "row_count", expected: 999_999, comparison: "eq" },
      evidence: undefined,
    },
    RUNTIME_CASE.objectives.find((o) => o.id === "opt")!,
  ],
  accusations: [
    {
      id: "acc",
      prompt: "Под логином i.valts работала …",
      answer: "Вальц Ирина Петровна",
      keys: [4127, "i.valts"],
      minCards: 1,
      successScene: "acc_ok",
      wrongScene: "acc_wrong",
      trustFlag: "dasha_trust",
      objective: "a1",
    },
  ],
  events: [
    { id: "q2", atQuery: 2, line: "bark.c91_q2.001" },
    { id: "after_break", after: { interrogation: "int", breaks: 1 }, scene: "call" },
  ],
  scenes: [
    sc("intro", {
      choices: [
        { id: "warm", text: "Даша, я с тобой.", flag: "dasha_trust+2" },
        { id: "cold", text: "Работаем.", flag: "melnik=blackmail" },
      ],
    }),
    sc("int", {
      lines: [L("c91.int.001", "Я её не знаю.", "tokha")],
      interrogation: {
        suspect: "tokha",
        breakSteps: ["neutral", "uneasy"],
        points: [
          {
            line: "c91.int.001",
            press: "press1",
            present: { prompt: "Покажи", correct: ["ev.c90.valts"], success: "brk", failure: "miss" },
          },
        ],
        doneScene: "done",
      },
    }),
    ...["press1", "brk", "miss", "done", "call", "outro", "acc_ok", "acc_wrong"].map((id) => sc(id)),
  ],
};

describe("стор v2: флаги, допрос, событие, обвинение (фикстура)", () => {
  it("выбор ставит флаг, допрос пробит, событие по пробою, ложное обвинение снижает доверие", async () => {
    const store = makeStore(memoryStorage(), { cases: [STORY] });
    await store.getState().boot();
    expect(await store.getState().openCase(STORY.id)).toBe(true);
    await drain(store, { intro: "warm" });
    expect(store.getState().session!.flags).toEqual({ dasha_trust: 2 });

    await store.getState().runQuery("SELECT 1");
    await store.getState().runQuery(STORY.objectives[0].solution);
    expect(store.getState().barks.some((b) => b.lineId === "bark.c91_q2.001")).toBe(true);

    // допрос: лента, нажим, мимо, пробой
    const iv = interrogationView(store.getState(), [STORY])!;
    expect(iv.points.map((p) => p.text)).toEqual(["Я её не знаю."]);
    await store.getState().pressStatement("c91.int.001");
    expect(store.getState().session!.stage?.sceneId).toBe("press1");
    await drain(store);
    await store.getState().presentToSuspect("c91.int.001", { evidenceIds: ["nope"] });
    await drain(store);
    expect(interrogationView(store.getState(), [STORY])!.patience).toBe(2);
    await store.getState().presentToSuspect("c91.int.001", { evidenceIds: ["ev.c90.valts"] });
    await drain(store);
    const s = store.getState().session!;
    expect(s.interrogation).toBeNull();
    expect(s.breaks).toEqual({ int: 1 });
    expect(s.endedScenes).toEqual(expect.arrayContaining(["brk", "done", "int", "call"]));
    expect(s.firedEvents).toEqual(expect.arrayContaining(["q2", "after_break"]));

    // обвинение: ложное — доверие −1, верное с карточкой — задача a1 и финал
    const wrong = await store.getState().accuse("acc", "Лыков Антон Сергеевич", []);
    expect(wrong?.outcome).toBe("wrong_person");
    expect(store.getState().session!.flags.dasha_trust).toBe(1);
    await drain(store);

    await store.getState().runQuery(STORY.objectives[0].solution);
    const row = store.getState().last!.result.rows.findIndex((r) => r.includes(4127));
    const card = store.getState().pinRow(row)!;
    expect(card.sourceClass).toBe("pbd");
    const ok = await store.getState().accuse("acc", "Вальц Ирина Петровна", [card.id]);
    expect(ok?.outcome).toBe("accepted");
    await drain(store);
    expect(store.getState().session!.phase).toBe("debrief");
    expect(store.getState().season.caseFlags[STORY.id]).toEqual({ dasha_trust: 1 });
  }, 120_000);
});

describe("стор v2: чистые правила", () => {
  it("все уровни помощи пролога бесплатны, включая стандартный режим", () => {
    for (const mode of ["novice", "standard", "pro", "zero"] as const) {
      for (let tier = 1; tier <= 4; tier++) expect(hintTierFree(mode, tier, C00, "h.select")).toBe(true);
    }
    const med = cases.find((c) => c.order === 1)!;
    expect(hintTierFree("novice", 4, med, "h.like")).toBe(true);
    expect(hintTierFree("standard", 4, med, "h.like")).toBe(false);
  });

  it("старые решённые шаги включают новые учебные подшаги, черновик сохраняется", () => {
    const draftSql = "SELECT мой_черновик;";
    const old = { session: { caseId: C00.id, completed: ["p1", "p2", "p3", "p4"], draftSql } };
    const migrated = migrateSave(old, 2).session!;
    expect(migrated.completed).toEqual(["p1", "p2", "p3", "p4", "p3a", "p3b"]);
    expect(migrated.draftSql).toBe(draftSql);
    expect(migrateSave({ session: { caseId: C00.id, completed: ["p1"] } }, 2).session!.completed).toEqual(["p1"]);
    expect(migrateSave({ session: { caseId: "case-01-med", completed: ["o1_1", "o1_2"] } }, 2).session!.completed)
      .toEqual(["o1_1", "o1_2", "o1_start", "o1_night", "o1_windows"]);
  });
  it("флаги выборов", () => {
    expect(applyFlag({}, "tokha_turned")).toEqual({ tokha_turned: true });
    expect(applyFlag({ a: 1 }, "a+2")).toEqual({ a: 3 });
    expect(applyFlag({}, "melnik=blackmail")).toEqual({ melnik: "blackmail" });
    expect(applyFlag({ x: true }, "!x")).toEqual({ x: false });
  });

  it("миграция сохранения 1 → 2 и мусор", () => {
    const m = migrateSave({ settings: { textSpeed: "fast" }, season: { solved: {} }, session: null }, 1);
    expect(m.settings).toMatchObject({ textSpeed: "fast", typewriter: true, lieHighlight: false });
    expect(m.season).toMatchObject({ mastery: {}, counters: {}, endingsSeen: [] });
    expect(migrateSave("garbage", 0).profile.mode).toBe("novice");
  });

  it("концовки по разд. 3", () => {
    const best = {
      package_sent: true,
      recipient: "sk",
      final_board: true,
      final_k: true,
      archive_restored: true,
      tokha_turned: true,
      burtsev_caught: "дверь",
      granin_broken: true,
    };
    expect(computeEnding(best)).toMatchObject({ id: "first_sun", burtsev: "дверь", graninBroken: true, postCredits: true });
    expect(computeEnding({ ...best, recipient: "deal" }).id).toBe("empty");
    expect(computeEnding({ ...best, package_sent: false }).id).toBe("empty");
    expect(computeEnding({ ...best, package_sent: false }, { noTimer: true }).id).toBe("first_sun");
    expect(computeEnding({ ...best, recipient: "prosecutor" })).toMatchObject({ id: "still", variant: "prosecutor" });
    expect(computeEnding({ ...best, final_board: false, recipient: "alla" })).toMatchObject({ id: "still", variant: "alla_weak" });
    expect(computeEnding({ ...best, recipient: "alla" })).toMatchObject({ id: "ripples", variant: "unredacted" });
    expect(computeEnding({ ...best, final_k: false })).toMatchObject({ id: "murky", variant: "no_k" });
    expect(computeEnding({ ...best, tokha_turned: false })).toMatchObject({ id: "murky", variant: "no_w" });
    expect(computeEnding({ ...best, tokha_turned: false, ratnikov_full: true }).id).toBe("first_sun");
    expect(computeEnding({ ...best, archive_restored: false })).toMatchObject({ id: "murky", variant: "no_v" });
    expect(computeEnding({ ...best, recipient: "deal" }).epilogue).toEqual([]);
  });
});

// ==================================================================== достижения: события стора

const ACH_CASE: CaseDef = {
  ...RUNTIME_CASE,
  id: "case-92-ach",
  order: 92,
  protocol: undefined,
  concepts: ["h.select"],
  outroScene: "outro",
  objectives: [
    {
      ...RUNTIME_CASE.objectives[0],
      // самосоединение: JOIN вводит только следующее дело — «понятие из будущего»
      solution: "SELECT p.id, p.full_name FROM persons p JOIN persons q ON q.id = p.id WHERE p.last_name = 'Вальц'",
      sceneAfter: "rec01",
      evidence: undefined,
    },
  ],
  events: [{ id: "trip", after: { flag: "watcher_tripped" }, scene: "outro" }],
  scenes: [
    sc("intro"),
    sc("rec01", { lines: [{ id: "c92.rec01.001", speaker: "irina", text: "Запись. Проверка.", direction: "запись диктофона; полушёпот" }] }),
    sc("outro"),
  ],
};
const LATER_CASE: CaseDef = { ...ACH_CASE, id: "case-93-later", order: 93, concepts: ["h.inner_join"], events: [] };

describe("стор v2: события и счётчики для достижений", () => {
  it("первая попытка, без подсказок, понятие из будущего, запись Ирины, дело без растяжки → достижения", async () => {
    const achievements = [
      { id: "ach.t_first", title: "t", description: "t", kind: "event" as const, param: "first_query" },
      { id: "ach.t_future", title: "t", description: "t", kind: "event" as const, param: "future_concept" },
      { id: "ach.t_first_try", title: "t", description: "t", kind: "event" as const, param: "objective_first_try:case-92-ach/o1" },
      { id: "ach.t_no_hint", title: "t", description: "t", kind: "event" as const, param: "objective_no_hint:case-92-ach/o1" },
      { id: "ach.t_notes", title: "t", description: "t", kind: "counter" as const, param: "notes_heard:1" },
      { id: "ach.t_calm", title: "t", description: "t", kind: "event" as const, param: "case_solved_without:case-92-ach/watcher_tripped" },
      { id: "ach.t_tokha", title: "t", description: "t", kind: "flag" as const, param: "tokha_turned" },
    ];
    const store = makeStore(memoryStorage(), { cases: [ACH_CASE, LATER_CASE], achievements });
    await store.getState().boot();
    expect(await store.getState().openCase(ACH_CASE.id)).toBe(true);
    await drain(store);
    await store.getState().runQuery(ACH_CASE.objectives[0].solution);
    await drain(store);

    const season = store.getState().season;
    expect(season.solved[ACH_CASE.id]).toBeDefined();
    expect(season.events).toEqual(
      expect.arrayContaining([
        "first_query",
        "future_concept",
        "objective_done:case-92-ach/o1",
        "objective_first_try:case-92-ach/o1",
        "objective_no_hint:case-92-ach/o1",
        "note_heard:case-92-ach/rec01",
        "case_solved_without:case-92-ach/watcher_tripped",
      ])
    );
    expect(season.counters.notes_heard).toBe(1);
    expect(season.achievements).toEqual(expect.arrayContaining(["ach.t_first", "ach.t_future", "ach.t_first_try", "ach.t_no_hint", "ach.t_notes", "ach.t_calm"]));
    expect(season.achievements).not.toContain("ach.t_tokha");
  }, 120_000);

  it("чистые правила: понятия из будущего, растяжки, записи Ирины, DELETE по уликам", () => {
    const seasonCases = [{ order: 1, concepts: ["h.in", "h.like"] }, { order: 3, concepts: ["h.inner_join"] }, { order: 7, concepts: ["h.cte", "h.union"] }];
    expect(futureConcepts("SELECT * FROM a JOIN b ON b.id = a.id", { order: 1 }, seasonCases)).toEqual(["h.inner_join"]);
    expect(futureConcepts("SELECT * FROM a JOIN b ON b.id = a.id", { order: 3 }, seasonCases)).toEqual([]);
    // строки и комментарии — не синтаксис
    expect(futureConcepts("SELECT 'WITH x UNION' AS t -- JOIN", { order: 1 }, seasonCases)).toEqual([]);
    expect(futureConcepts("WITH t AS (SELECT 1) SELECT * FROM t", { order: 3 }, seasonCases)).toEqual(["h.cte"]);

    expect(tripFlags({ events: [{ id: "w", after: { flag: "watcher_tripped" } }, { id: "s", after: { scene: "x" } }] })).toEqual(["watcher_tripped"]);
    expect(tripFlags(cases.find((c) => c.id === "case-09-matryoshka")!)).toContain("watcher_tripped");

    expect(isIrinaNote({ lines: [{ speaker: "irina", direction: "запись диктофона; ночь" }] })).toBe(true);
    expect(isIrinaNote({ lines: [{ speaker: "irina", direction: "голос из памяти" }] })).toBe(false);
    expect(isIrinaNote({ lines: [{ speaker: "nina", direction: "запись диктофона" }] })).toBe(false);
    // в сезоне записи Ирины — в Д4 (№1) и Д5
    const notes = cases.flatMap((c) => c.scenes.filter(isIrinaNote).map((x) => `${c.id}/${x.id}`));
    expect(notes).toEqual(expect.arrayContaining(["case-04-mertvaya-dusha/outro", "case-05-nomer-3312/rec02"]));

    expect(deletesEvidence("DELETE FROM statements WHERE id = 1")).toBe(true);
    expect(deletesEvidence("delete from main.persons")).toBe(true);
    expect(deletesEvidence("DELETE FROM draft_persons WHERE id = 1")).toBe(false);
    expect(deletesEvidence("DELETE FROM publication WHERE person_id = 1")).toBe(false);
    expect(deletesEvidence("SELECT 'DELETE FROM statements'")).toBe(false);
  });

  it("каждое достижение сезона ссылается на настоящие дела и задачи", async () => {
    const { achievements } = await import("@/data");
    expect(achievements).toHaveLength(33);
    for (const a of achievements) {
      const m = typeof a.param === "string" ? a.param.match(/^objective_(?:done|first_try|no_hint):([^/]+)\/(.+)$/) : null;
      if (!m) continue;
      const c = cases.find((x) => x.id === m[1]);
      expect(c, a.id).toBeDefined();
      expect(c!.objectives.map((o) => o.id), a.id).toContain(m[2]);
    }
    const every = achievements.find((a) => a.id === "ach.every_row")!;
    const { secrets } = await import("@/data");
    expect(every.param).toBe(secrets.length);
  });
});
