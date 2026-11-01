/** Проверка старта новичка через UI. Сервер должен быть запущен; Playwright — через PLAYWRIGHT_MODULE.
 * node scripts/qa-onboarding.mjs [base-url] [shots-dir]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.argv[2] ?? 'http://localhost:3150';
const out = process.argv[3] ?? './qa-onboarding';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, hasTouch: true, locale: 'ru-RU' });
  page.on('pageerror', e => errors.push(e.message));
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('zerosql.season.v2'))?.state);
  const wait = async (fn) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (fn(await state())) return;
      await page.waitForTimeout(80);
    }
    throw new Error('Не дождались состояния');
  };
  const visible = async loc => loc.isVisible().catch(() => false);
  const settleScenes = async () => {
    for (let n = 0; n < 80; n++) {
      await wait(s => s?.session && (s.session.stage || s.session.phase !== 'intro'));
      const stage = (await state()).session.stage;
      if (!stage) break;
      const key = JSON.stringify(stage);
      const script = JSON.parse(fs.readFileSync('src/data/cases/case-00-nulevoy-etazh/script.json', 'utf8'));
      const scene = script.scenes.find(s => s.id === stage.sceneId);
      const choice = page.getByTestId('scene-choice').first();
      if (scene.choices?.length) {
        if (!(await visible(choice))) await page.getByTestId('scene-skip').click();
        await choice.click();
      } else await page.getByTestId('scene-skip').click();
      await wait(s => JSON.stringify(s.session.stage) !== key);
    }
    for (let n = 0; n < 10; n++) {
      const close = page.locator('[aria-label^="Сообщение:"] button[aria-label="Закрыть"]').first();
      if (!(await visible(close))) break;
      await close.click();
    }
  };
  const typeSql = async sql => {
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(sql);
    await wait(s => s.session.draftSql.trim() === sql.trim());
  };
  const run = async () => {
    const n = (await state()).session.queries;
    await page.getByTestId('run-query').click();
    await wait(s => s.session.queries > n);
    await page.waitForTimeout(300); // afterStory открывает сцену после записи результата.
    await settleScenes();
  };
  await page.goto(base);
  await page.getByTestId('age-ok').click();
  await page.getByTestId('cold-open').click();
  await page.getByTestId('login-submit').click();
  assert.equal(await page.locator('#ob-mode').inputValue(), 'novice');
  await page.locator('#ob-name').fill('Новый аналитик');
  await page.getByTestId('onboarding-done').click();
  await wait(s => s?.session?.caseId === 'case-00-nulevoy-etazh');
  const sceneBackground = page.getByTestId('scene').locator('img[src="/backgrounds/basement_b0_03_evening.webp"]');
  await sceneBackground.waitFor();
  await sceneBackground.evaluate(img => img.decode());
  assert.equal(await sceneBackground.evaluate(img => img.naturalWidth > 0), true);
  await page.screenshot({ path: path.join(out, '00-scene-background.png'), animations: 'disabled' });
  await settleScenes();
  assert.match(await page.getByTestId('current-objective').innerText(), /нажми «Выполнить»/);
  await page.screenshot({ path: path.join(out, '01-first-query.png') });
  console.log('Запрос', (await state()).session.queries + 1);
  await run();
  assert.match(await page.getByTestId('current-objective').innerText(), /Оставь четыре столбца/);
  assert.equal((await state()).session.completed.includes('p1'), true);
  // Стандарт тоже учится бесплатно; цена проверяется отдельным тестом правил.
  for (let n = 0; n < 4; n++) await page.getByTestId('objective-help').click();
  const before = (await state()).session.draftSql;
  await page.getByTestId('insert-solution').click();
  assert.match((await state()).session.draftSql, /reported_at, district, kind, description/);
  await page.getByRole('button', { name: 'Вернуть мой запрос' }).click();
  assert.equal((await state()).session.draftSql, before);
  await page.getByTestId('insert-solution').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, '02-mobile-help.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.reload();
  await settleScenes();
  assert.match(await page.getByTestId('objective-hint').innerText(), /Рабочий пример/);
  console.log('Запрос', (await state()).session.queries + 1);
  await run();
  await typeSql('SELECT ошибка FROM incidents;');
  console.log('Запрос', (await state()).session.queries + 1);
  await run();
  assert.equal((await state()).session.completed.includes('p3'), false);
  assert.match(await page.getByTestId('current-objective').innerText(), /Найди вызовы сегодня/);
  const def = JSON.parse(fs.readFileSync('src/data/cases/case-00-nulevoy-etazh/case.json', 'utf8'));
  for (const id of ['p3', 'p3a', 'p3b', 'p4', 'p5']) {
    const o = def.objectives.find(x => x.id === id);
    await typeSql(o.solution);
    console.log('Запрос', (await state()).session.queries + 1);
  await run();
    assert.equal((await state()).session.completed.includes(id), true, id);
    if (id === 'p3a') {
      await page.screenshot({ path: path.join(out, '03-mobile-query-result.png') });
      await page.locator('[data-row="0"] td[data-col="2"]').click();
      const sheet = page.getByRole('dialog', { name: 'Строка 1', exact: true });
      await sheet.waitFor();
      assert.equal(await sheet.locator('dd .truncate').count(), 0, 'описание в раскрытии читается полностью');
      await page.screenshot({ path: path.join(out, '04-mobile-row.png') });
      await sheet.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.screenshot({ path: path.join(out, '05-desktop-goal.png') });
      await page.getByRole('button', { name: 'Показать схему', exact: true }).click();
      await page.getByRole('button', { name: 'Закрытые разделы: 45', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Свернуть схему', exact: true }).click();
    }
  }
  assert.match(await page.getByTestId('current-objective').innerText(), /Открой «Заключение»/);
  await page.getByRole('button', { name: 'Перейти к заключению' }).click();
  await page.screenshot({ path: path.join(out, '06-protocol.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: true, errors, completed: (await state()).session.completed }, null, 2));
  console.log('OK: запуск, цель, помощь, отмена, перезагрузка, ошибка SQL, подшаги, схема, полное описание, заключение.');
} finally { await browser.close(); }
