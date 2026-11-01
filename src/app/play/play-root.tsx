"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  calendar,
  caseOf,
  continueTarget,
  ENDING_TITLES,
  gameStore,
  rankOf,
  useGame,
  useGameView,
  useHydrated,
  useSfxBus,
  WEATHER_LABELS,
  type CalendarEntry,
} from "@/stores/game";
import { achievements, cases, secrets } from "@/data";
import { CaseJournal, type CaseJournalEntry } from "@/components/title/case-journal";
import { LoadingScreen, OnboardingDialog, SettingsPanel } from "@/components/play/screens";
import { DebriefScreen, EndingScreen } from "@/components/play/debrief";
import { SeasonRecords } from "@/components/play/records";
import { CaseDesk } from "./case-desk";
import { caseCode, clockRu } from "./views";

type View = "desk" | "journal" | "settings" | "records" | "ending";

const SUNRISE = Date.UTC(2027, 0, 11);
const ACHIEVEMENT_TEXT = Object.fromEntries(achievements.map((a) => [a.id, { title: a.title, description: a.description }]));

function journalEntry(c: CalendarEntry): CaseJournalEntry {
  const stars = c.stars ? "★".repeat(c.stars) : "";
  return {
    id: c.id,
    no: String(c.order).padStart(2, "0"),
    title: c.title,
    note: c.subtitle,
    opened: clockRu(c.date).slice(0, 10),
    state: c.status === "solved" ? (c.active ? "active" : "done") : c.status === "open" ? (c.active ? "active" : "new") : "locked",
    ...(c.status === "solved"
      ? {
          stateText: c.consequencesChanged
            ? "последствия изменились"
            : `${c.weather ? WEATHER_LABELS[c.weather].toLowerCase() : "принято"} ${stars}`.trim(),
        }
      : {}),
  };
}

/** Текстовая кнопка подвала */
function FooterLink({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ui-13 text-ink-2 hover:text-ink-1 hover:underline hover:underline-offset-3">
      {children}
    </button>
  );
}

/**
 * /play: загрузка мира → (первый запуск) имя и режим → журнал дел (календарь сезона) ⇄ стол
 * дела → разбор → финал. Поверх — «Личное дело» (тайники, отметки, профиль) и «Параметры».
 */
export function PlayRoot({ journal = false }: { journal?: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  useSfxBus();
  useEffect(() => {
    void gameStore.getState().boot();
  }, []);

  const loading = useGame((s) => s.loading);
  const profile = useGame((s) => s.profile);
  const settings = useGame((s) => s.settings);
  const session = useGame((s) => s.session);
  const season = useGame((s) => s.season);
  const def = useGame((s) => caseOf(s));
  const entries = useGameView(calendar);
  const next = useGameView(continueTarget);
  const rank = useGameView(rankOf);
  const act = gameStore.getState;

  const [view, setView] = useState<View>(journal ? "journal" : "desk");
  const [back, setBack] = useState<View>("desk");
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const progressText = loading.progress?.text ?? null;
  if (progressText && lines[lines.length - 1] !== progressText) setLines([...lines, progressText].slice(-5));

  useEffect(() => {
    if (hydrated && !profile.ageConfirmed) router.replace("/");
  }, [hydrated, profile.ageConfirmed, router]);

  // В первом сеансе журнал с единственным доступным делом не требует отдельного выбора.
  const firstOpening = useRef(false);
  useEffect(() => {
    if (journal || view !== "desk" || !profile.onboarded || !profile.ageConfirmed || loading.status !== "ready" || session || Object.keys(season.solved).length || firstOpening.current) return;
    firstOpening.current = true;
    void act().openCase(cases[0].id).then((ok) => {
      if (!ok) {
        setNotice("Не удалось открыть пролог. Выберите дело в журнале.");
        setView("journal");
      }
    });
  }, [journal, view, profile.onboarded, profile.ageConfirmed, loading.status, session, season.solved, act]);

  const overlay = (v: View) => {
    setBack(view === "settings" || view === "records" ? back : view);
    setView(v);
  };

  const open = async (id: string) => {
    if (session?.caseId === id && session.phase !== "debrief") {
      setView("desk");
      return;
    }
    setOpening(true);
    setNotice(null);
    const ok = await act().openCase(id);
    setOpening(false);
    if (ok) setView("desk");
    else setNotice("Дело не открыто: нет допуска или материалов.");
  };

  if (!hydrated || !profile.ageConfirmed) return <div className="h-dvh w-full bg-room" />;

  if (!profile.onboarded) {
    return (
      <OnboardingDialog
        defaultName={profile.playerName}
        defaultMode={profile.mode}
        zeroOpen={season.ending !== null}
        onDone={(p) => act().setProfile({ ...p, onboarded: true })}
      />
    );
  }

  if (loading.status === "failed") {
    return <LoadingScreen lines={lines} error={loading.error ?? "ядро не запустилось"} onRetry={() => void act().boot()} />;
  }
  if (loading.status !== "ready" || opening) {
    return <LoadingScreen lines={opening ? [...lines, "Открываю дело…"] : lines} />;
  }

  if (view === "settings") {
    return (
      <SettingsPanel
        settings={settings}
        profile={profile}
        zeroOpen={season.ending !== null}
        onSettings={(p) => act().updateSettings(p)}
        onProfile={(p) => act().setProfile(p)}
        onReset={() => {
          act().resetSeason();
          setView("journal");
        }}
        onClose={() => setView(back)}
      />
    );
  }

  if (view === "records") {
    return (
      <SeasonRecords
        secrets={secrets.map((s) => ({ id: s.id, title: s.title, text: s.text, found: season.foundSecrets.includes(s.id) }))}
        achievements={achievements.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          got: season.achievements.includes(a.id),
          ...(a.hidden ? { hidden: true } : {}),
        }))}
        mastery={season.mastery}
        rank={rank}
        endings={season.endingsSeen.map((id) => ENDING_TITLES[id])}
        onClose={() => setView(back)}
      />
    );
  }

  if (view === "ending" && season.ending) {
    return <EndingScreen ending={season.ending} onArchive={() => router.push("/archive")} onCalendar={() => setView("journal")} />;
  }

  if (session?.phase === "debrief" && session.debrief && def) {
    const d = session.debrief;
    return (
      <DebriefScreen
        debrief={d}
        caseLabel={`${caseCode(def)}. ${def.title}`}
        achievements={ACHIEVEMENT_TEXT}
        onCalendar={() => {
          act().finishDebrief();
          setView("journal");
        }}
        onNext={
          d.nextCaseId
            ? () => {
                const id = d.nextCaseId!;
                act().finishDebrief();
                void open(id);
              }
            : undefined
        }
        onEnding={
          d.ending
            ? () => {
                act().finishDebrief();
                setView("ending");
              }
            : undefined
        }
      />
    );
  }

  if (session && def && view === "desk") {
    return (
      <CaseDesk
        key={`${session.caseId}:${session.runId}`}
        def={def}
        onJournal={() => setView("journal")}
        onSettings={() => overlay("settings")}
        onRecords={() => overlay("records")}
        onExit={() => router.push("/")}
      />
    );
  }

  const nextDate = cases.find((c) => c.id === next)?.date;
  const days = nextDate ? Math.max(0, Math.ceil((SUNRISE - Date.parse(`${nextDate.slice(0, 10)}T00:00:00Z`)) / 86_400_000)) : null;
  const done = entries.filter((e) => e.status === "solved").length;

  return (
    <CaseJournal
      key={session?.caseId ?? "none"}
      cases={entries.map(journalEntry)}
      defaultSelected={session?.caseId ?? next ?? undefined}
      onOpen={(id) => void open(id)}
      onClose={session && session.phase !== "debrief" ? () => setView("desk") : undefined}
      status={`раскрыто: ${done} из ${entries.length}`}
      aside={
        <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2 ui-13 text-ink-2">
          <span>
            {profile.playerName || "Ноль"}, {rank.title.toLowerCase()}
          </span>
          {days !== null && <span>До солнца {days} дн.</span>}
          {notice && <span className="text-ink-1">{notice}</span>}
        </div>
      }
      footerStart={
        <>
          <FooterLink onClick={() => overlay("records")}>Личное дело</FooterLink>
          <FooterLink onClick={() => overlay("settings")}>Параметры</FooterLink>
          {season.ending && <FooterLink onClick={() => setView("ending")}>Финал</FooterLink>}
          {season.ending && <FooterLink onClick={() => router.push("/archive")}>Архив</FooterLink>}
          <FooterLink onClick={() => router.push("/")}>Выйти</FooterLink>
        </>
      }
    />
  );
}
