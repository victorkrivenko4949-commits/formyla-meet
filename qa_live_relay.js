// Живая проверка: два участника через production-сервер, соединение только через ретранслятор (TURN)
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'https://formyla-meet.onrender.com/';
const RELAY_ONLY = process.env.RELAY_ONLY !== '0';
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'] });
  const errors = []; const out = {};
  const mk = async (name) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    if (RELAY_ONLY) await page.addInitScript(() => { const O = window.RTCPeerConnection; window.RTCPeerConnection = function (cfg) { return new O(Object.assign({}, cfg, { iceTransportPolicy: 'relay' })); }; window.RTCPeerConnection.prototype = O.prototype; });
    await page.goto(BASE, { waitUntil: 'commit', timeout: 60000 }); await page.waitForSelector('#headerNewMeeting', { timeout: 60000 }); await page.waitForTimeout(800);
    return { ctx, page };
  };
  try {
    const H = await mk('H'), G = await mk('G'); errors.length = 0;
    await H.page.click('#headerNewMeeting'); await H.page.waitForTimeout(500); await H.page.fill('#nmTopic', 'TURN test'); await H.page.click('.modal [data-act="ok"]'); await H.page.waitForTimeout(800);
    await H.page.fill('#pjName', 'Хост'); await H.page.click('[data-a="join"]'); await H.page.waitForSelector('.tile-v');
    out.ice = await H.page.evaluate(() => ({ turn: RTC.turn, n: (RTC.ice || []).length }));
    const link = await H.page.evaluate(() => App.inviteLink(Meeting.S.id, Meeting.S.pw));
    await G.page.evaluate(l => { location.href = l; }, link); await G.page.waitForSelector('#pjName'); await G.page.fill('#pjName', 'Гость'); await G.page.click('[data-a="join"]'); await G.page.waitForTimeout(2500);
    const adm = await H.page.$('.room-alert [data-admit]'); if (adm) await adm.click();
    await H.page.waitForFunction(() => [...RTC.peers.values()].some(pc => pc.connectionState === 'connected'), null, { timeout: 40000 }).catch(() => { });
    await G.page.waitForTimeout(4000);
    const rep = P => P.page.evaluate(async () => { const r = []; for (const pc of RTC.peers.values()) { const st = await RTC.stats(pc.__id); r.push({ state: pc.connectionState, path: st.path, rtt: st.rtt, w: st.w, h: st.h }); } return { pcs: r, remoteVideo: [...document.querySelectorAll('[data-remote-video] video')].map(v => v.videoWidth + 'x' + v.videoHeight), audio: [...document.querySelectorAll('#audioSink audio')].map(a => !a.paused), connLabel: !!document.querySelector('.conn-state') }; });
    out.H = await rep(H); out.G = await rep(G);
    await G.page.click('.tool[data-a="share"]'); await G.page.waitForTimeout(4000);
    out.shareOnHost = await H.page.evaluate(() => ({ sharing: !!Meeting.S.sharing, video: [...document.querySelectorAll('#shareMain video')].map(v => v.videoWidth + 'x' + v.videoHeight), wait: (document.querySelector('.share-wait') || { style: {} }).style.display, screenAudio: !!document.querySelector('[data-aid^="screen:"]') }));
    await H.page.screenshot({ path: '/tmp/qa_turn_share.png' });
    await G.page.click('.tool[data-a="share"]'); await G.page.waitForTimeout(800);
    await H.page.click('.tool[data-a="more"]'); await H.page.waitForTimeout(400);
    await H.page.evaluate(() => { const b = [...document.querySelectorAll('.popover button')].find(x => /Статистика/.test(x.textContent)); b && b.click(); }); await H.page.waitForTimeout(1500);
    out.statsText = ((await H.page.evaluate(() => (document.querySelector('.modal') || {}).innerText || '')) || '').replace(/\s+/g, ' ').slice(0, 400);
    await H.page.screenshot({ path: '/tmp/qa_turn_stats.png' });
    await H.page.evaluate(() => { const b = document.querySelector('.modal [data-act="close"]'); b && b.click(); });
    await H.page.click('.leave-btn'); await H.page.waitForTimeout(300); await H.page.click('[data-l="end"]'); await H.page.waitForTimeout(1000);
  } catch (e) { out.fatal = e.message; }
  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
