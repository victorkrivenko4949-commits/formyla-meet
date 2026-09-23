// Предпросмотр: переключение камеры/микрофона до входа, вход с камерой, три участника, смена устройств
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = []; const out = {};
  const mk = async (name) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); const page = await ctx.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    await page.goto(BASE, { waitUntil: 'commit', timeout: 60000 }); await page.waitForSelector('#headerNewMeeting', { timeout: 60000 }); await page.waitForTimeout(600);
    return { ctx, page };
  };
  const self = (P) => P.page.evaluate(() => ({ mic: Meeting.S.mic, cam: Meeting.S.cam, tracks: Meeting.S.stream ? Meeting.S.stream.getTracks().map(t => t.kind + '/' + (t.enabled ? 'on' : 'off') + '/' + t.readyState) : null, selfVideo: !!document.querySelector('[data-self-video] video, .preview-box video') }));
  try {
    const H = await mk('H'); errors.length = 0;
    await H.page.click('#headerNewMeeting'); await H.page.waitForTimeout(400); await H.page.click('.modal [data-act="ok"]'); await H.page.waitForTimeout(1200);
    out.prejoin0 = await self(H);
    await H.page.click('[data-a="cam"]'); await H.page.waitForTimeout(800); out.prejoinCamOff = await self(H);
    await H.page.click('[data-a="cam"]'); await H.page.waitForTimeout(800); out.prejoinCamOn = await self(H);
    await H.page.click('[data-a="mic"]'); await H.page.waitForTimeout(300); out.prejoinMicOff = await self(H);
    await H.page.click('[data-a="mic"]'); await H.page.waitForTimeout(300);
    await H.page.fill('#pjName', 'Хост'); await H.page.click('[data-a="join"]'); await H.page.waitForSelector('.tile-v'); await H.page.waitForTimeout(500);
    out.joined = await self(H);
    const link = await H.page.evaluate(() => App.inviteLink(Meeting.S.id, Meeting.S.pw));
    const G = await mk('G'), K = await mk('K');
    for (const [P, n] of [[G, 'Гость'], [K, 'Третий']]) { await P.page.evaluate(l => { location.href = l; }, link); await P.page.waitForSelector('#pjName'); await P.page.waitForTimeout(800); await P.page.fill('#pjName', n); await P.page.click('[data-a="join"]'); await P.page.waitForTimeout(2000); const adm = await H.page.$('.room-alert [data-admit]'); if (adm) await adm.click(); await P.page.waitForTimeout(1500); }
    await H.page.waitForFunction(() => [...RTC.peers.values()].filter(pc => pc.connectionState === 'connected').length === 2, null, { timeout: 30000 }).catch(() => { });
    await H.page.waitForTimeout(2500);
    const view = (P) => P.page.evaluate(() => ({ tiles: document.querySelectorAll('.tile-v').length, videos: [...document.querySelectorAll('[data-remote-video] video')].map(v => v.videoWidth + 'x' + v.videoHeight), audios: document.querySelectorAll('#audioSink audio').length, pcs: [...RTC.peers.values()].map(pc => pc.connectionState) }));
    out.threeH = await view(H); out.threeG = await view(G); out.threeK = await view(K);
    // HD переключение (полный перезапуск) и выключение камеры у хоста
    await H.page.click('.tool[data-a="more"]'); await H.page.waitForTimeout(300);
    await H.page.evaluate(() => { const b = [...document.querySelectorAll('.popover button')].find(x => /Настройки/.test(x.textContent)); b && b.click(); }); await H.page.waitForTimeout(600);
    out.settingsOpened = await H.page.evaluate(() => !!document.querySelector('.modal'));
    await H.page.evaluate(() => { const b = document.querySelector('.modal [data-act="close"]'); b && b.click(); });
    await H.page.click('.tool[data-a="cam"]'); await H.page.waitForTimeout(2000);
    out.hostCamOffSeenByG = await G.page.evaluate(() => { const p = Meeting.S.participants.find(x => x.host); return { cam: p.cam, video: !!document.querySelector(`[data-remote-video="${p.id}"] video`) }; });
    await H.page.click('.tool[data-a="cam"]'); await H.page.waitForTimeout(2500);
    out.hostCamOnSeenByG = await G.page.evaluate(() => { const p = Meeting.S.participants.find(x => x.host); const v = document.querySelector(`[data-remote-video="${p.id}"] video`); return { cam: p.cam, video: v ? v.videoWidth + 'x' + v.videoHeight : null }; });
    await H.page.screenshot({ path: '/tmp/qa_prejoin_host.png' });
  } catch (e) { out.fatal = e.message; }
  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
