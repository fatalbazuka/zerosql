"use client";

import { useState } from "react";
import type { PlayMode, Profile, Settings, TextSpeed } from "@/stores/game/types";
import { ScreenButton, ScreenField } from "@/components/kit/screen";
import { FieldRow, MirrorWindow, SELECT_CLASS, WindowHeading } from "./mirror-window";

/* ---------- Загрузка мира ---------- */

/**
 * Загрузка (раздел 2: «загрузка — текстом»): журнал подключения строками терминала.
 * Высота строк зарезервирована заранее — экран не прыгает, когда строки приходят.
 */
export function LoadingScreen({ lines, error, onRetry }: { lines: string[]; error?: string | null; onRetry?: () => void }) {
  const shown = ["Зеркало подключается…", ...lines].slice(-6);
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-room px-4">
      <div className="w-full max-w-[520px]" role="status" aria-live="polite">
        <ol className="flex min-h-[132px] flex-col justify-end gap-1">
          {shown.map((line, i) => (
            <li key={`${i}:${line}`} className={i === shown.length - 1 && !error ? "mono-13 text-ink-1" : "mono-13 text-ink-3"}>
              &gt; {line}
            </li>
          ))}
        </ol>
        <div className="mt-4 min-h-[48px]">
          {error && (
            <>
              <p className="ui-14 text-ink-1">
                <span className="text-alarm">Ошибка:</span> {error}
              </p>
              {onRetry && (
                <ScreenButton variant="secondary" className="mt-3" onClick={onRetry}>
                  Повторить
                </ScreenButton>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Первый запуск: имя и режим ---------- */

export const MODE_LABELS: Record<PlayMode, string> = {
  novice: "Новичок",
  standard: "Стандарт",
  pro: "Профи",
  zero: "Ноль",
};

const MODE_NOTES: Record<PlayMode, string> = {
  novice: "Наводки бесплатны, предсказания и подсветка лжи включены.",
  standard: "Наводки стоят очков оценки.",
  pro: "Наводок нет, ★-задачи видны сразу.",
  zero: "Без подсказок и автодополнения, схема — только через sqlite_master.",
};

/**
 * Регистрация пользователя (библия 9.1, п. 0): только имя или ник и режим. Пол не спрашивается.
 * Диалог ведомственной программы шириной 420, как окно входа.
 */
export function OnboardingDialog({
  defaultName = "",
  defaultMode = "novice",
  zeroOpen = false,
  warning,
  onDone,
  onCancel,
}: {
  /** Предупреждение над кнопками: «Раскрытые дела будут стёрты.» */
  warning?: string;
  defaultName?: string;
  defaultMode?: PlayMode;
  /** Режим «Ноль» открыт (сезон пройден) */
  zeroOpen?: boolean;
  onDone: (profile: { playerName: string; mode: PlayMode }) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<PlayMode>(defaultMode);
  const clean = name.trim().slice(0, 24);
  const submit = () => clean && onDone({ playerName: clean, mode });
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-room px-4">
      <form
        className="w-full max-w-[420px] border border-line-strong bg-scr-base"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="flex h-7 items-center border-b border-line bg-scr-chrome px-3 ui-13 font-medium text-ink-1">
          Зеркало 4.2 — Регистрация пользователя
        </header>
        <div className="px-4 py-3">
          <p className="mono-12 text-ink-3">УМВД России по г. Полынья</p>
          <p className="mb-3 border-b border-line pb-2 mono-12 text-ink-3">Учётная запись дежурного аналитика</p>
          <div className="grid grid-cols-[104px_1fr] items-center gap-x-3 gap-y-2">
            <label htmlFor="ob-name" className="text-right ui-13 text-ink-2">
              Имя или ник:
            </label>
            <ScreenField id="ob-name" autoFocus maxLength={24} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ноль" />
            <label htmlFor="ob-mode" className="text-right ui-13 text-ink-2">
              Режим:
            </label>
            <select id="ob-mode" className={SELECT_CLASS} value={mode} onChange={(e) => setMode(e.target.value as PlayMode)}>
              <option value="novice">{MODE_LABELS.novice}</option>
              <option value="standard">{MODE_LABELS.standard}</option>
              <option value="pro">{MODE_LABELS.pro}</option>
              <option value="zero" disabled={!zeroOpen}>
                {MODE_LABELS.zero}
                {zeroOpen ? "" : " — после сезона"}
              </option>
            </select>
          </div>
          <p className="mt-2 ml-[116px] ui-12 text-ink-3">{MODE_NOTES[mode]}</p>
          <p className="mt-3 ui-13 text-ink-2">SQL знать не нужно. В прологе помощь бесплатна, запросы разбираем по одному приёму.</p>
          <p className="mt-3 ui-12 text-ink-3">Так вас будут называть в субтитрах и документах. Изменить можно в параметрах.</p>
          {warning && <p className="mt-2 ui-13 text-ink-1">{warning}</p>}
        </div>
        <footer className="flex items-center justify-end gap-3 border-t border-line bg-scr-chrome px-3 py-2">
          {onCancel && (
            <ScreenButton variant="secondary" onClick={onCancel}>
              Отмена
            </ScreenButton>
          )}
          <ScreenButton variant="primary" type="submit" disabled={!clean} data-testid="onboarding-done">
            Готово
          </ScreenButton>
        </footer>
      </form>
    </div>
  );
}

/* ---------- Параметры ---------- */

const SPEEDS: Array<[TextSpeed, string]> = [
  ["slow", "медленно"],
  ["normal", "обычно"],
  ["fast", "быстро"],
  ["instant", "сразу"],
];

function Check({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label htmlFor={id} className="flex min-h-7 cursor-default items-center gap-2 ui-13 text-ink-1">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--color-ink-1)]" />
      {label}
    </label>
  );
}

function Volume({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex max-w-[320px] items-center gap-3">
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-7 min-w-0 flex-1 accent-[var(--color-ink-2)]"
      />
      <span className="w-9 text-right mono-12 text-ink-3 tnum">{Math.round(value * 100)}</span>
    </div>
  );
}

/**
 * «Параметры…» (раздел 7.2, 7.3): окно «Зеркала». Пользователь, режим, текст, звук,
 * доступность, сеанс. Изменения применяются сразу; «Новый сеанс» спрашивает подтверждение.
 */
export function SettingsPanel({
  settings,
  profile,
  zeroOpen = false,
  onSettings,
  onProfile,
  onReset,
  onClose,
}: {
  settings: Settings;
  profile: Profile;
  zeroOpen?: boolean;
  onSettings: (patch: Partial<Settings>) => void;
  onProfile: (patch: Partial<Profile>) => void;
  onReset?: () => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <MirrorWindow
      section="Параметры"
      footer={
        <ScreenButton variant="primary" onClick={onClose}>
          Закрыть
        </ScreenButton>
      }
    >
      <div className="mx-auto max-w-[720px] px-4 py-4" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <WindowHeading>Пользователь</WindowHeading>
        <FieldRow label="Имя или ник:" htmlFor="st-name">
          <ScreenField
            id="st-name"
            maxLength={24}
            defaultValue={profile.playerName}
            onBlur={(e) => e.target.value.trim() && onProfile({ playerName: e.target.value.trim() })}
          />
        </FieldRow>
        <FieldRow label="Режим:" htmlFor="st-mode" note="Режим меняет подсказки со следующего запроса. Оценка уже раскрытых дел не меняется.">
          <select id="st-mode" className={SELECT_CLASS} value={profile.mode} onChange={(e) => onProfile({ mode: e.target.value as PlayMode })}>
            {(Object.keys(MODE_LABELS) as PlayMode[]).map((m) => (
              <option key={m} value={m} disabled={m === "zero" && !zeroOpen && profile.mode !== "zero"}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </FieldRow>

        <WindowHeading>Текст</WindowHeading>
        <FieldRow label="Скорость реплик:" htmlFor="st-speed">
          <select id="st-speed" className={SELECT_CLASS} value={settings.textSpeed} onChange={(e) => onSettings({ textSpeed: e.target.value as TextSpeed })}>
            {SPEEDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="">
          <Check id="st-type" checked={settings.typewriter} onChange={(v) => onSettings({ typewriter: v })} label="Печатать реплики" />
          <Check id="st-auto" checked={settings.autoAdvance} onChange={(v) => onSettings({ autoAdvance: v })} label="Листать реплики после озвучки" />
        </FieldRow>

        <WindowHeading>Звук</WindowHeading>
        <FieldRow label="Голоса:" htmlFor="st-voice">
          <Volume id="st-voice" value={settings.voiceVolume} onChange={(v) => onSettings({ voiceVolume: v })} />
        </FieldRow>
        <FieldRow label="Музыка и фон:" htmlFor="st-music">
          <Volume id="st-music" value={settings.musicVolume} onChange={(v) => onSettings({ musicVolume: v })} />
        </FieldRow>
        <FieldRow label="Звуки стола:" htmlFor="st-sfx">
          <Volume id="st-sfx" value={settings.sfxVolume} onChange={(v) => onSettings({ sfxVolume: v })} />
        </FieldRow>

        <WindowHeading>Доступность</WindowHeading>
        <FieldRow label="">
          <Check id="st-motion" checked={settings.reducedMotion} onChange={(v) => onSettings({ reducedMotion: v })} label="Меньше движения" />
          <Check id="st-timer" checked={settings.noTimer} onChange={(v) => onSettings({ noTimer: v })} label="Без таймера: события ждут" />
          <Check id="st-lie" checked={settings.lieHighlight} onChange={(v) => onSettings({ lieHighlight: v })} label="Подсветка лжи на допросе" />
        </FieldRow>

        <WindowHeading>Оформление</WindowHeading>
        <FieldRow label="Тема:">
          <p className="ui-13 text-ink-1">
            Ночная <span className="text-ink-3">(пользователь: i.valts)</span>
          </p>
        </FieldRow>

        {onReset && (
          <>
            <WindowHeading>Сеанс</WindowHeading>
            <FieldRow label="" note="Раскрытые дела, улики и звание будут стёрты. Параметры останутся.">
              {confirm ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="ui-13 text-ink-1">Стереть сезон?</span>
                  <ScreenButton variant="secondary" onClick={() => setConfirm(false)}>
                    Отмена
                  </ScreenButton>
                  <ScreenButton
                    variant="secondary"
                    className="text-alarm"
                    onClick={() => {
                      setConfirm(false);
                      onReset();
                    }}
                  >
                    Стереть
                  </ScreenButton>
                </div>
              ) : (
                <ScreenButton variant="secondary" onClick={() => setConfirm(true)}>
                  Новый сеанс…
                </ScreenButton>
              )}
            </FieldRow>
          </>
        )}
      </div>
    </MirrorWindow>
  );
}
