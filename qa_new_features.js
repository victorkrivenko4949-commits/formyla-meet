// Тест новых функций: бизнес-шаблоны доски, диаграммы, штампы, режим музыканта
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForSelector('#headerNewMeeting');
  await page.waitForFunction(() => window.App && window.Meeting && window.RTC);
  await page.waitForTimeout(1000);
  const out = {};

  // Вход во встречу
  await page.click('#headerNewMeeting');
  await page.waitForTimeout(400);
  await page.click('.modal [data-act="ok"]');
  await page.waitForTimeout(1200);
  await page.fill('#pjName', 'Хост');
  await page.click('[data-a="join"]');
  await page.waitForSelector('.tile-v');
  await page.waitForTimeout(800);

  // Открыть доску
  await page.click('[data-a="whiteboard"]');
  await page.waitForSelector('.wb');
  await page.waitForTimeout(500);

  // Меню с шаблонами
  await page.click('.wb [data-act="menu"]');
  await page.waitForSelector('.wb-menu [data-tpl="kanban"]');
  out.templates = await page.$$eval('.wb-menu [data-tpl]', els => els.map(e => e.textContent.trim()));

  // Применить канбан
  await page.click('.wb-menu [data-tpl="kanban"]');
  await page.waitForTimeout(400);
  out.kanbanShapes = await page.evaluate(() => Meeting.S.wb.pages[Meeting.S.wb.page].shapes.length);
  out.kanbanPage = await page.evaluate(() => Meeting.S.wb.page + 1);

  // Применить BMC и SWOT
  for (const tpl of ['bmc', 'swot', 'roadmap', 'retro', 'eisenhower']) {
    await page.click('.wb [data-act="menu"]');
    await page.click(`.wb-menu [data-tpl="${tpl}"]`);
    await page.waitForTimeout(250);
  }
  out.pagesTotal = await page.evaluate(() => Meeting.S.wb.pages.length);

  // Новые инструменты на тулбаре
  out.tools = await page.$$eval('.wb [data-tool]', els => els.map(e => e.dataset.tool));
  out.hasDiamond = out.tools.includes('diamond');
  out.hasDarrow = out.tools.includes('darrow');
  out.hasStamp = out.tools.includes('stamp');
  out.hasChart = out.tools.includes('chart');

  // Палитра стикеров
  await page.click('.wb [data-tool="note"]');
  out.notePalette = await page.$eval('.wb-note-palette', el => el.classList.contains('show'));
  out.noteColors = await page.$$eval('.wb [data-note-color]', els => els.length);
  await page.click('.wb [data-tool="pen"]');

  // Палитра штампов + поставить штамп
  await page.click('.wb [data-tool="stamp"]');
  out.stampPalette = await page.$eval('.wb-stamp-palette', el => el.classList.contains('show'));
  await page.click('.wb [data-stamp="🔥"]');
  let wbBox = await page.$eval('.wb canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(wbBox.x + wbBox.w / 2, wbBox.y + wbBox.h / 2);
  await page.waitForTimeout(300);
  out.stampShape = await page.evaluate(() => {
    const wb = Meeting.S.wb; const pg = wb.pages[wb.page];
    return pg.shapes.filter(s => s.type === 'stamp').map(s => s.text);
  });

  // Диаграмма: рисуем область (координаты канваса могли смениться после шаблонов)
  await page.click('.wb [data-tool="chart"]');
  wbBox = await page.$eval('.wb canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const cx = wbBox.x + wbBox.w * 0.6, cy = wbBox.y + wbBox.h * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 260, cy + 170, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  out.chartDebug = await page.evaluate(() => {
    const wb = Meeting.S.wb;
    return { tool: wb.tool, editor: !!document.querySelector('.wb-chart-editor'), pages: wb.pages.length, page: wb.page, lastShapes: wb.pages[wb.page].shapes.map(s => s.type).slice(-5), drawing: wb.drawing && wb.drawing.type, errors: [] };
  });
  await page.screenshot({ path: 'qa_chart_debug.png' });
  out.chartDataDefault = await page.$eval('.wb-chart-data', el => el.value.split('\n').length).catch(() => null);
  // Сменить тип на круговую и сохранить
  try { await page.selectOption('.wb-chart-type', 'pie', { timeout: 4000 }); } catch (e) { console.error('SELECT FAILED, dump:', JSON.stringify(await page.evaluate(() => { const wb = Meeting.S.wb; return { tool: wb.tool, editor: !!document.querySelector('.wb-chart-editor'), page: wb.page, lastShapes: wb.pages[wb.page].shapes.map(s => s.type).slice(-4), editorHTML: (document.querySelector('.wb-chart-editor') || {}).innerHTML ? 'has' : 'none' }; }))); }
  try { await page.fill('.wb-chart-title', 'Выручка по кварталам', { timeout: 3000 }); await page.click('.wb-chart-save', { timeout: 3000 }); } catch (e) { console.error('CHART SAVE STEP SKIPPED:', e.message.split('\n')[0]); }
  await page.waitForTimeout(300);
  out.chartShape = await page.evaluate(() => {
    const wb = Meeting.S.wb;
    for (const pg of wb.pages) { const c = pg.shapes.find(s => s.type === 'chart'); if (c) return { type: c.chartType, title: c.title, rows: c.data.length }; }
    return null;
  });

  // Ромб и двойная стрелка
  await page.click('.wb [data-tool="diamond"]');
  await page.mouse.move(wbBox.x + 100, wbBox.y + 100); await page.mouse.down();
  await page.mouse.move(wbBox.x + 180, wbBox.y + 160, { steps: 3 }); await page.mouse.up();
  await page.click('.wb [data-tool="darrow"]');
  await page.mouse.move(wbBox.x + 200, wbBox.y + 300); await page.mouse.down();
  await page.mouse.move(wbBox.x + 320, wbBox.y + 360, { steps: 3 }); await page.mouse.up();
  await page.waitForTimeout(200);
  out.newShapes = await page.evaluate(() => {
    const wb = Meeting.S.wb; const pg = wb.pages[wb.page];
    return pg.shapes.filter(s => s.type === 'diamond' || s.type === 'darrow').map(s => s.type);
  });

  // Режим музыканта
  await page.click('[data-a="micMenu"]');
  out.musicBtn = await page.$eval('[data-o="music"]', el => el.textContent.trim()).catch(() => null);
  await page.click('[data-o="music"]');
  await page.waitForTimeout(1500);
  out.musicState = await page.evaluate(() => Meeting.S.music);
  out.musicTrackSettings = await page.evaluate(() => {
    const t = Meeting.S.stream && Meeting.S.stream.getAudioTracks()[0];
    return t ? t.getSettings() : null;
  });
  out.musicBadge = await page.$$eval('.tile-v[data-id="me"] .badge', els => els.map(e => e.textContent.trim()));
  // Alt+M выключить
  await page.keyboard.press('Alt+m');
  await page.waitForTimeout(1200);
  out.musicAfterAltM = await page.evaluate(() => Meeting.S.music);

  // Скриншоты доски
  await page.evaluate(() => { const w = Meeting.S.wb; w.page = 1; w.renderPages(); w.render(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'qa_wb_kanban.png' });
  await page.evaluate(() => { const w = Meeting.S.wb; w.page = 2; w.renderPages(); w.render(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'qa_wb_bmc.png' });
  await page.evaluate(() => { const w = Meeting.S.wb; w.page = w.pages.length - 1; w.renderPages(); w.render(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'qa_wb_chart.png' });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
