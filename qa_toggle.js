// Проверка: гость входит с выключенными камерой и микрофоном, затем включает их — что видит хост
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const WHO = process.env.WHO || 'guest'; // кто входит с выключенными камерой и микрофоном
const SKIP = process.env.SKIP === '1'; // вход вообще без доступа к устройствам (кнопка «пропустить»)
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = []; const out = {};
  const mk = async (name) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); const page = await ctx.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    await page.goto(BASE, { waitUntil: 'commit', timeout: 60000 }); await page.waitForSelector('#headerNewMeeting', { timeout: 60000 }); await page.waitForFunction(() => window.App && window.Meeting && window.RTC); await page.waitForTimeout(1500);
    return { ctx, page };
  };
  const hostView = (P) => P.page.evaluate(() => { const p = Meeting.S.participants.find(x => !x.me); const v = document.querySelector(`[data-remote-video="${p.id}"] video`); const a = document.querySelector(`#audioSink audio[data-aid="${p.id}"]`); const tr = p.stream ? p.stream.getTracks().map(t => t.kind + ':' + t.readyState + ':' + (t.muted ? 'muted' : 'live')) : []; return { mic: p.mic, cam: p.cam, video: v ? v.videoWidth + 'x' + v.videoHeight : null, audioEl: a ? !a.paused : null, tracks: tr, tag: document.querySelector(`.tile-v[data-id="${p.id}"] .name-tag`)?.innerHTML.includes('mic-off') ? 'micOff-icon' : 'mic-icon' }; });
  const guestSelf = (P) => P.page.evaluate(async () => { const S = Meeting.S; const pc = [...RTC.peers.values()][0]; const senders = pc.getTransceivers().map(t => t.__kind + ':' + (t.sender.track ? t.sender.track.kind + '/' + (t.sender.track.enabled ? 'on' : 'off') : 'null')); return { mic: S.mic, cam: S.cam, tracks: S.stream ? S.stream.getTracks().map(t => t.kind + '/' + (t.enabled ? 'on' : 'off')) : null, senders }; });
  try {
    const H = await mk('H'), G = await mk('G'); errors.length = 0;
    await H.page.click('#headerNewMeeting'); await H.page.waitForTimeout(400); await H.page.fill('#nmTopic', 'Toggle test'); await H.page.click('.modal [data-act="ok"]'); await H.page.waitForTimeout(800);
    const T = WHO === 'host' ? H : G, O = WHO === 'host' ? G : H; // T — тот, кто входит с выключенными устройствами
    const off = async (P) => { await P.page.waitForTimeout(1200); if (SKIP) { await P.page.evaluate(() => { const S = Meeting.S; if (S.stream) S.stream.getTracks().forEach(t => t.stop()); S.stream = null; S.cam = false; S.mic = false; RTC.setLocalStream(null); Meeting.renderPrejoin(); }); } else { await P.page.click('[data-a="mic"]'); await P.page.waitForTimeout(300); await P.page.click('[data-a="cam"]'); await P.page.waitForTimeout(1000); } out.prejoin = await P.page.evaluate(() => ({ mic: Meeting.S.mic, cam: Meeting.S.cam, tracks: Meeting.S.stream ? Meeting.S.stream.getTracks().map(t => t.kind + '/' + (t.enabled ? 'on' : 'off')) : null })); };
    if (WHO === 'host') await off(H);
    await H.page.fill('#pjName', 'Хост'); await H.page.click('[data-a="join"]'); await H.page.waitForSelector('.tile-v');
    const link = await H.page.evaluate(() => App.inviteLink(Meeting.S.id, Meeting.S.pw));
    await G.page.evaluate(l => { location.href = l; }, link); await G.page.waitForSelector('#pjName');
    if (WHO !== 'host') await off(G); else await G.page.waitForTimeout(1200);
    await G.page.fill('#pjName', 'Гость'); await G.page.click('[data-a="join"]'); await G.page.waitForTimeout(2500);
    const adm = await H.page.$('.room-alert [data-admit]'); if (adm) await adm.click();
    await H.page.waitForFunction(() => [...RTC.peers.values()].some(pc => pc.connectionState === 'connected'), null, { timeout: 30000 }).catch(() => { });
    await G.page.waitForTimeout(2000);
    out.step1_joinedOff = { host: await hostView(O), guest: await guestSelf(T) };
    // гость включает камеру
    await T.page.click('.tool[data-a="cam"]'); await T.page.waitForTimeout(3000);
    out.step2_camOn = { host: await hostView(O), guest: await guestSelf(T) };
    // гость включает микрофон
    await T.page.click('.tool[data-a="mic"]'); await T.page.waitForTimeout(3000);
    out.step3_micOn = { host: await hostView(O), guest: await guestSelf(T) };
    // выключает микрофон
    await T.page.click('.tool[data-a="mic"]'); await T.page.waitForTimeout(1500);
    out.step4_micOff = { host: await hostView(O), guest: await guestSelf(T) };
    // выключает камеру
    await T.page.click('.tool[data-a="cam"]'); await T.page.waitForTimeout(2000);
    out.step5_camOff = { host: await hostView(O), guest: await guestSelf(T) };
    await H.page.screenshot({ path: '/tmp/qa_toggle_host.png' });
  } catch (e) { out.fatal = e.message; }
  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
