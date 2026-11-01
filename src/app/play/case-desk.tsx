"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeskCenterView, DeskPanelId, EvidenceCardData, ProtocolMessage } from "@/types/ui";
import type { CaseDef } from "@/types/case";
import {
  budgetOf,
  evidenceOf,
  gameStore,
  objectivesView,
  PIN_ALL_LIMIT,
  playSfx,
  protocolView,
  reopenableInterrogations,
  seenValues,
  useGame,
  useGameView,
  type Bark,
} from "@/stores/game";
import { DeskLayout, type DeskMenuAction, type DeskMenuGroup, type StatusMessage } from "@/components/desk/desk-layout";
import { SchemaPanel } from "@/components/desk/schema-panel";
import { SqlTerminal, type SqlEditorHandle } from "@/components/desk/sql-terminal";
import { ResultsGrid, type ResultObjectiveNote } from "@/components/desk/results-grid";
import { markResultError } from "@/components/desk/sql-error-token";
import { ObjectiveList, officialName } from "@/components/case/objective-list";
import { EvidenceBoard } from "@/components/case/evidence-board";
import { EvidenceWall } from "@/components/case/evidence-wall";
import { HandbookPanel } from "@/components/case/handbook-panel";
import { ProtocolForm } from "@/components/case/protocol-form";
import { MessengerNote } from "@/components/kit/messenger";
import { LockScreen } from "@/components/title/title-screen";
import { AccusationPanel, PredictionPrompt } from "@/components/play/accusation";
import { MirrorWindow } from "@/components/play/mirror-window";
import { ScreenButton } from "@/components/kit/screen";
import { RichText } from "@/components/kit/rich-text";
import { achievements, secrets } from "@/data";
import { CHARACTERS, caseCode, caseNo, clockRu, sceneTitle, evidenceCard, handbookFor, hhmm, pinCard, protocolQuestions, uiObjectives } from "./views";
import { useSceneLayer } from "./scene-layer";

const MENUS: DeskMenuGroup[] = [
  {
    label: "Файл",
    items: [
      { action: "save", label: "Сохранить сеанс" },
      { action: "journal", label: "Журнал дел" },
      { action: "settings", label: "Параметры" },
      { action: "reset", label: "Откатить базу дела" },
      { action: "lock", label: "Заблокировать", separated: true },
      { action: "exit", label: "Выйти" },
    ],
  },
  {
    label: "Запрос",
    items: [
      { action: "run", label: "Выполнить", keys: "Ctrl+Enter" },
      { action: "clear", label: "Очистить" },
      { action: "history", label: "История запросов" },
    ],
  },
  {
    label: "Дело",
    items: [
      { action: "briefing", label: "Ориентировка" },
      { action: "tasks", label: "Задания", separated: true },
      { action: "evidence", label: "Материалы" },
      { action: "wall", label: "Стена" },
      { action: "protocol", label: "Заключение" },
    ],
  },
  {
    label: "Справка",
    items: [
      { action: "reference", label: "Справочник SQL" },
      { action: "about", label: "О программе", separated: true },
    ],
  },
];

const SYSTEM = new Set(["mira", "system", "narrator"]);
const LINE_ID = /^[a-z]+\.[\w.-]+$/;
const isPerson = (b: Bark) => !SYSTEM.has(b.speaker) && Boolean(CHARACTERS[b.speaker]);
/** Наводка (kind system от персонажа) уже видна в блокноте; строка-id без текста не показывается */
const isSilent = (b: Bark) => (b.kind === "system" && isPerson(b)) || LINE_ID.test(b.text);

/** Простой без запроса: 2 минуты — Нина предлагает помощь (библия 7.1) */
const IDLE_MS = 120_000;

export function CaseDesk({
  def,
  onJournal,
  onSettings,
  onRecords,
  onExit,
}: {
  def: CaseDef;
  onJournal: () => void;
  onSettings: () => void;
  onRecords: () => void;
  onExit: () => void;
}) {
  const session = useGame((s) => s.session)!;
  const last = useGame((s) => s.last);
  const busy = useGame((s) => s.busy);
  const schema = useGame((s) => s.schema);
  const foreignKeys = useGame((s) => s.foreignKeys);
  const playerViews = useGame((s) => s.playerViews);
  const barks = useGame((s) => s.barks);
  const toasts = useGame((s) => s.toasts);
  const profile = useGame((s) => s.profile);
  const settings = useGame((s) => s.settings);
  const objectives = useGameView(objectivesView);
  const protocol = useGameView(protocolView);
  const budget = useGameView(budgetOf);
  const evidence = useGameView(evidenceOf);
  const reopenable = useGameView(reopenableInterrogations);
  const act = gameStore.getState;

  const editor = useRef<SqlEditorHandle>(null);
  const [panel, setPanel] = useState<DeskPanelId>("tasks");
  const [center, setCenter] = useState<DeskCenterView>("query");
  const [wallFocus, setWallFocus] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [seenPins, setSeenPins] = useState(session.pins.length);
  const [locked, setLocked] = useState(false);
  const [history, setHistory] = useState(false);
  const [accQuery, setAccQuery] = useState<Record<string, string>>({});
  const [predictionOff, setPredictionOff] = useState<string | null>(null);
  const seq = useRef(0);
  const say = (text: string) => setStatus({ id: `l${++seq.current}`, text });

  // Строки, приобщённые из текущего результата
  const [pinned, setPinned] = useState<{ of: typeof last; rows: number[] }>({ of: last, rows: [] });
  const pinnedRows = pinned.of === last ? pinned.rows : [];

  /* ----- материалы ----- */
  const cards = useMemo<EvidenceCardData[]>(
    () => [...evidence.map(evidenceCard), ...session.pins.map((p, i) => pinCard(p, i + 1, i >= seenPins))],
    [evidence, session.pins, seenPins]
  );
  const unseen = session.pins.length > seenPins;
  const { overlay: sceneOverlay, resume } = useSceneLayer(cards, sceneTitle(def, session.clock));

  /* ----- задания ----- */
  const ui = useMemo(() => uiObjectives(objectives, def, last?.feedback ?? null), [objectives, def, last]);
  const main = objectives.filter((o) => !o.optional);
  const current = main.find((o) => o.state === "active");
  const currentNo = current ? main.indexOf(current) + 1 : null;
  const currentDef = def.objectives.find((o) => o.id === current?.id);
  const [restoreDraft, setRestoreDraft] = useState<string | null>(null);
  const doneNo = last ? main.findIndex((o) => o.id === last.completed[0]) + 1 : 0;
  const note: ResultObjectiveNote | null =
    !last || last.result.error
      ? null
      : last.completed.length > 0
        ? { text: doneNo ? `задание ${doneNo} выполнено` : "задание сверх плана выполнено", tone: "done" }
        : last.feedback && currentNo
          ? { text: `задание ${currentNo} не засчитано`, tone: "miss" }
          : null;

  /* ----- системные сообщения: МИРА и события — в строку состояния, люди — в мессенджер ----- */
  useEffect(() => {
    const sys = barks.filter((b) => !isPerson(b) || isSilent(b));
    const toast = toasts[toasts.length - 1];
    if (sys.length === 0 && !toast) return;
    const t = window.setTimeout(() => {
      const shown = sys.filter((b) => !isSilent(b)).pop();
      if (toast) {
        const title = (toast.kind === "secret" ? secrets : achievements).find((x) => x.id === toast.refId)?.title;
        const what = toast.kind === "secret" ? "Найден тайник" : "Отметка в личном деле";
        setStatus({ id: `t${toast.id}`, text: title ? `${what}: «${title}».` : `${what}.` });
      } else if (shown) setStatus({ id: `b${shown.id}`, text: shown.text });
      sys.forEach((b) => act().dismissBark(b.id));
      toasts.forEach((x) => act().dismissToast(x.id));
    }, 0);
    return () => window.clearTimeout(t);
  }, [barks, toasts, act]);
  const people = barks.filter((b) => isPerson(b) && !isSilent(b));
  const message = people[0];

  /* ----- простой: предложить подсказку ----- */
  useEffect(() => {
    if (session.phase !== "desk" || session.hintOffer) return;
    const t = window.setTimeout(() => act().offerHint(), IDLE_MS);
    return () => window.clearTimeout(t);
  }, [session.draftSql, last, session.phase, session.hintOffer, act]);

  /* ----- запрос ----- */
  const run = async () => {
    if (busy) return;
    await act().runQuery();
    const res = act().last?.result;
    markResultError(editor.current, res);
  };

  const pin = (row: number) => {
    if (!last || last.result.error || pinnedRows.includes(row)) return;
    const card = act().pinRow(row);
    if (!card) return;
    setPinned({ of: last, rows: [...pinnedRows, row] });
    say("Строка приобщена к материалам.");
  };

  const pinAll = () => {
    if (!last) return;
    const n = act().pinAll();
    if (n > 0) {
      setPinned({ of: last, rows: last.result.rows.map((_, i) => i) });
      say(`Приобщено строк: ${n}.`);
    }
  };

  const onMenuAction = (a: DeskMenuAction) => {
    switch (a) {
      case "save":
        say("Сеанс сохранён.");
        break;
      case "journal":
        onJournal();
        break;
      case "settings":
        onSettings();
        break;
      case "reset":
        void act().restartCase().then(() => say("База дела откачена к началу. Прогресс сохранён."));
        break;
      case "lock":
        playSfx("ui.lock", settings);
        setLocked(true);
        break;
      case "exit":
        onExit();
        break;
      case "run":
        void run();
        break;
      case "clear":
        act().setDraft("");
        break;
      case "history":
        setHistory(true);
        break;
      case "briefing":
        void act().playScene(def.introScene);
        break;
      case "tasks":
      case "evidence":
      case "reference":
        setPanel(a);
        break;
      case "wall":
        setCenter("wall");
        break;
      case "protocol":
        setCenter("protocol");
        break;
      case "about":
        say("АИС «Зеркало» 4.2.17. Подсистема аналитики. Только чтение.");
        break;
    }
  };

  /* ----- схема ----- */
  const zero = profile.mode === "zero";
  const unlocked = [...def.tables, ...playerViews];
  const openSchema = schema.filter((t) => unlocked.includes(t.name));

  /* ----- заключение и обвинение ----- */
  const protocolMessage: ProtocolMessage | null = protocol?.message
    ? { tone: protocol.solved ? "success" : protocol.failures > 0 && /не сходится/i.test(protocol.message) ? "fail" : "partial", text: protocol.message }
    : null;
  const pinCards = cards.filter((c) => c.kind === "record");
  const protocolPanel =
    protocol || def.accusations?.length ? (
      <div className="flex min-h-full flex-col">
        {protocol && (
          <ProtocolForm
            questions={protocolQuestions(protocol)}
            values={Object.fromEntries(protocol.blanks.map((b) => [b.id, b.value]))}
            onChange={(id, v) => act().setSlot(id, v ?? "")}
            onSubmit={() => void act().submitProtocol()}
            confirmedIds={protocol.blanks.filter((b) => b.confirmed).map((b) => b.id)}
            message={protocolMessage}
            caseLabel={`Дело: «${def.title}»`}
            docNumber={`№ ${caseNo(def)}/${clockRu(def.date).slice(0, 5)}`}
            date={clockRu(session.clock).slice(0, 10)}
            caseNo={caseNo(def)}
            analyst={profile.playerName || undefined}
            batchSize={protocol.batchSize}
            city="г. Полынья"
            submitting={busy}
            disabled={protocol.solved || session.closingScene !== null}
          />
        )}
        {def.accusations?.map((a) => {
          const q = accQuery[a.id] ?? "";
          const state = session.accusations[a.id];
          return (
            <AccusationPanel
              key={a.id}
              id={a.id}
              prompt={a.prompt}
              query={q}
              onQuery={(v) => setAccQuery((m) => ({ ...m, [a.id]: v }))}
              people={seenValues(act(), q, 30)}
              cards={pinCards}
              minCards={a.minCards ?? 2}
              accepted={state?.accepted}
              attempts={state?.attempts}
              busy={busy}
              onAccuse={(person, ids) => void act().accuse(a.id, person, ids)}
            />
          );
        })}
      </div>
    ) : undefined;

  /* ----- результат: предсказание и предложение подсказки сверху ----- */
  const offer = session.hintOffer ? objectives.find((o) => o.id === session.hintOffer) : undefined;
  const offerBy = offer?.nextHint ? def.objectives.find((o) => o.id === offer.id)?.hints[offer.nextHint.tier - 1]?.by : undefined;
  const pred = objectives.find((o) => o.prediction && o.id !== predictionOff);
  const results = (
    <div className="flex h-full min-h-0 flex-col">
      {pred?.prediction && (
        <PredictionPrompt
          question={pred.prediction.question}
          sql={pred.prediction.sql}
          options={pred.prediction.options}
          answered={pred.prediction.answered}
          explanation={pred.prediction.explanation}
          onAnswer={(n) => act().answerPrediction(pred.id, n)}
          onDismiss={() => setPredictionOff(pred.id)}
        />
      )}
      {offer?.nextHint && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-scr-base px-3 py-2">
          <p className="ui-13 text-ink-1">
            {offerBy && CHARACTERS[offerBy] ? `${CHARACTERS[offerBy].shortName}: ` : ""}Застрял? Могу подсказать.
          </p>
          <ScreenButton
            variant="secondary"
            onClick={() => {
              act().revealHint(offer.id);
              act().dismissHintOffer();
              setPanel("tasks");
            }}
          >
            Спросить{offer.nextHint.free ? "" : " (−40)"}
          </ScreenButton>
          <button type="button" className="ui-12 text-ink-3 hover:text-ink-1" onClick={() => act().dismissHintOffer()}>
            не надо
          </button>
        </div>
      )}
      <ResultsGrid
        className="min-h-0 flex-1"
        result={last?.result ?? null}
        sql={last?.sql}
        running={busy}
        onPinRow={pin}
        pinnedRows={pinnedRows}
        objectiveNote={note}
        budgeted={budget.total !== null}
        idleLines={[
          `Зеркало подключено. Доступно таблиц: ${def.tables.length}.`,
          `${caseCode(def)}. ${def.subtitle}`,
        ]}
        onInsertValue={(v) => editor.current?.insert(v)}
        onSuggest={(name, wrong) => {
          if (wrong) act().setDraft(act().session!.draftSql.replace(new RegExp(`\\b${wrong}\\b`, "g"), name));
        }}
      />
    </div>
  );

  const canPinAll = Boolean(last && !last.result.error && last.result.rows.length > 0 && last.result.rows.length <= PIN_ALL_LIMIT);

  return (
    <DeskLayout
      caseCode={caseCode(def)}
      caseTitle={def.title}
      dateTime={clockRu(session.clock)}
      login={`${(profile.playerName || "ноль").toLowerCase()}@зеркало`}
      menus={MENUS}
      onMenuAction={onMenuAction}
      panel={panel}
      onPanelChange={(p) => {
        setPanel(p);
        if (p === "evidence") setSeenPins(session.pins.length);
      }}
      centerView={center}
      onCenterViewChange={(v) => {
        setCenter(v);
        if (v !== "query") playSfx("paper.slide", settings);
        if (v === "wall") setSeenPins(session.pins.length);
      }}
      badges={cards.length ? { evidence: cards.length } : {}}
      badgeAlerts={unseen ? ["evidence"] : []}
      statusMessage={status}
      currentObjective={current && currentNo ? {
        number: currentNo,
        text: current.task,
        ...(note ? { note: note.text } : {}),
        actions: (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {currentDef?.scaffoldSql && <button type="button" data-testid="insert-scaffold" className="min-h-8 ui-13 text-ink-2 underline max-lg:min-h-11" onClick={() => {
              setRestoreDraft(act().session!.draftSql);
              act().setDraft(currentDef.scaffoldSql!);
              say("Основа вставлена. Измени её по условию и нажми «Выполнить».");
            }}>Вставить основу</button>}
            {restoreDraft !== null && <button type="button" className="min-h-8 ui-13 text-ink-2 underline max-lg:min-h-11" onClick={() => {
              act().setDraft(restoreDraft!);
              setRestoreDraft(null);
            }}>Вернуть мой запрос</button>}
            {current.nextHint && <button type="button" data-testid="objective-help" className="min-h-8 ui-13 text-ink-2 underline max-lg:min-h-11" onClick={() => act().revealHint(current.id)}>
              Подсказка {current.nextHint.tier}/4 — {current.nextHint.free ? "бесплатно" : "−40 к оценке"}
            </button>}
          </div>
        ),
        help: current.hints.length > 0 ? <div className="mt-2 max-h-36 overflow-y-auto ui-13 text-ink-2" data-testid="objective-hint">
          <RichText text={current.hints[current.hints.length - 1].text} />
          {current.hints.some((h) => h.tier === 4) && currentDef && <button type="button" data-testid="insert-solution" className="block min-h-11 underline" onClick={() => {
            setRestoreDraft(act().session!.draftSql);
            act().setDraft(currentDef.solution);
          }}>Вставить рабочий пример</button>}
        </div> : undefined,
      } : {
        text: "Данные найдены. Открой «Заключение», выбери ответы из результатов запросов и нажми «Сверить».",
        actions: <ScreenButton variant="secondary" className="mt-2" onClick={() => setCenter("protocol")}>Перейти к заключению</ScreenButton>,
      }}
      topBarExtra={
        <span className="flex items-center gap-4">
          {resume}
          {reopenable.map((id) => (
            <button key={id} type="button" data-testid="reopen-interrogation" className="ui-13 text-sodium hover:underline" onClick={() => act().reopenInterrogation(id)}>
              Вернуться к допросу
            </button>
          ))}
          <button type="button" className="ui-13 text-ink-2 hover:text-ink-1" onClick={onRecords}>
            Личное дело
          </button>
        </span>
      }
      schema={
        <SchemaPanel
          key={def.id}
          className="h-full"
          tables={zero ? [] : schema}
          foreignKeys={foreignKeys}
          unlockedTables={unlocked}
          newTables={def.newTables ?? []}
          onInsert={(t) => editor.current?.insert(t)}
        />
      }
      terminal={
        <SqlTerminal
          className="h-full"
          handleRef={editor}
          value={session.draftSql}
          onChange={(v) => act().setDraft(v)}
          onRun={() => void run()}
          running={busy}
          schema={zero ? [] : openSchema}
          budget={budget.total !== null && budget.left !== null ? { left: budget.left, total: budget.total } : undefined}
          disabled={session.phase === "debrief"}
          toolbar={
            <span className="flex items-center gap-3">
              <button type="button" className="ui-12 text-ink-3 hover:text-ink-1" onClick={() => setHistory(true)}>
                История
              </button>
              {canPinAll && (
                <button type="button" data-testid="pin-all" className="ui-12 text-ink-3 hover:text-ink-1" onClick={pinAll}>
                  Приобщить всё
                </button>
              )}
            </span>
          }
        />
      }
      results={results}
      wall={<EvidenceWall cards={cards} focusId={wallFocus} onFocusChange={setWallFocus} />}
      panels={{
        tasks: <ObjectiveList objectives={ui} characters={CHARACTERS} onRevealHint={(id) => act().revealHint(id)} />,
        evidence: (
          <EvidenceBoard
            cards={cards}
            onCardClick={(id) => {
              setWallFocus(id);
              setCenter("wall");
            }}
            onOpenWall={() => setCenter("wall")}
          />
        ),
        reference: <HandbookPanel entries={handbookFor(def)} onInsert={(s) => editor.current?.insert(s)} />,
        ...(protocolPanel ? { protocol: protocolPanel } : {}),
      }}
      overlay={
        <>
          {sceneOverlay}
          {message && !sceneOverlay && (
            <div className="fixed right-4 bottom-10 z-30 max-lg:right-2 max-lg:bottom-16 max-lg:left-2">
              <MessengerNote
                sender={officialName(CHARACTERS[message.speaker])}
                time={hhmm(session.clock)}
                text={message.detail ? `${message.text}\n${message.detail}` : message.text}
                typing
                more={people.length - 1}
                onClose={() => act().dismissBark(message.id)}
              />
            </div>
          )}
          {history && (
            <div className="fixed inset-0 z-50">
              <MirrorWindow
                section="История запросов"
                status={`запросов: ${session.history.length}`}
                footer={
                  <ScreenButton variant="primary" onClick={() => setHistory(false)}>
                    Закрыть
                  </ScreenButton>
                }
              >
                <ol className="mx-auto max-w-[960px] px-4 py-3">
                  {session.history.length === 0 && <li className="ui-14 text-ink-2">Записей нет.</li>}
                  {[...session.history].reverse().map((h, i) => (
                    <li key={`${h.clock}:${i}`} className="border-b border-line py-2">
                      <p className="flex flex-wrap gap-x-4 mono-12 text-ink-3">
                        <span>{hhmm(h.clock)}</span>
                        <span>{h.ok ? `строк: ${h.rows}` : "ошибка"}</span>
                        {h.objectiveId && <span>задание засчитано</span>}
                        <button
                          type="button"
                          className="ml-auto ui-12 text-ink-2 hover:text-ink-1"
                          onClick={() => {
                            act().setDraft(h.sql);
                            setHistory(false);
                          }}
                        >
                          В редактор
                        </button>
                      </p>
                      <pre className="mt-1 overflow-x-auto mono-13 whitespace-pre text-ink-1">{h.sql}</pre>
                    </li>
                  ))}
                </ol>
              </MirrorWindow>
            </div>
          )}
          {locked && (
            <div className="fixed inset-0 z-50">
              <LockScreen onUnlock={() => setLocked(false)} />
            </div>
          )}
        </>
      }
    />
  );
}
