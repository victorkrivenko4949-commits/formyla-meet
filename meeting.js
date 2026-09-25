/* meeting.js — комната видеовстречи: предпросмотр, сетка, панель инструментов, боковые панели, доска, запись */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const now = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const M = {
    layer: null, S: null, selfVideo: null, shareVideo: null, timers: [],

    /* =============== ВХОД =============== */
    async open(opts) {
      this.layer = $('#meetingLayer');
      this.layer.classList.remove('hidden');
      document.body.classList.add('in-meeting');
      const user = App.user;
      this.S = {
        id: opts.id || genMeetingId(), topic: opts.topic || 'Встреча FORMYLA', pw: opts.pw || '', isHost: opts.host !== false,
        name: user.name, mic: App.settings.micOn, cam: App.settings.camOn, joined: false, secs: 0,
        view: 'gallery', panel: null, pinned: null, spotlight: null, hand: false,
        sharing: null, wbShared: false, recording: false, recPaused: false, captions: false, captionText: '',
        locked: false, waitingRoom: opts.waiting !== false, allowShare: true, allowChat: true, allowRename: true, allowUnmute: true, muteOnEntry: false,
        participants: [], waiting: [], chat: [], polls: [], rooms: [], chatTo: 'all', unread: 0,
        bg: App.settings.bg || 'none', mirror: App.settings.mirror !== false, hd: true, noise: true, music: App.settings.music === true,
        stream: null, displayStream: null, recorder: null, recChunks: [], wb: null, activePop: null, ended: false,
        me: null, connecting: false, waitingScreen: false, cohost: false, wbRemote: false,
      };
      this.remoteVideos = {}; this.audioSink = this.audioSink || (() => { const d = document.createElement('div'); d.id = 'audioSink'; d.style.display = 'none'; document.body.appendChild(d); return d; })();
      this.renderPrejoin();
      await this.getMedia();
    },

    /* Доступ к устройствам — инкрементально: включение камеры не перезапускает микрофон и наоборот
       (перезапуск всего сразу на реальных устройствах даёт чёрный кадр, а иногда и ошибку «устройство занято»).
       getMedia({ force: true }) — полный перезапуск (смена устройства, HD, шумоподавление). */
    async getMedia(opts) {
      const S = this.S; const force = !!(opts && opts.force);
      const live = (kind) => S.stream ? S.stream.getTracks().filter(t => t.kind === kind && t.readyState === 'live') : [];
      const needAudio = S.mic || !S.joined, needVideo = !!S.cam;
      const aCons = S.music
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000, sampleSize: 16, deviceId: App.settings.micId ? { exact: App.settings.micId } : undefined }
        : { echoCancellation: true, noiseSuppression: S.noise, autoGainControl: true, deviceId: App.settings.micId ? { exact: App.settings.micId } : undefined };
      const vCons = { width: { ideal: S.hd ? 1280 : 640 }, height: { ideal: S.hd ? 720 : 360 }, deviceId: App.settings.camId ? { exact: App.settings.camId } : undefined };
      try {
        if (force && S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
        if (!S.stream) S.stream = new MediaStream();
        // убрать лишнее
        if (!needVideo) live('video').forEach(t => { t.stop(); S.stream.removeTrack(t); });
        S.stream.getTracks().filter(t => t.readyState === 'ended').forEach(t => S.stream.removeTrack(t));
        // добрать недостающее (аудио-дорожку после входа не выбрасываем — микрофон просто выключается)
        const want = {};
        if (needAudio && !live('audio').length) want.audio = aCons;
        if (needVideo && !live('video').length) want.video = vCons;
        if (want.audio || want.video) {
          let got;
          try { got = await navigator.mediaDevices.getUserMedia(want); }
          catch (e) {
            // точное устройство недоступно (сохранённый id устарел) — пробуем любое
            if ((e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && ((want.audio && want.audio.deviceId) || (want.video && want.video.deviceId))) {
              if (want.audio) delete want.audio.deviceId; if (want.video) delete want.video.deviceId; App.settings.micId = ''; App.settings.camId = ''; App.saveSettings && App.saveSettings();
              got = await navigator.mediaDevices.getUserMedia(want);
            } else throw e;
          }
          got.getTracks().forEach(t => S.stream.addTrack(t));
        }
        if (!S.stream.getTracks().length) { S.stream = null; this.attachSelf(); RTC.setLocalStream(null); return; }
        S.stream.getAudioTracks().forEach(t => t.enabled = S.mic);
        S.mediaError = null; S.permState = 'granted';
        RTC.setLocalStream(S.stream);
        this.attachSelf(); this.renderPermBox();
        this.startLevelMeter();
        App.refreshDevices && App.refreshDevices();
      } catch (e) {
        if (!S.stream || !S.stream.getTracks().length) S.stream = null;
        S.mediaError = e.name; S.permState = (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'error';
        if (!S.stream) RTC.setLocalStream(null); else { S.stream.getAudioTracks().forEach(t => t.enabled = S.mic); RTC.setLocalStream(S.stream); }
        if (S.cam && !live('video').length) S.cam = false;
        this.attachSelf(); this.renderPermBox();
        if (e.name === 'NotFoundError') toast('Камера или микрофон не найдены', 'bad');
        else if (e.name === 'NotReadableError' || e.name === 'AbortError') toast('Устройство занято другим приложением или вкладкой', 'bad');
        else if (e.name === 'NotAllowedError') toast('Доступ к камере или микрофону запрещён в браузере', 'bad');
      }
    },

    attachSelf() {
      const S = this.S;
      if (!this.selfVideo) { this.selfVideo = document.createElement('video'); this.selfVideo.autoplay = true; this.selfVideo.muted = true; this.selfVideo.playsInline = true; }
      const v = this.selfVideo;
      const hasVideo = S.stream && S.stream.getVideoTracks().length && S.cam;
      v.srcObject = hasVideo ? S.stream : null;
      v.classList.toggle('mirror', S.mirror);
      v.style.filter = S.bg === 'blur' ? 'blur(6px) saturate(1.1)' : S.bg === 'soft' ? 'brightness(1.05) contrast(1.05)' : '';
      const holders = this.layer.querySelectorAll('[data-self-video]');
      holders.forEach(h => { h.innerHTML = ''; if (hasVideo) h.appendChild(v); else h.innerHTML = `<div class="avatar-wrap"><span class="avatar avatar-lg" style="background:${App.user.color}">${App.user.initials}</span></div>`; });
      const pv = $('.preview-box', this.layer);
      if (pv) { $('.preview-off', pv) && $('.preview-off', pv).classList.toggle('hidden', !!hasVideo); }
      if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = S.mic);
    },

    startLevelMeter() {
      const S = this.S; if (!S.stream || !S.stream.getAudioTracks().length) return;
      try {
        S.audioCtx && S.audioCtx.close();
        S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = S.audioCtx.createMediaStreamSource(S.stream); const an = S.audioCtx.createAnalyser(); an.fftSize = 256; src.connect(an);
        const data = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          if (!S.stream || this.S !== S) return;
          an.getByteFrequencyData(data); const lvl = data.reduce((a, b) => a + b, 0) / data.length / 128;
          const m = this.layer.querySelector('.level-meter i'); if (m) m.style.width = Math.min(100, lvl * 100) + '%';
          const me = this.layer.querySelector('.tile-v[data-id=me]'); if (me) me.classList.toggle('speaking', S.mic && lvl > 0.18);
          requestAnimationFrame(tick);
        }; tick();
      } catch (e) { /* без индикатора */ }
    },

    renderPrejoin() {
      const S = this.S;
      this.layer.classList.add('prejoin-mode');
      this.layer.innerHTML = `
        <div class="room-top"><div class="left"><span class="room-title">${icon('shield')} ${esc(S.topic)}</span><span class="tag">ID ${S.id}</span></div>
        <div class="right"><button class="btn-ghost btn-sm" data-a="cancel">${icon('x')} Отмена</button></div></div>
        <div class="prejoin">
          <div class="preview-box">
            <div data-self-video style="position:absolute;inset:0"></div>
            <div class="preview-off"><span class="avatar avatar-xl" style="background:${App.user.color}">${App.user.initials}</span><span>Камера выключена</span></div>
            <div class="preview-controls">
              <button class="tool ${S.mic ? '' : 'off'}" data-a="mic">${icon(S.mic ? 'mic' : 'micOff')}<span class="lbl">${S.mic ? 'Микрофон' : 'Вкл. микрофон'}</span></button>
              <button class="tool ${S.cam ? '' : 'off'}" data-a="cam">${icon(S.cam ? 'video' : 'videoOff')}<span class="lbl">${S.cam ? 'Камера' : 'Вкл. камеру'}</span></button>
              <button class="tool" data-a="bg">${icon('sparkles')}<span class="lbl">Фон</span></button>
            </div>
          </div>
          <div class="prejoin-form">
            <h2>Готовы подключиться?</h2>
            <p class="muted">${S.isHost ? 'Вы организатор этой встречи. Участники ' + (S.waitingRoom ? 'будут ждать вашего разрешения в зале ожидания.' : 'подключаются сразу.') : 'Введите имя и нажмите «Подключиться». Если у встречи включён зал ожидания, организатор впустит вас.'}</p>
            <div class="form-stack">
              <div id="permBox"></div>
              <label class="field">Ваше имя<input type="text" id="pjName" value="${esc(S.name)}" maxlength="40" placeholder="Как вас будут видеть участники" autocomplete="name"></label>
              ${!S.isHost ? `<label class="field">Код доступа <span class="muted small">(если организатор его задал)</span><input type="text" id="pjPw" value="${esc(S.pw)}" placeholder="Введите код" inputmode="numeric" autocomplete="off"></label>` : ''}
              <div><div class="small muted" style="margin-bottom:6px">Уровень микрофона</div><div class="level-meter"><i></i></div></div>
              <label class="check"><input type="checkbox" id="pjRemember" checked> Запомнить настройки микрофона и камеры</label>
              <label class="check"><input type="checkbox" id="pjAudio" checked> Подключиться со звуком компьютера</label>
              <div class="prejoin-actions">
                <button class="btn-gradient" data-a="join" style="padding:13px 30px;font-size:15px">${S.isHost ? 'Начать встречу' : 'Подключиться'}</button>
                <button class="btn-ghost" data-a="copy">${icon('copy')} Скопировать приглашение</button>
              </div>
            </div>
          </div>
        </div>`;
      this.attachSelf();
      this.layer.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => this.prejoinAction(b.dataset.a)));
      this.renderPermBox();
    },

    /* ---------- Разрешения на камеру и микрофон ---------- */
    inFrame() { try { return window.self !== window.top; } catch (e) { return true; } },
    async queryPermissions() {
      if (!navigator.permissions || !navigator.permissions.query) return null;
      try {
        const [c, m] = await Promise.all([navigator.permissions.query({ name: 'camera' }), navigator.permissions.query({ name: 'microphone' })]);
        return { camera: c.state, microphone: m.state };
      } catch (e) { return null; }
    },
    async requestPermissions() {
      const S = this.S;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Браузер не поддерживает доступ к камере и микрофону', 'bad'); return; }
      if (!window.isSecureContext) { toast('Доступ к камере возможен только по HTTPS', 'bad', 5000); return; }
      toast('Разрешите доступ в окне браузера', 'info', 3000);
      await this.getMedia();
      if (S.permState === 'granted') toast('Доступ к камере и микрофону разрешён', 'ok');
    },
    async renderPermBox() {
      const S = this.S; const box = this.layer && this.layer.querySelector('#permBox'); if (!box) return;
      const perm = await this.queryPermissions();
      const granted = S.permState === 'granted' || (perm && perm.camera === 'granted' && perm.microphone === 'granted' && S.stream);
      const denied = S.permState === 'denied' || (perm && (perm.camera === 'denied' || perm.microphone === 'denied'));
      const frame = this.inFrame();
      if (granted) {
        box.innerHTML = `<div class="perm-box ok">${icon('check')}<div><b>Камера и микрофон подключены</b><div class="small muted">Доступ разрешён. Устройства можно сменить в настройках микрофона и камеры.</div></div></div>`;
        return;
      }
      const why = !window.isSecureContext ? 'Страница открыта не по HTTPS — браузер не даст доступ к устройствам.' : denied ? 'Браузер заблокировал доступ. Нажмите на значок замка или камеры в адресной строке, разрешите камеру и микрофон и нажмите «Запросить снова».' : S.permState === 'error' ? 'Не удалось запустить камеру или микрофон: устройство не найдено или занято другим приложением.' : 'Нажмите «Разрешить доступ» и подтвердите запрос браузера — иначе участники не увидят и не услышат вас.';
      box.innerHTML = `<div class="perm-box ${denied ? 'bad' : ''}">${icon(denied ? 'videoOff' : 'shield')}<div><b>${denied ? 'Доступ к камере и микрофону запрещён' : 'Нужен доступ к камере и микрофону'}</b><div class="small muted">${why}${frame ? ' Приложение открыто во встроенном окне: если запрос не появляется, откройте его в отдельной вкладке.' : ''}</div>
        <div class="perm-actions"><button class="btn-gradient btn-sm" data-p="ask">${icon('mic')} ${denied ? 'Запросить снова' : 'Разрешить доступ'}</button>${frame ? `<button class="btn-ghost btn-sm" data-p="tab">${icon('maximize')} Открыть в отдельной вкладке</button>` : ''}<button class="btn-ghost btn-sm" data-p="skip">Продолжить без камеры</button></div></div></div>`;
      box.querySelector('[data-p="ask"]').onclick = () => this.requestPermissions();
      const t = box.querySelector('[data-p="tab"]'); if (t) t.onclick = () => window.open(location.href, '_blank', 'noopener');
      box.querySelector('[data-p="skip"]').onclick = () => { S.cam = false; S.mic = false; box.innerHTML = ''; this.renderPrejoin(); };
    },
    prejoinAction(a) {
      const S = this.S;
      if (a === 'cancel') return this.close();
      if (a === 'mic') { S.mic = !S.mic; this.renderPrejoin(); this.attachSelf(); if (S.stream) this.startLevelMeter(); }
      if (a === 'cam') { S.cam = !S.cam; this.getMedia().then(() => this.renderPrejoin()); }
      if (a === 'bg') this.bgModal();
      if (a === 'copy') this.copyInvite();
      if (a === 'join') {
        const n = $('#pjName').value.trim(); if (!n) return toast('Введите имя', 'bad');
        const pw = $('#pjPw'); if (pw) S.pw = pw.value.trim();
        S.name = n; App.user.name = n; App.user.initials = SIM.initials(n) || 'Я'; App.saveUser && App.saveUser();
        if ($('#pjRemember').checked) { App.settings.micOn = S.mic; App.settings.camOn = S.cam; }
        this.join();
      }
    },

    /* =============== КОМНАТА =============== */
    async join() {
      const S = this.S; if (S.connecting) return;
      S.connecting = true; S.participants = [];
      const btn = $('[data-a="join"]', this.layer); if (btn) { btn.disabled = true; btn.textContent = 'Подключение…'; }
      this.bindServer();
      let waitToast = null; const waitTm = setTimeout(() => { waitToast = toast('Подключаемся к серверу встреч… Первое подключение может занять до минуты', 'info', 60000); }, 900);
      try {
        await RTC.connect();
        clearTimeout(waitTm); if (waitToast) waitToast.remove();
      } catch (e) {
        clearTimeout(waitTm); if (waitToast) waitToast.remove();
        S.connecting = false; if (btn) { btn.disabled = false; btn.textContent = S.isHost ? 'Начать встречу' : 'Подключиться'; }
        return toast(e.message === 'timeout' ? 'Сервер встреч не ответил. Попробуйте ещё раз через полминуты' : 'Не удалось подключиться к серверу встреч. Проверьте интернет и попробуйте снова', 'bad', 7000);
      }
      RTC.setLocalStream(S.stream);
      RTC.send({ t: 'join', room: S.id, create: !!S.isHost, name: S.name, pw: S.pw, topic: S.topic, waiting: S.waitingRoom, mic: S.mic && !!(S.stream && S.stream.getAudioTracks().length), cam: S.cam && !!(S.stream && S.stream.getVideoTracks().length) });
    },
    /* участник сервера -> объект участника интерфейса */
    mkPeer(p) { return Object.assign({ speaking: false, poor: false, pinned: false, stream: null }, p, { room: p.room || null }); },
    peerName(id) { const S = this.S; if (id === 'me' || (S.me && id === S.me.id)) return S.name; const p = S.participants.find(x => x.id === id); return p ? p.name : 'Участник'; },
    bindServer() {
      const S = this.S;
      RTC.handlers = {};
      RTC.on('error', m => { S.connecting = false; const b = $('[data-a="join"]', this.layer); if (b) { b.disabled = false; b.textContent = S.isHost ? 'Начать встречу' : 'Подключиться'; } if (m.code === 'badpw') { const pw = $('#pjPw', this.layer); if (pw) { pw.focus(); pw.select(); } } toast(m.text, 'bad', 6000); });
      RTC.on('waiting', m => { if (this.S !== S) return; S.topic = m.topic || S.topic; S.waitingScreen = true; S.joined = false; if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = false); this.renderWaiting(m.reason); });
      RTC.on('denied', () => { if (this.S !== S) return; S.endReason = 'Организатор отклонил ваш запрос на вход'; this.end(false, true); });
      RTC.on('removed', () => { if (this.S !== S) return; S.endReason = 'Организатор удалил вас из встречи'; this.end(false, true); });
      RTC.on('ended', () => { if (this.S !== S) return; S.endReason = 'Организатор завершил встречу для всех'; this.end(false, true); });
      RTC.on('disconnected', () => { if (this.S !== S || S.ended) return; if (S.joined || S.waitingScreen) { S.endReason = 'Соединение с сервером встреч потеряно'; this.end(false, true); } });
      RTC.on('joined', m => {
        if (this.S !== S) return;
        S.me = m.you; S.isHost = !!m.you.host; S.cohost = !!m.you.cohost; S.name = m.you.name; S.connecting = false; S.waitingScreen = false;
        S.topic = m.room.topic || S.topic; S.pw = m.room.hasPw ? S.pw : '';
        Object.assign(S, m.room.settings);
        S.participants = m.peers.map(p => this.mkPeer(p));
        S.waiting = (m.waiting || []).map(w => this.mkPeer(w));
        S.polls = m.room.polls || []; this.applyRooms(m.room.rooms || [], null);
        S.chat = (m.room.chat || []).map(c => this.fromChat(c)); S.chat.push({ sys: true, text: `Вы подключились к встрече · ${now()}` });
        S.spotlight = m.room.spotlight ? (m.room.spotlight === S.me.id ? 'me' : m.room.spotlight) : null; S.sharing = m.room.sharingId ? (m.room.sharingId === S.me.id ? 'me' : m.room.sharingId) : null; if (S.sharing && S.sharing !== 'me') S.view = 'speaker';
        if (m.room.wb && m.room.wb.open) { S.wbShared = true; S.wbRemote = true; S.wbState = m.room.wb; }
        if (m.room.annot && m.room.annot.open) { S.annot = true; S.annotState = m.room.annot; }
        if (S.muteOnEntry && !S.isHost && S.mic) { S.mic = false; if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = false); }
        if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = S.mic);
        S.joined = true; S.secs = 0;
        this.renderRoom();
        this.timers.push(setInterval(() => { S.secs++; const t = $('.room-timer', this.layer); if (t) t.textContent = fmtTime(S.secs); }, 1000));
        this.sendState();
        toast(S.isHost ? `Встреча «${S.topic}» началась. Пригласите участников по ссылке` : `Вы во встрече «${S.topic}»`, 'ok');
      });
      RTC.on('peer', p => { if (!S.joined) return; if (!S.participants.find(x => x.id === p.id)) S.participants.push(this.mkPeer(p)); const al = this.layer.querySelector('.room-alert'); al && al.remove(); toast(`${p.name} присоединился`, 'ok'); this.renderRoom(); });
      RTC.on('left', m => { if (!S.joined) return; const p = S.participants.find(x => x.id === m.id); S.participants = S.participants.filter(x => x.id !== m.id); if (this.remoteVideos[m.id]) { this.remoteVideos[m.id].remove(); delete this.remoteVideos[m.id]; } const au = this.audioSink.querySelector(`[data-aid="${m.id}"]`); au && au.remove(); if (S.sharing === m.id) { S.sharing = null; this.closeAnnotations(); } const sau = this.audioSink.querySelector(`[data-aid="screen:${m.id}"]`); sau && sau.remove(); if (S.pinned === m.id) S.pinned = null; if (S.spotlight === m.id) S.spotlight = null; if (m.newHost) { if (S.me && m.newHost === S.me.id) { S.isHost = true; toast('Организатор вышел — теперь вы организатор встречи', 'ok', 5000); } else { const h = S.participants.find(x => x.id === m.newHost); if (h) { h.host = true; } } } if (p && m.reason !== 'waiting') toast(`${p.name} покинул встречу`); this.renderRoom(); });
      RTC.on('peers', m => { if (!S.joined) return; const map = new Map(S.participants.map(p => [p.id, p])); S.participants = m.peers.filter(p => p.id !== S.me.id).map(p => Object.assign(map.get(p.id) || this.mkPeer(p), p)); const meP = m.peers.find(p => p.id === S.me.id); if (meP) { S.isHost = !!meP.host; S.cohost = !!meP.cohost; } this.renderRoom(); });
      RTC.on('state', m => { if (!S.joined || !S.me) return; if (m.id === S.me.id) { if (S.sharing === 'me' && !m.peer.sharing) this.stopShare(true); return; } const p = S.participants.find(x => x.id === m.id); if (p) { Object.assign(p, m.peer, { stream: p.stream }); if (!m.peer.cam) p.camLive = false; } const prevShare = S.sharing; S.sharing = m.sharingId ? (m.sharingId === S.me.id ? 'me' : m.sharingId) : null; if (S.sharing && S.sharing !== 'me' && S.sharing !== prevShare) { S.wbShared = false; S.view = 'speaker'; if (S.wb) { S.wb.destroy(); S.wb = null; } S.annot = false; toast(`${this.peerName(S.sharing)} демонстрирует экран`); } if (!S.sharing && prevShare && prevShare !== 'me') this.closeAnnotations(); this.renderRoom(); });
      RTC.on('track', m => { if (!S.joined) return; const p = S.participants.find(x => x.id === m.id); if (p) p.stream = m.stream; if (m.kind === 'audio') { this.attachAudio(m.id, m.stream); if (S.recMix && S.recMix.add) S.recMix.add(m.stream); } this.renderStage(); });
      RTC.on('screenTrack', m => { if (!S.joined) return; if (m.kind === 'audio' && S.sharing === m.id) this.attachScreenAudio(m.id, m.stream); if (S.sharing === m.id) this.renderStage(); });
      RTC.on('trackchange', m => { if (!S.joined) return; const p = S.participants.find(x => x.id === m.id); if (p && m.kind === 'video') p.camLive = m.live; /* кадры камеры реально идут — надёжный признак включённой камеры */ this.renderStage(); });
      RTC.on('conn', m => {
        const p = S.participants.find(x => x.id === m.id); if (!p) return;
        p.poor = m.state === 'disconnected' || m.state === 'failed' || m.state === 'checking';
        p.connState = m.state;
        const tile = this.layer.querySelector(`.tile-v[data-id="${m.id}"]`);
        if (tile) { const c = tile.querySelector('.connection'); if (c) c.classList.toggle('poor', p.poor); let st = tile.querySelector('.conn-state'); const txt = m.state === 'failed' ? 'Нет соединения' : (m.state === 'checking' || m.state === 'new' || m.state === 'connecting') ? 'Соединение…' : m.state === 'disconnected' ? 'Переподключение…' : ''; if (txt) { if (!st) { st = document.createElement('div'); st.className = 'conn-state'; tile.appendChild(st); } st.textContent = txt; } else if (st) st.remove(); }
        if (m.state === 'failed' && m.restarts >= 2 && !p.failToast) { p.failToast = true; toast(`Не удалось установить медиасоединение с ${esc(p.name)}: сети не пропускают прямой трафик${RTC.turn ? '' : ', а ретранслятор (TURN) на сервере не настроен'}. Попробуйте отключить VPN, сменить сеть (Wi‑Fi ↔ мобильная) или переподключиться`, 'bad', 12000); }
      });
      RTC.on('chat', m => { if (!S.joined) return; const c = this.fromChat(m.msg); if (c.me) return; S.chat.push(c); if (S.panel !== 'chat') { if (!c.sys) { S.unread++; this.renderToolbar(); } if (!c.sys) toast(`${c.from}: ${(c.text || c.file || '').slice(0, 60)}`, 'info', 3000); } else this.renderPanel(); });
      RTC.on('react', m => { if (!S.joined) return; this.react(m.id === S.me.id ? 'me' : m.id, m.emoji, true); });
      RTC.on('caption', m => { if (S.joined && S.captions) this.caption(m.name, m.text); });
      RTC.on('toast', m => toast(m.text, m.kind || 'info', m.ms || 4000));
      RTC.on('settings', m => { if (!S.joined) return; Object.assign(S, m.settings); if (!S.isHost) { if (!S.allowUnmute && S.mic) { S.mic = false; if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = false); } } this.renderRoom(); });
      RTC.on('spotlight', m => { if (!S.joined) return; S.spotlight = m.id && m.id === S.me.id ? 'me' : m.id; S.participants.forEach(p => p.spotlight = p.id === m.id); if (S.spotlight) S.view = 'speaker'; this.renderRoom(); });
      RTC.on('polls', m => { if (!S.joined) return; S.polls = m.polls; if (S.panel === 'polls') this.renderPanel(); else { toast('Обновление опросов — откройте вкладку «Опросы»', 'info', 2500); } });
      RTC.on('rooms', m => { if (!S.joined) return; this.applyRooms(m.rooms, m.members); this.renderRoom(); });
      RTC.on('waitlist', m => { if (!S.joined) return; S.waiting = m.list.map(w => this.mkPeer(w)); this.renderToolbar(); if (S.panel === 'participants') this.renderPanel(); });
      RTC.on('knock', m => { if (S.joined) this.knockAlert(this.mkPeer(m.peer)); });
      RTC.on('timer', m => { if (S.joined) this.startTimer(m.mins); });
      RTC.on('topic', m => { if (S.joined) { S.topic = m.topic; this.renderRoom(); } });
      RTC.on('wb', m => { if (!S.joined) return; this.onRemoteWb(m); });
      RTC.on('annot', m => { if (!S.joined) return; this.onRemoteAnnot(m); });
      RTC.on('wbcur', m => { if (!S.joined) return; const wb = m.kind === 'annot' ? S.annotWb : S.wb; if (wb) wb.setCursor(m.id, m.name, m.color, m.x, m.y); });
      RTC.on('host', m => {
        if (!S.joined) return;
        switch (m.action) {
          case 'mute': if (S.mic) { S.mic = false; if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = false); toast(m.reason || 'Организатор выключил ваш микрофон', 'bad', 4000); this.sendState(); this.renderRoom(); } break;
          case 'askUnmute': App.modal('Запрос организатора', '<p>Организатор просит вас включить микрофон.</p>', [{ label: 'Не сейчас', cls: 'btn-ghost', act: 'close' }, { label: 'Включить микрофон', cls: 'btn-gradient', act: 'ok' }], null, () => { if (!S.mic) this.action('mic'); }); break;
          case 'camOff': if (S.cam) { S.cam = false; this.getMedia().then(() => { this.sendState(); this.renderStage(); }); toast('Организатор остановил ваше видео', 'bad'); } break;
          case 'askCam': App.modal('Запрос организатора', '<p>Организатор просит вас включить видео.</p>', [{ label: 'Не сейчас', cls: 'btn-ghost', act: 'close' }, { label: 'Включить видео', cls: 'btn-gradient', act: 'ok' }], null, () => { if (!S.cam) this.action('cam'); }); break;
          case 'lowerHand': if (S.hand) { S.hand = false; this.sendState(); this.renderRoom(); } break;
          case 'rename': S.name = m.name; App.user.name = m.name; App.user.initials = SIM.initials(m.name) || 'Я'; toast(`Организатор переименовал вас: ${m.name}`); this.renderRoom(); break;
          case 'cohost': S.cohost = !!m.value; toast(S.cohost ? 'Вы назначены соорганизатором' : 'Вы больше не соорганизатор'); this.renderRoom(); break;
          case 'youHost': S.isHost = true; S.cohost = false; toast('Вы назначены организатором встречи', 'ok', 5000); this.renderRoom(); break;
        }
      });
    },
    sendState() { const S = this.S; if (!S || !S.joined) return; RTC.send({ t: 'state', mic: S.mic && !!(S.stream && S.stream.getAudioTracks().some(t => t.readyState === 'live')), cam: S.cam && !!(S.stream && S.stream.getVideoTracks().some(t => t.readyState === 'live')), hand: S.hand, sharing: S.sharing === 'me', name: S.name }); },
    applyRooms(rooms, members) { const S = this.S; S.rooms = (rooms || []).map((r, i) => ({ id: i + 1, name: r.name, open: r.open })); if (members) { const map = new Map(members); S.participants.forEach(p => { p.room = map.get(p.id) || null; }); S.myRoom = S.me ? map.get(S.me.id) || null : null; } if (S.rooms.length && S.rooms[0].open && S.myRoom && !S.isHost) toast(`Организатор открыл сессионные залы. Вы распределены в «${(S.rooms[S.myRoom - 1] || {}).name || 'Зал ' + S.myRoom}»`, 'info', 6000); },
    playKnock() { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 660; g.gain.value = .08; o.start(); setTimeout(() => { o.frequency.value = 880; }, 160); setTimeout(() => { o.stop(); ctx.close(); }, 380); } catch (e) { } },
    fromChat(c) { const S = this.S; const time = typeof c.time === 'number' ? new Date(c.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : (c.time || now()); c = Object.assign({}, c, { time }); if (c.sys) return { sys: true, text: c.text, time: c.time }; const me = S.me && c.from === S.me.id; return { from: c.name, me, initials: c.initials, color: c.color, text: c.text, file: c.file, fileName: c.fileName, data: c.data, time: c.time, to: c.to, toName: c.to && c.to !== 'all' ? (me ? c.toName : 'вам') : '' }; },
    attachAudio(id, stream) {
      let a = this.audioSink.querySelector(`[data-aid="${id}"]`);
      if (!a) { a = document.createElement('audio'); a.dataset.aid = id; a.autoplay = true; this.audioSink.appendChild(a); }
      if (a.srcObject !== stream) a.srcObject = stream;
      if (App.settings.spkId && a.setSinkId) a.setSinkId(App.settings.spkId).catch(() => { });
      a.play().catch(() => { });
      this.watchSpeaking(id, stream);
    },
    /* звук компьютера демонстрирующего */
    attachScreenAudio(id, stream) {
      const S = this.S; if (!stream || !stream.getAudioTracks().length) return;
      let a = this.audioSink.querySelector(`[data-aid="screen:${id}"]`);
      if (!a) { a = document.createElement('audio'); a.dataset.aid = 'screen:' + id; a.autoplay = true; this.audioSink.appendChild(a); }
      if (a.srcObject !== stream) a.srcObject = stream;
      if (App.settings.spkId && a.setSinkId) a.setSinkId(App.settings.spkId).catch(() => { });
      a.play().catch(() => { });
      if (S.recMix && S.recMix.add) S.recMix.add(stream);
    },
    /* индикатор «говорит» для удалённых участников */
    watchSpeaking(id, stream) {
      const S = this.S;
      try {
        if (!this.remoteCtx || this.remoteCtx.state === 'closed') this.remoteCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.remoteMeters = this.remoteMeters || {};
        if (this.remoteMeters[id]) return;
        const an = this.remoteCtx.createAnalyser(); an.fftSize = 256; this.remoteCtx.createMediaStreamSource(stream).connect(an);
        const data = new Uint8Array(an.frequencyBinCount);
        this.remoteMeters[id] = an;
        const tick = () => {
          if (this.S !== S || !S.joined) { delete this.remoteMeters[id]; return; }
          const p = S.participants.find(x => x.id === id); if (!p) { delete this.remoteMeters[id]; return; }
          an.getByteFrequencyData(data); const lvl = data.reduce((a, b) => a + b, 0) / data.length / 128;
          const sp = p.mic && lvl > 0.18;
          if (sp !== p.speaking) { p.speaking = sp; const t = this.layer.querySelector(`.tile-v[data-id="${id}"]`); if (t) t.classList.toggle('speaking', sp); }
          setTimeout(tick, 200);
        }; tick();
      } catch (e) { /* без индикатора */ }
    },
    remoteVideo(id, stream) {
      let v = this.remoteVideos[id];
      if (!v) { v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); this.remoteVideos[id] = v; }
      if (v.srcObject !== stream) v.srcObject = stream;
      v.play().catch(() => { });
      return v;
    },
    renderWaiting(reason) {
      const S = this.S;
      this.layer.classList.add('prejoin-mode');
      this.layer.innerHTML = `
        <div class="room-top"><div class="left"><span class="room-title">${icon('shield')} ${esc(S.topic)}</span><span class="tag">ID ${S.id}</span></div>
        <div class="right"><button class="btn-ghost btn-sm" data-a="cancel">${icon('x')} Выйти</button></div></div>
        <div class="prejoin" style="grid-template-columns:1fr;max-width:560px;text-align:center">
          <div class="card" style="padding:36px 28px">
            <div class="waiting-spinner"></div>
            <h2 style="font-size:26px;font-weight:900;margin:18px 0 8px">${reason === 'nohost' ? 'Организатор ещё не начал встречу' : 'Подождите, организатор скоро вас впустит'}</h2>
            <p class="muted">${reason === 'nohost' ? `Вы подключены к встрече с ID ${esc(S.id)}. Как только организатор запустит её, вы войдёте автоматически или попадёте в зал ожидания. Если ждёте слишком долго — проверьте ссылку или идентификатор.` : `Вы в зале ожидания встречи «${esc(S.topic)}». Как только организатор подтвердит вход, вы попадёте во встречу автоматически.`}</p>
            <div class="preview-box" style="margin:22px auto 0;max-width:320px"><div data-self-video style="position:absolute;inset:0"></div></div>
          </div>
        </div>`;
      this.attachSelf();
      $('[data-a="cancel"]', this.layer).addEventListener('click', () => this.close());
    },
    knockAlert(w) {
      const S = this.S; const st = $('#stage', this.layer); if (!st) return;
      const al = document.createElement('div'); al.className = 'room-alert';
      al.innerHTML = `<span class="avatar avatar-sm" style="background:${w.color}">${w.initials}</span><span class="p-name">${esc(w.name)} ждёт в зале ожидания</span><button class="btn-gradient btn-sm" data-admit="${w.id}">Впустить</button><button class="btn-ghost btn-sm" data-a="panel:participants">Показать</button><button class="btn-icon" data-x>${icon('x')}</button>`;
      st.appendChild(al);
      al.querySelector('[data-admit]').addEventListener('click', () => this.admit(w.id));
      al.querySelector('[data-a]').addEventListener('click', () => { S.panel = 'participants'; this.renderRoom(); });
      al.querySelector('[data-x]').addEventListener('click', () => al.remove());
      setTimeout(() => al.remove(), 15000);
      this.playKnock();
    },
    startTimer(mins) {
      const S = this.S; let left = mins * 60;
      const old = $('.room-top .left .meeting-timer', this.layer); old && old.remove();
      const el = document.createElement('span'); el.className = 'room-timer meeting-timer'; el.style.color = '#fbbf24'; $('.room-top .left', this.layer).appendChild(el);
      const t = setInterval(() => { left--; el.textContent = '⏱ ' + fmtTime(left); if (left <= 0) { clearInterval(t); el.remove(); toast('Время таймера истекло', 'bad'); } }, 1000);
      this.timers.push(t);
    },

    renderRoom() {
      const S = this.S;
      this.layer.classList.remove('prejoin-mode');
      this.layer.innerHTML = `
        <div class="room">
          <div class="room-top">
            <div class="left">
              <span class="room-title"><span class="shield" title="Соединение зашифровано (WebRTC DTLS-SRTP)">${icon('shield')}</span>${esc(S.topic)}</span>
              <button class="btn-icon" data-a="info" title="Информация о встрече">${icon('info')}</button>
              <span class="room-timer">${fmtTime(S.secs)}</span>
              <span class="rec-badge ${S.recording ? '' : 'hidden'}" id="recBadge"><i></i> ${S.recPaused ? 'ПАУЗА' : 'ЗАПИСЬ'}</span>
            </div>
            <div class="right">
              <div class="view-switch">
                <button class="${S.view === 'gallery' ? 'active' : ''}" data-a="view:gallery">${icon('grid')} Галерея</button>
                <button class="${S.view === 'speaker' ? 'active' : ''}" data-a="view:speaker">${icon('speaker')} Докладчик</button>
              </div>
              <button class="btn-icon" data-a="fullscreen" title="Полный экран">${icon('maximize')}</button>
            </div>
          </div>
          <div class="room-body">
            <div class="stage" id="stage"></div>
            <aside class="side-panel ${S.panel ? '' : 'hidden'}" id="sidePanel"></aside>
          </div>
          <div class="toolbar" id="toolbar"></div>
        </div>`;
      this.renderStage(); this.renderToolbar(); this.renderPanel();
      this.layer.querySelectorAll('.room-top [data-a]').forEach(b => b.addEventListener('click', () => this.action(b.dataset.a)));
      document.onkeydown = e => this.keys(e);
    },

    /* ---------- сцена ---------- */
    renderStage() {
      const S = this.S, st = $('#stage', this.layer); if (!st) return;
      const all = [{ id: 'me', name: S.name + ' (Вы)', initials: App.user.initials, color: App.user.color, mic: S.mic, cam: S.cam && !!(S.stream && S.stream.getVideoTracks().length), hand: S.hand, host: S.isHost, cohost: S.cohost, me: true, pinned: S.pinned === 'me', spotlight: S.spotlight === 'me', room: S.myRoom }, ...S.participants];
      const tile = (p, extra = '') => `
        <div class="tile-v ${p.speaking ? 'speaking' : ''} ${p.pinned ? 'pinned' : ''} ${p.hand ? 'has-hand' : ''}" data-id="${p.id}" ${extra}>
          ${p.me ? `<div data-self-video style="position:absolute;inset:0"></div>` : ((p.cam || p.camLive) && p.stream && p.stream.getVideoTracks().some(t => t.readyState === 'live') ? `<div data-remote-video="${p.id}" style="position:absolute;inset:0"></div>` : `<div class="avatar-wrap"><span class="avatar avatar-lg" style="background:${p.color};${p.cam ? '' : 'filter:grayscale(.4)'}">${p.initials}</span></div>`)}
          <div class="badges">${p.host ? `<span class="badge">${icon('crown')} Организатор</span>` : ''}${p.cohost ? `<span class="badge">Соорганизатор</span>` : ''}${p.spotlight ? `<span class="badge">${icon('star')} В центре</span>` : ''}${p.pinned ? `<span class="badge">${icon('pin')}</span>` : ''}${p.room ? `<span class="badge">Зал ${p.room}</span>` : ''}${p.me && S.music ? `<span class="badge music-badge">${icon('music')} Оригинальный звук: вкл</span>` : ''}</div>
          ${p.hand ? `<span class="hand" title="Поднята рука">✋</span>` : ''}
          <div class="tile-menu">
            <button data-t="pin:${p.id}" title="${p.pinned ? 'Открепить' : 'Закрепить'}">${icon('pin')}</button>
            ${(S.isHost || S.cohost) && !p.me ? `<button data-t="menu:${p.id}" title="Ещё">${icon('moreV')}</button>` : ''}
          </div>
          <span class="name-tag">${p.mic ? icon('mic') : icon('micOff', 'mic-off')} ${esc(p.name)}</span>
          ${!p.me ? `<span class="connection ${p.poor ? 'poor' : ''}" title="Качество связи"><i></i><i></i><i></i><i></i></span>` : ''}
        </div>`;

      let html = '';
      if (S.sharing || S.wbShared) {
        html = `<div class="share-stage">
          <div class="share-main" id="shareMain">${S.wbShared ? '' : `<span class="share-label">${S.sharing === 'me' ? 'Вы демонстрируете экран' : esc(this.peerName(S.sharing)) + ' демонстрирует экран'}</span><div class="share-actions">${S.annot ? '' : `<button class="btn-ghost btn-sm" data-a="annotate" title="Рисовать поверх экрана">${icon('pen')} Комментировать</button>`}${S.sharing === 'me' ? `<button class="btn-danger btn-sm" data-a="share">${icon('stop')} Стоп показ</button>` : ''}</div>`}</div>
          <div class="share-side">${all.map(p => tile(p)).join('')}</div></div>`;
      } else if (S.view === 'speaker') {
        const mainId = S.spotlight || S.pinned || (S.participants.find(p => p.speaking) || {}).id || S.participants[0]?.id || 'me';
        const main = all.find(p => p.id === mainId) || all[0];
        html = `<div class="video-grid speaker">${tile(main)}<div class="strip">${all.filter(p => p !== main).map(p => tile(p)).join('')}</div></div>`;
      } else {
        const n = all.length; let cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4; if (window.innerWidth < 640) cols = Math.min(cols, 2);
        html = `<div class="video-grid" style="grid-template-columns:repeat(${cols},1fr);grid-auto-rows:minmax(0,1fr)">${all.map(p => tile(p)).join('')}</div>`;
      }
      html += `<div class="captions ${S.captions && S.captionText ? '' : 'hidden'}" id="captions">${S.captionText}</div>`;
      st.innerHTML = html;
      this.attachSelf();
      if (S.sharing === 'me' && S.displayStream) {
        if (!this.shareVideo) { this.shareVideo = document.createElement('video'); this.shareVideo.autoplay = true; this.shareVideo.muted = true; this.shareVideo.playsInline = true; }
        this.shareVideo.srcObject = S.displayStream; $('#shareMain', st).appendChild(this.shareVideo);
      } else if (S.sharing && S.sharing !== 'me') {
        const scr = RTC.remoteScreen(S.sharing);
        const vtrack = scr && scr.getVideoTracks().find(t => t.readyState === 'live');
        if (vtrack) {
          const v = this.remoteVideo('screen:' + S.sharing, scr); v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000'; $('#shareMain', st).appendChild(v);
          const wait = document.createElement('div'); wait.className = 'share-wait'; wait.textContent = `Ожидаем видео с экрана ${this.peerName(S.sharing)}…`; $('#shareMain', st).appendChild(wait);
          const upd = () => { const has = v.videoWidth > 0 && !vtrack.muted; wait.style.display = has ? 'none' : 'grid'; }; upd();
          ['loadeddata', 'resize', 'playing'].forEach(ev => v.addEventListener(ev, upd)); vtrack.addEventListener('unmute', upd); vtrack.addEventListener('mute', upd);
          this.attachScreenAudio(S.sharing, scr);
        }
        else $('#shareMain', st).insertAdjacentHTML('beforeend', `<div class="share-wait">Ожидаем видео с экрана ${esc(this.peerName(S.sharing))}…</div>`);
      }
      st.querySelectorAll('[data-remote-video]').forEach(h => { const id = h.dataset.remoteVideo; const p = S.participants.find(x => x.id === id); if (!p || !p.stream) return; const v = this.remoteVideo(id, p.stream); v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000'; h.appendChild(v); });
      if (S.wbShared) this.mountWhiteboard($('#shareMain', st));
      if (S.sharing && !S.wbShared && S.annot) this.mountAnnotations($('#shareMain', st));
      st.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); this.action(b.dataset.a, b); }));
      st.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); this.tileAction(b.dataset.t, b); }));
      st.querySelectorAll('.tile-v').forEach(t => t.addEventListener('dblclick', () => { S.view = 'speaker'; S.pinned = t.dataset.id; this.renderRoom(); }));
    },

    tileAction(t, btn) {
      const S = this.S; const [act, id] = t.split(':');
      if (act === 'pin') { S.pinned = S.pinned === id ? null : id; if (S.pinned && S.view === 'gallery') S.view = 'speaker'; this.renderRoom(); }
      if (act === 'menu') this.participantMenu(id, btn);
    },

    participantMenu(id, anchor) {
      const S = this.S, p = S.participants.find(x => x.id === id); if (!p) return;
      this.popover(anchor, `
        <h5>${esc(p.name)}</h5>
        <button data-pm="mute">${icon(p.mic ? 'micOff' : 'mic')} ${p.mic ? 'Выключить микрофон' : 'Попросить включить микрофон'}</button>
        <button data-pm="cam">${icon(p.cam ? 'videoOff' : 'video')} ${p.cam ? 'Остановить видео' : 'Попросить включить видео'}</button>
        <button data-pm="spot">${icon('star')} ${p.spotlight ? 'Убрать из центра' : 'Показать всем в центре'}</button>
        <button data-pm="chat">${icon('chat')} Личное сообщение</button>
        <button data-pm="rename">${icon('edit')} Переименовать</button>
        <button data-pm="host">${icon('crown')} ${p.cohost ? 'Снять соорганизатора' : 'Назначить соорганизатором'}</button>
        ${S.isHost ? `<button data-pm="makeHost">${icon('crown')} Передать роль организатора</button>` : ''}
        <button data-pm="hand" ${p.hand ? '' : 'disabled'}>${icon('hand')} Опустить руку</button>
        <hr>
        <button data-pm="waiting">${icon('clock')} Отправить в зал ожидания</button>
        <button data-pm="remove" class="danger-text">${icon('userX')} Удалить из встречи</button>`, m => {
        m.querySelectorAll('[data-pm]').forEach(b => b.addEventListener('click', () => {
          const a = b.dataset.pm; this.closePop();
          const host = (action, extra = {}) => RTC.send(Object.assign({ t: 'host', action, target: p.id }, extra));
          if (a === 'mute') { if (p.mic) { host('mute'); toast(`Микрофон ${p.name} выключен`); } else { host('askUnmute'); toast(`Запрос отправлен: ${p.name} может включить микрофон`); } }
          if (a === 'cam') { if (p.cam) { host('camOff'); toast(`Видео ${p.name} остановлено`); } else { host('askCam'); toast(`Запрос отправлен: ${p.name} может включить видео`); } }
          if (a === 'spot') { host('spotlight', { value: !p.spotlight }); }
          if (a === 'chat') { S.chatTo = p.id; S.panel = 'chat'; }
          if (a === 'rename') { const n = prompt('Новое имя участника', p.name); if (n && n.trim()) host('rename', { name: n.trim() }); }
          if (a === 'host') { host('cohost', { value: !p.cohost }); toast(!p.cohost ? `${p.name} — соорганизатор` : `${p.name} больше не соорганизатор`); }
          if (a === 'makeHost') { if (confirm(`Передать роль организатора участнику ${p.name}? Вы останетесь во встрече как участник.`)) host('makeHost'); }
          if (a === 'hand') host('lowerHand');
          if (a === 'waiting') { host('toWaiting'); toast(`${p.name} перемещён в зал ожидания`); }
          if (a === 'remove') { if (confirm(`Удалить ${p.name} из встречи?`)) { host('remove'); toast(`${p.name} удалён из встречи`); } }
          this.renderRoom();
        }));
      });
    },

    /* ---------- панель инструментов ---------- */
    renderToolbar() {
      const S = this.S, tb = $('#toolbar', this.layer); if (!tb) return;
      const hands = S.participants.filter(p => p.hand).length + (S.hand ? 1 : 0);
      const tool = (a, ic, lbl, cls = '', extra = '') => `<button class="tool ${cls}" data-a="${a}" title="${lbl}">${icon(ic)}<span class="lbl">${lbl}</span>${extra}</button>`;
      tb.innerHTML = `
        <div class="group left">
          <div class="tool-split">${tool('mic', S.mic ? 'mic' : 'micOff', S.mic ? 'Выкл. звук' : 'Вкл. звук', S.mic ? '' : 'off')}<button class="caret" data-a="micMenu" title="Настройки звука">${icon('chevUp')}</button></div>
          <div class="tool-split">${tool('cam', S.cam ? 'video' : 'videoOff', S.cam ? 'Стоп видео' : 'Вкл. видео', S.cam ? '' : 'off')}<button class="caret" data-a="camMenu" title="Настройки видео">${icon('chevUp')}</button></div>
        </div>
        <div class="group center">
          ${S.isHost || S.cohost ? tool('security', S.locked ? 'lock' : 'shield', 'Безопасность') : ''}
          ${tool('panel:participants', 'users', 'Участники', S.panel === 'participants' ? 'active' : '', `<span class="count">${S.participants.length + 1}</span>${S.waiting.length ? '<span class="dot"></span>' : ''}`)}
          ${tool('panel:chat', 'chat', 'Чат', S.panel === 'chat' ? 'active' : '', S.unread && S.panel !== 'chat' ? `<span class="count">${S.unread}</span>` : '')}
          <div class="tool-split">${tool('share', S.sharing === 'me' ? 'stop' : 'monitorUp', S.sharing === 'me' ? 'Стоп показ' : 'Демонстрация', S.sharing === 'me' ? 'active' : '')}<button class="caret" data-a="shareMenu" title="Варианты демонстрации">${icon('chevUp')}</button></div>
          ${tool('record', S.recording ? 'stop' : 'record', S.recording ? 'Стоп запись' : 'Запись', S.recording ? 'active' : '')}
          ${tool('reactions', 'smile', 'Реакции')}
          ${tool('hand', 'hand', S.hand ? 'Опустить руку' : 'Поднять руку', S.hand ? 'active' : '', hands ? `<span class="count">${hands}</span>` : '')}
          ${tool('whiteboard', 'board', 'Доска', S.wbShared ? 'active' : '')}
          ${tool('panel:polls', 'poll', 'Опросы', S.panel === 'polls' ? 'active' : '')}
          ${tool('panel:rooms', 'split', 'Залы', S.panel === 'rooms' ? 'active' : '')}
          ${tool('captions', 'captions', 'Субтитры', S.captions ? 'active' : '')}
          ${tool('more', 'more', 'Ещё')}
        </div>
        <div class="group right"><button class="leave-btn" data-a="leave">${S.isHost ? 'Завершить' : 'Выйти'}</button></div>`;
      tb.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', e => this.action(b.dataset.a, b)));
    },

    action(a, btn) {
      const S = this.S;
      const [act, arg] = a.split(':');
      switch (act) {
        case 'mic': if (!S.mic && !S.isHost && !S.cohost && S.allowUnmute === false) { toast('Организатор запретил включать микрофон', 'bad'); return; } S.mic = !S.mic; if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = S.mic); if (S.mic && !(S.stream && S.stream.getAudioTracks().some(t => t.readyState === 'live'))) this.getMedia().then(() => { this.sendState(); this.renderToolbar && this.renderToolbar(); }); toast(S.mic ? 'Микрофон включён' : 'Микрофон выключен'); this.sendState(); break;
        case 'cam': S.cam = !S.cam; this.getMedia().then(() => { this.sendState(); this.renderStage(); }); break;
        case 'music': return this.toggleMusic();
        case 'micMenu': return this.micMenu(btn);
        case 'camMenu': return this.camMenu(btn);
        case 'security': return this.securityMenu(btn);
        case 'panel': S.panel = S.panel === arg ? null : arg; if (arg === 'chat') S.unread = 0; break;
        case 'share': return S.sharing === 'me' ? this.stopShare() : this.startShare();
        case 'shareMenu': return this.shareMenu(btn);
        case 'record': return S.recording ? this.stopRecording() : this.startRecording();
        case 'reactions': return this.reactionsMenu(btn);
        case 'hand': S.hand = !S.hand; S.chat.push({ sys: true, text: S.hand ? 'Вы подняли руку' : 'Вы опустили руку' }); this.sendState(); break;
        case 'whiteboard': return this.toggleWhiteboard();
        case 'annotate': return this.toggleAnnotations();
        case 'captions': return this.toggleCaptions();
        case 'more': return this.moreMenu(btn);
        case 'view': S.view = arg; break;
        case 'fullscreen': { const on = this.layer.classList.toggle('focus-mode'); toast(on ? 'Режим фокуса: верхняя панель скрыта (Esc — вернуть)' : 'Обычный режим', 'ok', 1800); return; }
        case 'info': return this.infoModal();
        case 'leave': return this.leaveMenu(btn);
      }
      this.renderRoom();
    },

    /* ---------- всплывающие меню ---------- */
    popover(anchor, html, setup, cls = '') {
      this.closePop();
      const pop = document.createElement('div'); pop.className = `popover ${cls}`; pop.innerHTML = html;
      const holder = anchor.closest('.tool-split') || anchor.closest('.tile-v') || anchor.closest('.group') || anchor;
      holder.style.position = 'relative'; holder.appendChild(pop);
      if (anchor.closest('.tile-v')) { pop.style.bottom = 'auto'; pop.style.top = '44px'; pop.style.left = 'auto'; pop.style.right = '8px'; pop.style.transform = 'none'; }
      if (anchor.closest('.group')) {
        const r = anchor.getBoundingClientRect(), hr = holder.getBoundingClientRect();
        pop.style.left = (r.left - hr.left + r.width / 2) + 'px';
      }
      setup && setup(pop);
      this.S.activePop = pop;
      if (anchor.closest('.side-panel')) {
        // меню в боковой панели: фиксированное позиционирование в пределах окна
        const r = anchor.getBoundingClientRect(); pop.style.position = 'fixed'; pop.style.bottom = 'auto'; pop.style.transform = 'none'; pop.style.right = 'auto';
        const h = pop.offsetHeight, w = pop.offsetWidth;
        pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6); if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
        pop.style.top = top + 'px'; pop.style.maxHeight = (window.innerHeight - 16) + 'px'; pop.style.overflowY = 'auto';
      }
      setTimeout(() => {
        const rect = pop.getBoundingClientRect();
        if (rect.top < 8 && pop.style.position !== 'fixed') { pop.style.bottom = 'auto'; pop.style.top = 'calc(100% + 6px)'; }
        if (rect.left < 8) { pop.style.left = 'auto'; pop.style.transform = 'none'; pop.style.right = 'auto'; pop.style.left = '8px'; }
        if (rect.right > window.innerWidth - 8) { pop.style.left = 'auto'; pop.style.transform = 'none'; pop.style.right = '8px'; }
        const off = e => { if (!pop.contains(e.target)) { this.closePop(); document.removeEventListener('pointerdown', off); } };
        document.addEventListener('pointerdown', off);
      }, 0);
    },
    closePop() { if (this.S && this.S.activePop) { this.S.activePop.remove(); this.S.activePop = null; } },

    micMenu(btn) {
      const S = this.S, d = App.devices;
      const list = (arr, sel, key) => arr.length ? arr.map(x => `<button data-dev="${key}:${x.deviceId}" class="${sel === x.deviceId ? 'checked' : ''}">${sel === x.deviceId ? icon('check') : '<span style="width:16px"></span>'} ${esc(x.label || 'Устройство')}</button>`).join('') : `<button disabled>${icon('info')} Устройства появятся после разрешения доступа</button>`;
      this.popover(btn, `
        <h5>Микрофон</h5>${list(d.mics, App.settings.micId || (d.mics[0] || {}).deviceId, 'mic')}
        <h5>Динамики</h5>${list(d.speakers, App.settings.spkId || (d.speakers[0] || {}).deviceId, 'spk')}
        <hr>
        <button data-o="noise" class="${S.noise ? 'checked' : ''}">${icon(S.noise ? 'check' : 'volume')} Подавление фонового шума</button>
        <button data-o="music" class="${S.music ? 'checked' : ''}">${icon('music')} Режим музыканта (оригинальный звук)</button>
        <button data-o="test">${icon('volume')} Проверить динамик и микрофон</button>
        <button data-o="leaveAudio">${icon('phone')} Отключить звук компьютера</button>
        <button data-o="settings">${icon('settings')} Настройки звука…</button>`, m => {
        m.querySelectorAll('[data-dev]').forEach(b => b.addEventListener('click', () => { const [k, id] = b.dataset.dev.split(':'); if (k === 'mic') { App.settings.micId = id; this.getMedia({ force: true }); } else App.settings.spkId = id; toast('Устройство переключено', 'ok'); this.closePop(); }));
        m.querySelectorAll('[data-o]').forEach(b => b.addEventListener('click', () => {
          const o = b.dataset.o; this.closePop();
          if (o === 'noise') { S.noise = !S.noise; this.getMedia({ force: true }); toast(S.noise ? 'Подавление шума включено' : 'Подавление шума выключено'); }
          if (o === 'music') this.toggleMusic();
          if (o === 'test') this.testAudio();
          if (o === 'leaveAudio') { S.mic = false; if (S.stream) S.stream.getAudioTracks().forEach(t => t.stop()); toast('Звук компьютера отключён'); this.renderToolbar(); this.renderStage(); }
          if (o === 'settings') App.openSettingsModal('audio');
        }));
      });
    },
    toggleMusic() {
      const S = this.S;
      S.music = !S.music;
      App.settings.music = S.music; App.saveSettings && App.saveSettings();
      this.getMedia({ force: true });
      toast(S.music ? 'Режим музыканта включён: шумоподавление, эхо и автогромкость отключены, стерео 48 кГц — для музыки, пения и презентаций со звуком' : 'Режим музыканта выключен — обычный звук для речи', S.music ? 'ok' : 'info', 6000);
      this.renderStage();
    },
    testAudio() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 660; g.gain.value = .08; o.connect(g).connect(ctx.destination); o.start();
        setTimeout(() => { o.frequency.value = 880; }, 180); setTimeout(() => { o.stop(); ctx.close(); }, 420);
        toast('Тестовый сигнал воспроизведён. Говорите — индикатор на вашей плитке подсветится', 'ok', 4000);
      } catch (e) { toast('Аудио недоступно', 'bad'); }
    },
    camMenu(btn) {
      const S = this.S, d = App.devices;
      this.popover(btn, `
        <h5>Камера</h5>
        ${d.cams.length ? d.cams.map(x => `<button data-cam="${x.deviceId}" class="${(App.settings.camId || (d.cams[0] || {}).deviceId) === x.deviceId ? 'checked' : ''}">${(App.settings.camId || (d.cams[0] || {}).deviceId) === x.deviceId ? icon('check') : '<span style="width:16px"></span>'} ${esc(x.label || 'Камера')}</button>`).join('') : `<button disabled>${icon('info')} Камеры появятся после разрешения доступа</button>`}
        <hr>
        <button data-o="bg">${icon('sparkles')} Выбрать виртуальный фон…</button>
        <button data-o="mirror" class="${S.mirror ? 'checked' : ''}">${icon(S.mirror ? 'check' : 'layout')} Зеркальное отображение</button>
        <button data-o="hd" class="${S.hd ? 'checked' : ''}">${icon(S.hd ? 'check' : 'video')} HD-видео (720p)</button>
        <button data-o="settings">${icon('settings')} Настройки видео…</button>`, m => {
        m.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => { App.settings.camId = b.dataset.cam; this.getMedia({ force: true }); this.closePop(); toast('Камера переключена', 'ok'); }));
        m.querySelectorAll('[data-o]').forEach(b => b.addEventListener('click', () => {
          const o = b.dataset.o; this.closePop();
          if (o === 'bg') this.bgModal();
          if (o === 'mirror') { S.mirror = !S.mirror; App.settings.mirror = S.mirror; this.attachSelf(); }
          if (o === 'hd') { S.hd = !S.hd; this.getMedia({ force: true }); toast(S.hd ? 'HD включено' : 'HD выключено'); }
          if (o === 'settings') App.openSettingsModal('video');
        }));
      });
    },
    bgModal() {
      const S = this.S;
      const opts = [['none', 'Без фона', 'linear-gradient(135deg,#1e293b,#0f172a)'], ['blur', 'Размытие', 'linear-gradient(135deg,#334155,#64748b)'], ['soft', 'Мягкий свет', 'linear-gradient(135deg,#fbbf24,#f472b6)'], ['formyla', 'FORMYLA', 'radial-gradient(circle at 30% 30%,rgba(56,189,248,.5),transparent 50%),radial-gradient(circle at 70% 70%,rgba(139,92,246,.5),transparent 50%),#0f172a'], ['board', 'Аудитория', 'linear-gradient(180deg,#1e3a5f,#0b1220)'], ['geo', 'Геометрия', 'repeating-linear-gradient(45deg,#1e293b 0 10px,#0f172a 10px 20px)']];
      App.modal(`Виртуальный фон`, `
        <p class="muted small">Размытие применяется к видеопотоку локально. Фоны с изображением показываются как рамка вокруг видео (демо-режим без сегментации).</p>
        <div class="cards-grid" style="grid-template-columns:repeat(3,1fr)">
          ${opts.map(([k, l, bg]) => `<button class="tile ${S.bg === k ? 'active' : ''}" data-bg="${k}" style="padding:10px;gap:8px;${S.bg === k ? 'border-color:#8b5cf6' : ''}"><span style="display:block;width:100%;aspect-ratio:16/9;border-radius:10px;background:${bg}"></span><span class="tile-title" style="font-size:13px">${l}</span></button>`).join('')}
        </div>`, [{ label: 'Готово', cls: 'btn-gradient', act: 'close' }], m => {
        m.querySelectorAll('[data-bg]').forEach(b => b.addEventListener('click', () => { S.bg = b.dataset.bg; App.settings.bg = S.bg; this.attachSelf(); this.applyFrameBg(); m.querySelectorAll('[data-bg]').forEach(x => x.style.borderColor = x === b ? '#8b5cf6' : ''); }));
      });
    },
    applyFrameBg() {
      const S = this.S; const bgs = { formyla: 'radial-gradient(circle at 30% 30%,rgba(56,189,248,.5),transparent 50%),radial-gradient(circle at 70% 70%,rgba(139,92,246,.5),transparent 50%),#0f172a', board: 'linear-gradient(180deg,#1e3a5f,#0b1220)', geo: 'repeating-linear-gradient(45deg,#1e293b 0 10px,#0f172a 10px 20px)' };
      this.layer.querySelectorAll('[data-self-video]').forEach(h => { h.style.background = bgs[S.bg] || ''; h.style.padding = bgs[S.bg] ? '6%' : '0'; const v = h.querySelector('video'); if (v) v.style.borderRadius = bgs[S.bg] ? '12px' : '0'; });
    },
    securityMenu(btn) {
      const S = this.S;
      const row = (k, l, v) => `<button data-s="${k}" class="${v ? 'checked' : ''}">${v ? icon('check') : '<span style="width:16px"></span>'} ${l}</button>`;
      this.popover(btn, `
        ${row('locked', 'Заблокировать встречу', S.locked)}
        ${row('waitingRoom', 'Включить зал ожидания', S.waitingRoom)}
        <hr><h5>Разрешить участникам</h5>
        ${row('allowShare', 'Демонстрацию экрана', S.allowShare)}
        ${row('allowChat', 'Чат', S.allowChat)}
        ${row('allowRename', 'Переименование', S.allowRename)}
        ${row('allowUnmute', 'Включать свой микрофон', S.allowUnmute)}
        <hr>
        <button data-s="muteAll">${icon('micOff')} Выключить звук всем</button>
        <button data-s="suspend" class="danger-text">${icon('shield')} Приостановить действия участников</button>`, m => {
        m.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
          const k = b.dataset.s;
          const settings = o => { Object.assign(S, o); RTC.send({ t: 'host', action: 'settings', settings: o }); };
          if (k === 'muteAll') { S.participants.forEach(p => p.mic = false); RTC.send({ t: 'host', action: 'muteAll' }); toast('Звук выключен у всех участников'); }
          else if (k === 'suspend') { settings({ locked: true, allowShare: false, allowChat: false, allowRename: false, allowUnmute: false }); RTC.send({ t: 'host', action: 'muteAll' }); S.participants.forEach(p => { p.mic = false; }); toast('Действия участников приостановлены: встреча заблокирована, чат и показ экрана отключены', 'bad', 5000); }
          else { settings({ [k]: !S[k] }); toast({ locked: S.locked ? 'Встреча заблокирована — новые участники не смогут войти' : 'Встреча разблокирована', waitingRoom: S.waitingRoom ? 'Зал ожидания включён' : 'Зал ожидания выключен', allowShare: 'Настройка сохранена', allowChat: 'Настройка сохранена', allowRename: 'Настройка сохранена', allowUnmute: 'Настройка сохранена' }[k]); }
          this.closePop(); this.renderRoom();
        }));
      });
    },
    shareMenu(btn) {
      this.popover(btn, `
        <button data-sh="screen">${icon('monitor')} Экран, окно или вкладка</button>
        <button data-sh="wb">${icon('board')} Доска для совместной работы</button>
        <button data-sh="cam2">${icon('video')} Вторая камера (документ-камера)</button>
        <button data-sh="audio">${icon('volume')} Только звук компьютера</button>
        <button data-sh="annot" ${S.sharing ? '' : 'disabled'}>${icon('pen')} Комментировать поверх экрана</button>
        <hr>
        <button data-sh="multi">${icon('users')} Разрешить одновременный показ нескольким</button>`, m => {
        m.querySelectorAll('[data-sh]').forEach(b => b.addEventListener('click', () => {
          const k = b.dataset.sh; this.closePop();
          if (k === 'screen') this.startShare();
          if (k === 'wb') this.toggleWhiteboard(true);
          if (k === 'cam2') toast('Подключите вторую камеру — она появится в списке камер');
          if (k === 'audio') this.startShare(true);
          if (k === 'annot') this.toggleAnnotations();
          if (k === 'multi') toast('Сейчас экран показывает один участник за раз: новый показ заменяет предыдущий');
        }));
      });
    },
    reactionsMenu(btn) {
      const S = this.S;
      this.popover(btn, `
        <div class="emoji-row">${['👍', '❤️', '😂', '😮', '🎉', '👏', '🔥', '🤔', '✅', '💯', '🙌', '😢'].map(e => `<button data-e="${e}">${e}</button>`).join('')}</div>
        <hr>
        <button data-r="hand">${icon('hand')} ${S.hand ? 'Опустить руку' : 'Поднять руку'}</button>
        <button data-r="slow">🐢 Помедленнее</button><button data-r="fast">🐇 Побыстрее</button>
        <button data-r="away">☕ Я отошёл</button>`, m => {
        m.querySelectorAll('[data-e]').forEach(b => b.addEventListener('click', () => { this.react('me', b.dataset.e); this.closePop(); }));
        m.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => { const r = b.dataset.r; this.closePop(); if (r === 'hand') this.action('hand'); else { this.react('me', { slow: '🐢', fast: '🐇', away: '☕' }[r]); S.chat.push({ sys: true, text: `Вы: ${b.textContent.trim()}` }); } }));
      });
    },
    react(id, emoji, remote) {
      const tile = this.layer.querySelector(`.tile-v[data-id="${id}"]`);
      if (tile) { const el = document.createElement('span'); el.className = 'reaction-float'; el.textContent = emoji; tile.appendChild(el); setTimeout(() => el.remove(), 2200); }
      if (id === 'me' && !remote) RTC.send({ t: 'react', emoji });
      if (id !== 'me' && remote && !tile) toast(`${this.peerName(id)}: ${emoji}`, 'info', 1500);
      if (id === 'me') { const f = document.createElement('span'); f.className = 'reaction-fly'; f.textContent = emoji; f.style.left = (window.innerWidth / 2 - 60 + Math.random() * 120) + 'px'; f.style.bottom = '90px'; document.body.appendChild(f); setTimeout(() => f.remove(), 2400); }
    },
    moreMenu(btn) {
      const S = this.S;
      this.popover(btn, `
        <button data-m="bg">${icon('sparkles')} Виртуальный фон и эффекты</button>
        <button data-m="stats">${icon('wifi')} Статистика соединения</button>
        <button data-m="timer">${icon('timer')} Таймер для встречи</button>
        <button data-m="invite">${icon('link')} Пригласить участников</button>
        <button data-m="apps">${icon('apps')} Приложения FORMYLA (задачи дня, методы)</button>
        <button data-m="layout">${icon(S.view === 'gallery' ? 'speaker' : 'grid')} ${S.view === 'gallery' ? 'Вид докладчика' : 'Вид галереи'}</button>
        <button data-m="hideSelf">${icon('videoOff')} Скрыть своё видео</button>
        <button data-m="shortcuts">${icon('keyboard')} Горячие клавиши</button>
        <hr>
        <button data-m="settings">${icon('settings')} Настройки</button>`, m => {
        m.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
          const k = b.dataset.m; this.closePop();
          if (k === 'bg') this.bgModal();
          if (k === 'stats') this.statsModal();
          if (k === 'timer') this.timerModal();
          if (k === 'invite') this.infoModal();
          if (k === 'apps') this.appsModal();
          if (k === 'layout') { S.view = S.view === 'gallery' ? 'speaker' : 'gallery'; this.renderRoom(); }
          if (k === 'hideSelf') { const t = this.layer.querySelector('.tile-v[data-id=me]'); if (t) t.classList.toggle('hidden'); toast('Ваше видео скрыто только для вас. Нажмите ещё раз, чтобы вернуть'); }
          if (k === 'shortcuts') App.modal('Горячие клавиши', `<ul style="display:grid;gap:8px;font-size:14px">${[['Alt + A', 'Микрофон вкл/выкл'], ['Alt + V', 'Видео вкл/выкл'], ['Пробел (удерж.)', 'Временно включить микрофон'], ['Alt + S', 'Демонстрация экрана'], ['Alt + R', 'Запись'], ['Alt + H', 'Чат'], ['Alt + U', 'Участники'], ['Alt + Y', 'Поднять руку'], ['Alt + W', 'Доска'], ['Alt + M', 'Режим музыканта'], ['Alt + C', 'Субтитры'], ['Alt + F', 'Полный экран'], ['Esc', 'Закрыть панели']].map(([k, v]) => `<li style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border-soft)"><span class="muted">${v}</span><kbd style="font-family:inherit;font-weight:800;background:rgba(255,255,255,.08);padding:2px 8px;border-radius:6px">${k}</kbd></li>`).join('')}</ul>`, [{ label: 'Понятно', cls: 'btn-gradient', act: 'close' }]);
          if (k === 'settings') App.openSettingsModal('general');
        }));
      });
    },
    async statsModal() {
      const S = this.S; const vt = S.stream && S.stream.getVideoTracks()[0]; const st = vt ? vt.getSettings() : {};
      const all = await Promise.all(S.participants.map(p => RTC.stats(p.id).then(x => x && Object.assign(x, { name: p.name }))));
      const rows = all.filter(Boolean);
      const rtts = rows.map(r => r.rtt).filter(x => x != null); const rtt = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
      const loss = rows.reduce((a, r) => a + (r.loss || 0), 0); const jit = rows.map(r => r.jitter).filter(x => x != null);
      App.modal('Статистика соединения', `
        <div class="stat-row" style="margin-top:0"><div class="stat"><b>${rtt == null ? '—' : rtt + ' мс'}</b><span>Задержка (RTT)</span></div><div class="stat"><b>${loss}</b><span>Потеряно пакетов</span></div><div class="stat"><b>${jit.length ? Math.max(...jit) + ' мс' : '—'}</b><span>Джиттер</span></div></div>
        <div class="stat-row"><div class="stat"><b>${st.width || 0}×${st.height || 0}</b><span>Разрешение отправки</span></div><div class="stat"><b>${st.frameRate ? Math.round(st.frameRate) : 0} fps</b><span>Кадры/с</span></div><div class="stat"><b>${S.participants.length}</b><span>Соединений</span></div></div>
        ${rows.length ? `<table style="width:100%;font-size:13px;margin-top:12px;border-collapse:collapse">${rows.map(r => `<tr style="border-top:1px solid var(--border-soft)"><td style="padding:6px 0">${esc(r.name)}</td><td class="muted">${r.rtt == null ? '—' : r.rtt + ' мс'}</td><td class="muted">${r.w ? r.w + '×' + r.h : '—'}</td><td class="muted">${r.fps ? Math.round(r.fps) + ' fps' : '—'}</td><td class="muted">${r.state === 'connected' ? (r.path === 'relay' ? 'через ретранслятор' : 'напрямую') : r.state === 'failed' ? 'нет соединения' : 'соединение…'}</td></tr>`).join('')}</table>` : '<p class="small muted" style="margin-top:12px">Пока других участников нет — сетевые показатели появятся, когда кто-то подключится.</p>'}
        <p class="small muted" style="margin-top:14px">Соединения устанавливаются между браузерами (WebRTC); данные — из статистики браузера. Ретранслятор (TURN) на сервере: ${RTC.turn ? 'настроен' : 'не настроен — участники за строгим NAT или VPN могут не соединиться'}.</p>`, [{ label: 'Закрыть', cls: 'btn-ghost', act: 'close' }]);
    },
    timerModal() {
      const S = this.S;
      App.modal('Таймер для встречи', `<label class="field">Длительность, минут<input type="number" id="tmMin" value="10" min="1" max="180"></label><p class="small muted">${this.S.isHost || this.S.cohost ? 'Таймер виден всем участникам в верхней панели.' : 'Таймер будет виден только вам.'}</p>`, [{ label: 'Отмена', cls: 'btn-ghost', act: 'close' }, { label: 'Запустить', cls: 'btn-gradient', act: 'ok' }], null, () => {
        const mins = +$('#tmMin').value || 10;
        this.startTimer(mins);
        if (S.isHost || S.cohost) RTC.send({ t: 'host', action: 'timer', mins }); else { S.chat.push({ sys: true, text: `Вы запустили таймер на ${mins} мин (виден только вам)` }); this.renderPanel(); }
      });
    },
    appsModal() {
      App.modal('Приложения FORMYLA', `<div class="cards-grid" style="grid-template-columns:1fr 1fr">
        ${[['📅', 'Задачи дня', 'Открыть текущую задачу дня прямо во встрече', 'https://formyla.net/daily_tasks/'], ['📚', 'Каталог методов (102)', 'Разобрать метод по теме занятия', 'https://formyla.net/olympiads/methods'], ['🏆', 'Календарь олимпиад', 'Ближайшие олимпиады и пробники', 'https://formyla.net/olympiad-prep/calendar'], ['🎓', 'Куратор подготовки', 'Индивидуальный план ученика', 'https://formyla.net/prep/coach']].map(([e, t, d, u]) => `<a class="tile" href="${u}" target="_blank" rel="noopener noreferrer"><span style="font-size:28px">${e}</span><span class="tile-title">${t}</span><span class="tile-desc">${d}</span></a>`).join('')}</div>`, [{ label: 'Закрыть', cls: 'btn-ghost', act: 'close' }]);
    },
    infoModal() {
      const S = this.S;
      App.modal('Информация о встрече', `
        <div style="display:grid;gap:10px;font-size:14px">
          <div><span class="muted">Тема</span><br><b>${esc(S.topic)}</b></div>
          <div><span class="muted">Идентификатор</span><br><b style="font-size:22px;letter-spacing:2px">${S.id}</b></div>
          <div><span class="muted">Организатор</span><br><b>${S.isHost ? esc(S.name) : esc((S.participants.find(p => p.host) || {}).name || 'Организатор встречи')}</b></div>
          <div><span class="muted">Код доступа</span><br><b>${S.pw || 'не требуется'}</b></div>
          <div><span class="muted">Ссылка для приглашения</span><br><code style="word-break:break-all;color:#7dd3fc">${this.inviteLink()}</code></div>
          <div><span class="muted">Шифрование</span><br><span class="tag ok">${icon('shield')} WebRTC DTLS-SRTP, соединения напрямую между участниками</span></div>
        </div>`, [{ label: 'Скопировать приглашение', cls: 'btn-gradient', act: 'ok' }, { label: 'Закрыть', cls: 'btn-ghost', act: 'close' }], null, () => this.copyInvite());
    },
    inviteLink() { return App.inviteLink(this.S.id, this.S.pw); },
    copyInvite() {
      const S = this.S; const text = `${S.name || 'Организатор'} приглашает вас на встречу FORMYLA Meet\n\nТема: ${S.topic}\nСсылка: ${this.inviteLink()}\nИдентификатор: ${S.id}${S.pw ? `\nКод доступа: ${S.pw}` : ''}`;
      navigator.clipboard ? navigator.clipboard.writeText(text).then(() => toast('Приглашение скопировано', 'ok')).catch(() => toast('Не удалось скопировать — скопируйте вручную из окна информации', 'bad')) : toast('Буфер обмена недоступен', 'bad');
    },
    leaveMenu(btn) {
      const S = this.S;
      this.popover(btn, `${S.isHost ? `<button data-l="end" class="danger-text">${icon('phone')} Завершить встречу для всех</button>${S.participants.length ? `<button data-l="assign">${icon('crown')} Выйти и назначить организатора</button>` : ''}` : ''}<button data-l="leave">${icon('logout')} Покинуть встречу</button>`, m => {
        m.querySelectorAll('[data-l]').forEach(b => b.addEventListener('click', () => {
          const k = b.dataset.l; this.closePop();
          if (k === 'assign') {
            App.modal('Назначить организатора', `<label class="field">Кто станет организатором<select id="asHost">${S.participants.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`, [{ label: 'Отмена', cls: 'btn-ghost', act: 'close' }, { label: 'Назначить и выйти', cls: 'btn-gradient', act: 'ok' }], null, () => { const id = $('#asHost').value; const p = S.participants.find(x => x.id === id); RTC.send({ t: 'host', action: 'makeHost', target: id }); if (p) toast(`${p.name} назначен организатором`); setTimeout(() => this.end(false), 150); });
            return;
          }
          this.end(k === 'end');
        }));
      }, 'right');
    },

    /* ---------- демонстрация экрана ---------- */
    async startShare(audioOnly) {
      const S = this.S;
      if (!S.isHost && !S.allowShare) return toast('Организатор запретил демонстрацию экрана', 'bad');
      try {
        S.displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 15, max: 30 } },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include'
        });
        if (S.wbShared) this.toggleWhiteboard();
        S.sharing = 'me'; S.wbShared = false; this.closeAnnotations();
        const vt = S.displayStream.getVideoTracks()[0]; const sat = S.displayStream.getAudioTracks()[0] || null;
        vt.addEventListener('ended', () => this.stopShare());
        RTC.setScreenTrack(vt, sat);
        this.sendState();
        S.chat.push({ sys: true, text: 'Вы начали демонстрацию экрана' + (sat ? ' со звуком компьютера' : '') });
        this.renderRoom();
        if (sat) toast('Демонстрация начата — участники видят экран и слышат звук компьютера', 'ok', 4000);
        else toast('Демонстрация начата без звука компьютера. Чтобы участники слышали звук, при выборе экрана включите «Поделиться звуком» (на macOS звук доступен только при показе вкладки)', 'info', 8000);
      } catch (e) {
        if (e.name === 'NotAllowedError') toast('Демонстрация отменена или запрещена в этом окне. Откройте приложение в отдельной вкладке', 'bad', 5000);
        else toast('Демонстрация экрана недоступна: ' + e.message, 'bad');
      }
    },
    stopShare(silent) {
      const S = this.S; if (S.displayStream) S.displayStream.getTracks().forEach(t => t.stop()); S.displayStream = null;
      RTC.setScreenTrack(null);
      if (S.sharing === 'me') S.chat.push({ sys: true, text: 'Вы остановили демонстрацию экрана' });
      if (S.sharing === 'me') { S.sharing = null; if (!silent) this.sendState(); }
      this.closeAnnotations(); this.renderRoom();
    },

    /* ---------- аннотации поверх демонстрации экрана ---------- */
    toggleAnnotations() {
      const S = this.S;
      if (!S.sharing) return toast('Сначала начните демонстрацию экрана', 'bad');
      if (S.annot) { const mine = S.sharing === 'me' || S.isHost || (S.annotState && S.me && S.annotState.by === S.me.id); this.closeAnnotations(); if (mine) RTC.send({ t: 'annot', action: 'close' }); }
      else { S.annot = true; S.annotState = S.annotState && S.annotState.open ? S.annotState : { open: true, pages: [{ shapes: [] }] }; RTC.send({ t: 'annot', action: 'open', pages: S.annotState.pages }); S.chat.push({ sys: true, text: 'Вы начали комментировать демонстрацию экрана' }); toast('Рисуйте поверх экрана — инструменты вверху. Пометки видят все участники', 'ok', 3500); }
      this.renderRoom();
    },
    closeAnnotations() {
      const S = this.S; if (S.annotWb) { S.annotWb.destroy(); S.annotWb = null; } S.annotPages = null; S.annot = false; S.annotState = null;
    },
    onRemoteAnnot(m) {
      const S = this.S;
      if (m.action === 'open') { if (!S.sharing) return; S.annotState = m.annot; S.annot = true; toast(`${this.peerName(m.from)} комментирует экран`, 'info', 2500); this.renderRoom(); }
      else if (m.action === 'close') { if (S.annot) { this.closeAnnotations(); this.renderRoom(); } }
      else if (m.action === 'sync' && m.annot) { S.annotState = m.annot; if (S.annotWb) this.applyPages(S.annotWb, m.annot.pages); }
    },
    /* применить страницы, пришедшие от другого участника (не прерывая текущий штрих) */
    applyPages(wb, pages) {
      if (!pages) return;
      if (wb.drawing || wb.dragging || wb.erasing) { wb.__pendingPages = pages; return; }
      const cur = wb.pages[wb.page];
      wb.pages = pages.map((p, i) => ({ shapes: p.shapes || [], undo: (wb.pages[i] || {}).undo || [], redo: [] }));
      if (!wb.pages.length) wb.pages = [{ shapes: [], undo: [], redo: [] }];
      wb.page = Math.min(wb.page, wb.pages.length - 1); wb.selected = null;
      if (wb.__lastBg && wb.bg !== wb.__lastBg) { /* фон меняет тот, кто прислал */ }
      wb.renderPages(); wb.render();
    },
    /* локальное изменение доски -> отправить всем (с учётом отложенных чужих изменений) */
    wbChanged(wb, kind) {
      const S = this.S;
      if (wb.__pendingPages) { const pend = wb.__pendingPages; wb.__pendingPages = null; pend.forEach((p, i) => { if (!wb.pages[i]) wb.pages[i] = { shapes: [], undo: [], redo: [] }; const ids = new Set(wb.pages[i].shapes.map(s => s.id)); (p.shapes || []).forEach(sh => { if (!ids.has(sh.id)) wb.pages[i].shapes.push(sh); }); }); wb.renderPages(); wb.render(); }
      clearTimeout(wb.__syncT);
      wb.__syncT = setTimeout(() => { if (this.S !== S) return; const pages = wb.pages.map(p => ({ shapes: p.shapes })); if (kind === 'annot') { if (S.annotState) S.annotState.pages = pages; RTC.send({ t: 'annot', action: 'sync', pages }); } else { if (S.wbState) S.wbState.pages = pages; RTC.send({ t: 'wb', action: 'sync', pages, bg: wb.bg, title: wb.title }); } }, 120);
    },
    mountAnnotations(container) {
      const S = this.S;
      const host = document.createElement('div'); host.className = 'annot-layer';
      container.appendChild(host);
      const saved = S.annotWb ? { pages: S.annotWb.pages, page: S.annotWb.page, tool: S.annotWb.tool, color: S.annotWb.color, size: S.annotWb.size, collapsed: !!S.annotWb.root.querySelector('.wb-top.collapsed') } : null;
      if (S.annotWb) S.annotWb.destroy();
      S.annotWb = new Whiteboard(host, { overlay: true, fitSpace: [1600, 900], title: 'Комментирование экрана', onClose: () => this.toggleAnnotations(), underlay: () => S.sharing === 'me' ? this.shareVideo : this.remoteVideos['screen:' + S.sharing], collaborators: S.participants.map(p => ({ name: p.name.split(' ')[0], initials: p.initials, color: p.solid })), onChange: () => this.wbChanged(S.annotWb, 'annot'), onCursor: p => RTC.send({ t: 'wbcur', kind: 'annot', x: p.x, y: p.y }) });
      if (saved) { S.annotWb.pages = saved.pages; S.annotWb.page = saved.page; S.annotWb.setColor(saved.color); S.annotWb.size = saved.size; S.annotWb.setTool(saved.tool); S.annotWb.render(); if (saved.collapsed) S.annotWb.root.querySelector('[data-act=hide]').click(); }
      else if (S.annotState && S.annotState.pages) this.applyPages(S.annotWb, S.annotState.pages);
    },

    /* ---------- доска ---------- */
    toggleWhiteboard(force) {
      const S = this.S;
      if (S.wbShared && !force) {
        const mine = S.isHost || S.cohost || (S.wbState && S.me && S.wbState.by === S.me.id);
        S.wbShared = false; if (S.wb) { S.wb.destroy(); S.wb = null; } S.chat.push({ sys: true, text: mine ? 'Доска закрыта' : 'Вы скрыли доску (у остальных она открыта)' });
        if (mine) { RTC.send({ t: 'wb', action: 'close' }); S.wbState = null; }
      } else if (!S.wbShared) {
        if (!S.isHost && !S.cohost && S.allowShare === false) return toast('Организатор запретил показ доски и экрана', 'bad');
        if (S.sharing === 'me' || S.displayStream) this.stopShare();
        S.wbShared = true; S.sharing = null;
        const pages = S.wbState && S.wbState.pages ? S.wbState.pages : [{ shapes: [] }];
        S.wbState = { open: true, by: S.me && S.me.id, title: `Доска · ${S.topic}`, pages, page: 0, bg: 'dots' };
        RTC.send({ t: 'wb', action: 'open', title: S.wbState.title, pages, bg: 'dots' });
        S.chat.push({ sys: true, text: 'Вы открыли общую доску' });
      }
      this.renderRoom();
    },
    onRemoteWb(m) {
      const S = this.S;
      if (m.action === 'open') { if (S.sharing === 'me') this.stopShare(true); S.sharing = null; S.wbState = m.wb; S.wbShared = true; if (S.wb) { S.wb.destroy(); S.wb = null; } toast(`${this.peerName(m.from)} открыл общую доску`, 'info', 3000); this.renderRoom(); }
      else if (m.action === 'close') { if (S.wbShared) { S.wbShared = false; if (S.wb) { S.wb.destroy(); S.wb = null; } S.wbState = null; S.chat.push({ sys: true, text: `${this.peerName(m.from)} закрыл доску` }); this.renderRoom(); } }
      else if (m.action === 'sync' && m.wb) { S.wbState = m.wb; if (S.wb) { if (m.wb.bg && S.wb.bg !== m.wb.bg) S.wb.bg = m.wb.bg; this.applyPages(S.wb, m.wb.pages); } }
    },
    mountWhiteboard(container) {
      const S = this.S;
      const host = document.createElement('div'); host.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:#fbfbfe;color:#0f172a';
      container.appendChild(host);
      const saved = S.wb ? { pages: S.wb.pages, page: S.wb.page, title: S.wb.title, bg: S.wb.bg, zoom: S.wb.zoom, panX: S.wb.panX, panY: S.wb.panY } : null;
      if (S.wb) S.wb.destroy();
      S.wb = new Whiteboard(host, { title: saved ? saved.title : (S.wbState && S.wbState.title) || `Доска · ${S.topic}`, onClose: () => this.toggleWhiteboard(), collaborators: S.participants.map(p => ({ name: p.name.split(' ')[0], initials: p.initials, color: p.solid })), onChange: () => { S.wbDirty = true; this.wbChanged(S.wb, 'wb'); }, onCursor: p => RTC.send({ t: 'wbcur', kind: 'wb', x: p.x, y: p.y }) });
      if (saved) { S.wb.pages = saved.pages; S.wb.page = saved.page; S.wb.bg = saved.bg; S.wb.zoom = saved.zoom || 1; S.wb.panX = saved.panX || 0; S.wb.panY = saved.panY || 0; S.wb.updateZoomLabel(); S.wb.setTool(S.wb.tool); S.wb.renderPages(); S.wb.render(); }
      else if (S.wbState && S.wbState.pages) { if (S.wbState.bg) S.wb.bg = S.wbState.bg; this.applyPages(S.wb, S.wbState.pages); }
    },

    /* ---------- запись ---------- */
    startRecording() {
      const S = this.S;
      if (!window.MediaRecorder) return toast('Запись не поддерживается этим браузером', 'bad');
      const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720; const cx = cv.getContext('2d');
      S.recCanvas = cv;
      const draw = () => {
        if (!S.recording) return;
        cx.fillStyle = '#0b1220'; cx.fillRect(0, 0, 1280, 720);
        const all = [{ name: S.name, initials: App.user.initials, solid: '#8b5cf6', me: true }, ...S.participants];
        const shareV = S.sharing === 'me' ? this.shareVideo : (S.sharing ? this.remoteVideos['screen:' + S.sharing] : null);
        const hasShare = shareV && shareV.videoWidth;
        let gx = 0, gw = 1280;
        if (hasShare) { gx = 960; gw = 320; const vr = shareV.videoWidth / shareV.videoHeight, tr = 952 / 660; let dw = 952, dh = 660; if (vr > tr) dh = 952 / vr; else dw = 660 * vr; cx.fillStyle = '#000'; cx.fillRect(4, 4, 952, 660); cx.drawImage(shareV, 4 + (952 - dw) / 2, 4 + (660 - dh) / 2, dw, dh); }
        const n = all.length, cols = hasShare ? 1 : n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), w = gw / cols, h = 660 / rows;
        all.forEach((p, i) => {
          const x = gx + (i % cols) * w + 8, y = Math.floor(i / cols) * h + 8, tw = w - 16, th = h - 16;
          cx.fillStyle = '#172033'; cx.beginPath(); cx.roundRect ? cx.roundRect(x, y, tw, th, 16) : cx.rect(x, y, tw, th); cx.fill();
          const rv = p.me ? (this.selfVideo && this.selfVideo.srcObject && S.cam ? this.selfVideo : null) : (p.cam ? this.remoteVideos[p.id] : null);
          if (rv && rv.videoWidth) {
            cx.save(); cx.beginPath(); cx.roundRect ? cx.roundRect(x, y, tw, th, 16) : cx.rect(x, y, tw, th); cx.clip();
            const vr = rv.videoWidth / rv.videoHeight, tr = tw / th; let dw = tw, dh = th; if (vr > tr) dw = th * vr; else dh = tw / vr;
            if (p.me && S.mirror) { cx.translate(x + tw, 0); cx.scale(-1, 1); cx.drawImage(rv, (tw - dw) / 2, y + (th - dh) / 2, dw, dh); } else cx.drawImage(rv, x + (tw - dw) / 2, y + (th - dh) / 2, dw, dh);
            cx.restore();
          } else { cx.fillStyle = p.solid || '#8b5cf6'; cx.beginPath(); cx.arc(x + tw / 2, y + th / 2, Math.min(tw, th) / 5, 0, 7); cx.fill(); cx.fillStyle = '#fff'; cx.font = `800 ${Math.min(tw, th) / 7}px Satoshi, sans-serif`; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(p.initials, x + tw / 2, y + th / 2); }
          cx.fillStyle = 'rgba(6,10,20,.75)'; cx.fillRect(x + 12, y + th - 40, cx.measureText(p.name).width * .6 + 60, 28);
          cx.fillStyle = '#fff'; cx.font = '700 16px Satoshi, sans-serif'; cx.textAlign = 'left'; cx.textBaseline = 'middle'; cx.fillText((p.me ? 'Вы · ' : '') + p.name, x + 22, y + th - 26);
        });
        cx.fillStyle = '#94a3b8'; cx.font = '700 14px Satoshi, sans-serif'; cx.textAlign = 'left'; cx.fillText(`FORMYLA Meet · ${S.topic} · ${fmtTime(S.secs)}`, 16, 700);
        cx.fillStyle = '#ef4444'; cx.beginPath(); cx.arc(1250, 700, 6, 0, 7); cx.fill();
        S.recRaf = requestAnimationFrame(draw);
      };
      const stream = cv.captureStream(15);
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)(); const dest = ctx.createMediaStreamDestination(); S.recMix = { ctx, dest, added: new Set() };
        const addSrc = (ms) => { if (!ms || !ms.getAudioTracks().length || S.recMix.added.has(ms)) return; S.recMix.added.add(ms); ctx.createMediaStreamSource(ms).connect(dest); };
        if (S.stream) addSrc(S.stream);
        S.participants.forEach(p => { addSrc(RTC.remoteStream(p.id)); addSrc(RTC.remoteScreen(p.id)); });
        if (S.displayStream) addSrc(S.displayStream);
        S.recMix.add = addSrc;
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch (e) { if (S.stream) S.stream.getAudioTracks().forEach(t => stream.addTrack(t)); }
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      try { S.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (e) { return toast('Не удалось начать запись: ' + e.message, 'bad'); }
      const rec = S.recorder; S.recChunks = []; rec.ondataavailable = e => { if (e.data.size) S.recChunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(S.recChunks, { type: rec.mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        App.recordings.unshift({ id: 'r' + Date.now(), topic: S.topic, date: new Date(), dur: fmtTime(S.recSecs || 0).replace(/^00:/, ''), size: (blob.size / 1048576).toFixed(1) + ' МБ', src: url, blob });
        toast('Запись сохранена в разделе «Записи»', 'ok', 5000);
      };
      S.recording = true; S.recPaused = false; S.recStart = S.secs; S.recSecs = 0;
      S.recorder.start(1000); draw();
      S.recTick = setInterval(() => { if (!S.recPaused) S.recSecs++; }, 1000); this.timers.push(S.recTick);
      S.chat.push({ sys: true, text: 'Запись встречи начата. Участники уведомлены' });
      this.renderRoom();
    },
    stopRecording() {
      const S = this.S; if (!S.recorder) return;
      S.recording = false; cancelAnimationFrame(S.recRaf); clearInterval(S.recTick);
      try { S.recorder.stop(); } catch (e) { /* уже остановлен */ }
      S.recorder = null; S.chat.push({ sys: true, text: 'Запись остановлена' });
      if (S.recMix) { try { S.recMix.ctx.close(); } catch (e) { } S.recMix = null; }
      this.renderRoom();
    },

    /* ---------- субтитры ---------- */
    toggleCaptions() {
      const S = this.S; S.captions = !S.captions;
      if (S.captions) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
          try {
            S.rec = new SR(); S.rec.lang = 'ru-RU'; S.rec.continuous = true; S.rec.interimResults = true;
            S.rec.onresult = e => { const r = e.results[e.results.length - 1]; const text = r[0].transcript; this.caption(S.name, text); if (r.isFinal || !S.capSentAt || Date.now() - S.capSentAt > 700) { S.capSentAt = Date.now(); RTC.send({ t: 'caption', text }); } };
            S.rec.onerror = () => { }; S.rec.onend = () => { if (S.captions && S.rec) try { S.rec.start(); } catch (e) { } };
            S.rec.start(); toast('Субтитры включены: ваша речь распознаётся и показывается участникам с включёнными субтитрами', 'ok', 4500);
          } catch (e) { toast('Субтитры включены: вы будете видеть речь участников, у которых работает распознавание', 'ok', 4500); }
        } else toast('Субтитры включены: вы будете видеть речь участников, у которых работает распознавание (в этом браузере оно недоступно)', 'ok', 5000);
      } else { if (S.rec) { S.rec.onend = null; S.rec.stop(); S.rec = null; } S.captionText = ''; }
      this.renderRoom();
    },
    caption(who, text) {
      const S = this.S; S.captionText = `<b>${esc(who)}:</b> ${esc(text)}`;
      const el = $('#captions', this.layer); if (el) { el.innerHTML = S.captionText; el.classList.toggle('hidden', !S.captions); }
      clearTimeout(S.capT); S.capT = setTimeout(() => { S.captionText = ''; const e = $('#captions', this.layer); if (e) e.classList.add('hidden'); }, 6000);
    },

    /* ---------- боковая панель ---------- */
    renderPanel() {
      const S = this.S, sp = $('#sidePanel', this.layer); if (!sp) return;
      sp.classList.toggle('hidden', !S.panel); if (!S.panel) return;
      const tabs = [['participants', `Участники (${S.participants.length + 1})`], ['chat', 'Чат'], ['polls', 'Опросы'], ['rooms', 'Залы']];
      let body = '', foot = '';
      if (S.panel === 'participants') {
        const pi = p => `<div class="p-item" data-pid="${p.id}"><span class="avatar avatar-sm" style="background:${p.color}">${p.initials}</span><span class="p-name">${esc(p.name)}${p.me ? ' (Вы)' : ''}<small>${p.host ? 'Организатор' : p.cohost ? 'Соорганизатор' : p.room ? 'Зал ' + p.room : 'Участник'}</small></span>${p.hand ? '<span title="Рука поднята">✋</span>' : ''}<span class="p-icons">${p.mic ? icon('mic', 'on') : icon('micOff', 'off')}${p.cam ? icon('video', 'on') : icon('videoOff', 'off')}</span>${(S.isHost || S.cohost) && !p.me ? `<button class="btn-icon p-more" data-pmenu="${p.id}">${icon('moreV')}</button>` : ''}</div>`;
        const me = { id: 'me', name: S.name, initials: App.user.initials, color: App.user.color, mic: S.mic, cam: S.cam, hand: S.hand, host: S.isHost, cohost: S.cohost, room: S.myRoom, me: true };
        body = `
          ${S.waiting.length ? `<div class="p-group">В зале ожидания (${S.waiting.length})</div>${S.waiting.map(w => `<div class="waiting-item"><span class="avatar avatar-sm" style="background:${w.color}">${w.initials}</span><span class="p-name">${esc(w.name)}</span><button class="btn-gradient btn-sm" data-admit="${w.id}">Впустить</button><button class="btn-ghost btn-sm" data-deny="${w.id}">${icon('x')}</button></div>`).join('')}${S.waiting.length > 1 ? `<button class="btn-ghost btn-sm" data-admitall>Впустить всех</button>` : ''}` : ''}
          <div class="p-group">Во встрече (${S.participants.length + 1})</div>
          ${pi(me)}${[...S.participants].sort((a, b) => (b.hand - a.hand) || (b.host - a.host)).map(pi).join('')}`;
        foot = S.isHost || S.cohost ? `<button class="btn-ghost btn-sm" data-pa="invite">${icon('link')} Пригласить</button><button class="btn-ghost btn-sm" data-pa="muteAll">${icon('micOff')} Выкл. звук всем</button><button class="btn-ghost btn-sm" data-pa="lowerAll">${icon('hand')} Опустить руки</button>` : `<button class="btn-ghost btn-sm" data-pa="invite">${icon('link')} Пригласить</button>`;
      }
      if (S.panel === 'chat') {
        body = `<div id="chatList" style="display:flex;flex-direction:column;gap:12px">${S.chat.map(m => m.sys ? `<div class="chat-msg system"><div class="bubble"><div class="text">${esc(m.text)}</div></div></div>` : `<div class="chat-msg ${m.me ? 'me' : ''}"><span class="avatar" style="background:${m.color}">${m.initials}</span><div class="bubble"><div class="meta"><b>${esc(m.from)}</b>${m.to && m.to !== 'all' ? `<span class="private">→ ${esc(m.toName)} (лично)</span>` : ''}<span>${m.time}</span></div><div class="text">${m.file ? (m.data ? `<a class="file" href="${m.data}" download="${esc(m.fileName || 'file')}" style="color:#7dd3fc">${icon('file')} ${esc(m.file)} · скачать</a>` : `<span class="file">${icon('file')} ${esc(m.file)}</span>`) : App.linkify(esc(m.text))}</div></div></div>`).join('')}</div><div class="typing" id="typing"></div>`;
        foot = `<div class="chat-input"><div class="to">Кому: <select id="chatTo">${[['all', 'Все'], ...S.participants.map(p => [p.id, p.name])].map(([v, l]) => `<option value="${v}" ${S.chatTo === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><label class="btn-icon" title="Прикрепить файл" style="margin-left:auto">${icon('file')}<input type="file" class="sr-only" id="chatFile"></label><button class="btn-icon" id="chatEmoji" title="Эмодзи">${icon('smile')}</button></div><div class="row"><textarea id="chatText" placeholder="${S.allowChat || S.isHost || S.cohost ? 'Введите сообщение… (Enter — отправить)' : 'Чат отключён организатором'}" ${S.allowChat || S.isHost || S.cohost ? '' : 'disabled'}></textarea><button class="btn-gradient" id="chatSend" style="padding:0 14px">${icon('send')}</button></div></div>`;
      }
      if (S.panel === 'polls') {
        const cnt = (p, j) => Object.values(p.votes || {}).filter(v => v === j).length, tot = p => Object.keys(p.votes || {}).length;
        body = S.polls.length ? S.polls.map((p, i) => { const my = S.me ? p.votes[S.me.id] : null; return `<div class="poll" data-poll="${i}"><h4>${esc(p.q)}</h4>${p.opts.map((o, j) => { const total = tot(p) || 1; const pct = Math.round(cnt(p, j) / total * 100); return `<div class="opt ${my === j ? 'voted' : ''}" data-vote="${j}"><div class="lbl"><span>${esc(o)}</span><span>${cnt(p, j)} · ${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`; }).join('')}<div class="poll-foot"><span>${tot(p)} голосов · ${p.anon ? 'анонимно' : 'открыто'} · ${p.open ? 'идёт' : 'завершён'}</span>${S.isHost || S.cohost ? `<button class="btn-ghost btn-sm" data-pollend="${i}">${p.open ? 'Завершить' : 'Поделиться итогами'}</button>` : ''}</div></div>`; }).join('') : `<div class="empty">${icon('poll')}Опросов пока нет${S.isHost || S.cohost ? '. Создайте первый — участники проголосуют прямо во встрече' : ''}</div>`;
        foot = S.isHost || S.cohost ? `<button class="btn-gradient btn-sm" data-pa="newPoll">${icon('plus')} Создать опрос</button><button class="btn-ghost btn-sm" data-pa="quiz">${icon('sparkles')} Викторина по задаче</button>` : '';
      }
      if (S.panel === 'rooms') {
        body = S.rooms.length ? S.rooms.map((r, i) => `<div class="br-room"><h4>${esc(r.name)} <span class="tag ${r.open ? 'ok' : ''}">${r.open ? 'открыт' : 'закрыт'}</span></h4><div class="members">${S.participants.filter(p => p.room === i + 1).map(p => `<span>${esc(p.name)}</span>`).join('') || '<span class="muted">пусто</span>'}</div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${S.isHost || S.cohost ? `<button class="btn-ghost btn-sm" data-bcast="${i}">Сообщение</button>${S.participants.filter(p => p.room !== i + 1).length ? `<select class="btn-ghost btn-sm" data-assign="${i}" style="max-width:160px"><option value="">Назначить участника…</option>${S.participants.filter(p => p.room !== i + 1).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}` : (S.myRoom === i + 1 ? '<span class="tag ok">вы здесь</span>' : '')}</div></div>`).join('') + `<p class="small muted" style="margin-top:10px">Залы — это распределение участников на группы: список видят все, а видео и звук остаются общими для встречи.</p>` : `<div class="empty">${icon('split')}Сессионные залы не созданы${S.isHost || S.cohost ? '. Разделите участников на малые группы для работы над задачами' : ''}</div>`;
        foot = S.isHost || S.cohost ? (S.rooms.length ? `<button class="btn-gradient btn-sm" data-pa="openRooms">${S.rooms[0].open ? 'Закрыть все залы' : 'Открыть все залы'}</button><button class="btn-ghost btn-sm" data-pa="recreate">${icon('split')} Пересоздать</button><button class="btn-ghost btn-sm" data-pa="bcastAll">${icon('bell')} Всем залам</button>` : `<button class="btn-gradient btn-sm" data-pa="createRooms">${icon('plus')} Создать залы</button>`) : '';
      }
      sp.innerHTML = `<div class="side-head"><span>${tabs.find(t => t[0] === S.panel)[1]}</span><button class="btn-icon" data-close>${icon('x')}</button></div>
        <div class="side-tabs">${tabs.map(([k, l]) => `<button class="${S.panel === k ? 'active' : ''}" data-tab="${k}">${l.replace(/\s\(.*\)/, '')}</button>`).join('')}</div>
        <div class="side-body">${body}</div>${foot ? `<div class="side-foot">${foot}</div>` : ''}`;
      sp.querySelector('[data-close]').addEventListener('click', () => { S.panel = null; this.renderRoom(); });
      sp.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { S.panel = b.dataset.tab; if (S.panel === 'chat') S.unread = 0; this.renderRoom(); }));
      sp.querySelectorAll('[data-pmenu]').forEach(b => b.addEventListener('click', () => this.participantMenu(b.dataset.pmenu, b)));
      sp.querySelectorAll('[data-admit]').forEach(b => b.addEventListener('click', () => this.admit(b.dataset.admit)));
      sp.querySelectorAll('[data-deny]').forEach(b => b.addEventListener('click', () => { RTC.send({ t: 'host', action: 'deny', target: b.dataset.deny }); S.waiting = S.waiting.filter(w => w.id !== b.dataset.deny); toast('Участнику отказано во входе'); this.renderRoom(); }));
      const aa = sp.querySelector('[data-admitall]'); aa && aa.addEventListener('click', () => { RTC.send({ t: 'host', action: 'admitAll' }); toast('Все участники впущены', 'ok'); });
      sp.querySelectorAll('[data-pa]').forEach(b => b.addEventListener('click', () => this.panelAction(b.dataset.pa)));
      sp.querySelectorAll('[data-vote]').forEach(o => o.addEventListener('click', () => { const pi = +o.closest('.poll').dataset.poll, j = +o.dataset.vote, p = S.polls[pi]; if (!p.open) return toast('Опрос уже завершён', 'bad'); if (S.me) p.votes[S.me.id] = j; RTC.send({ t: 'poll', action: 'vote', id: p.id, opt: j }); this.renderPanel(); }));
      sp.querySelectorAll('[data-pollend]').forEach(b => b.addEventListener('click', () => { const p = S.polls[+b.dataset.pollend]; if (p.open) { RTC.send({ t: 'poll', action: 'end', id: p.id }); toast('Опрос завершён'); } else { RTC.send({ t: 'poll', action: 'share', id: p.id }); toast('Итоги отправлены в чат', 'ok'); } }));
      sp.querySelectorAll('[data-assign]').forEach(sel => sel.addEventListener('change', () => { if (sel.value) RTC.send({ t: 'rooms', action: 'assign', target: sel.value, room: +sel.dataset.assign + 1 }); }));
      sp.querySelectorAll('[data-bcast]').forEach(b => b.addEventListener('click', () => { const t = prompt('Сообщение для зала'); if (t) { RTC.send({ t: 'rooms', action: 'bcast', room: +b.dataset.bcast + 1, text: t }); toast('Сообщение отправлено в зал', 'ok'); } }));
      if (S.panel === 'chat') this.bindChat(sp);
    },
    admit(id) {
      const S = this.S; const w = S.waiting.find(x => x.id === id);
      RTC.send({ t: 'host', action: 'admit', target: id });
      S.waiting = S.waiting.filter(x => x.id !== id);
      this.layer.querySelectorAll('.room-alert').forEach(al => al.remove());
      if (w) toast(`${w.name} впущен во встречу`, 'ok'); this.renderRoom();
    },
    panelAction(a) {
      const S = this.S;
      if (a === 'invite') this.infoModal();
      if (a === 'muteAll') { S.participants.forEach(p => p.mic = false); RTC.send({ t: 'host', action: 'muteAll' }); toast('Звук выключен у всех'); }
      if (a === 'lowerAll') { S.participants.forEach(p => p.hand = false); S.hand = false; RTC.send({ t: 'host', action: 'lowerAll' }); this.sendState(); }
      if (a === 'newPoll') return this.pollModal();
      if (a === 'quiz') return this.pollModal({ q: 'Задача 5: чему равен угол ∠BAC, если ∠BOC = 100°?', opts: ['40°', '50°', '80°', '100°'] });
      if (a === 'createRooms') return this.roomsModal();
      if (a === 'recreate') return this.roomsModal();
      if (a === 'openRooms') { const open = !S.rooms[0].open; RTC.send({ t: 'rooms', action: 'open', open }); toast(open ? 'Залы открыты' : 'Залы закрыты'); }
      if (a === 'bcastAll') { const t = prompt('Сообщение всем залам'); if (t) { RTC.send({ t: 'rooms', action: 'bcast', room: null, text: t }); toast('Отправлено во все залы', 'ok'); } }
      this.renderRoom();
    },
    pollModal(pre = {}) {
      const S = this.S;
      App.modal('Новый опрос', `<label class="field">Вопрос<input type="text" id="pq" value="${esc(pre.q || '')}" placeholder="Например: какой метод подходит для задачи 3?"></label>
        <div id="popts" style="display:grid;gap:8px">${(pre.opts || ['', '']).map((o, i) => `<input type="text" value="${esc(o)}" placeholder="Вариант ${i + 1}">`).join('')}</div>
        <button class="btn-ghost btn-sm" id="paddopt" type="button">${icon('plus')} Добавить вариант</button>
        <label class="check"><input type="checkbox" id="panon"> Анонимное голосование</label>`, [{ label: 'Отмена', cls: 'btn-ghost', act: 'close' }, { label: 'Запустить', cls: 'btn-gradient', act: 'ok' }], m => {
        $('#paddopt', m).addEventListener('click', () => { const i = document.createElement('input'); i.type = 'text'; i.placeholder = 'Вариант ' + ($('#popts', m).children.length + 1); $('#popts', m).appendChild(i); });
      }, () => {
        const q = $('#pq').value.trim(); const opts = [...$('#popts').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
        if (!q || opts.length < 2) return toast('Нужен вопрос и минимум два варианта', 'bad');
        RTC.send({ t: 'poll', action: 'new', q, opts, anon: $('#panon').checked });
        S.panel = 'polls'; toast('Опрос запущен', 'ok'); this.renderRoom();
      });
    },
    roomsModal() {
      const S = this.S;
      App.modal('Сессионные залы', `<div class="field-row"><label class="field">Количество залов<input type="number" id="brN" value="2" min="1" max="10"></label><label class="field">Распределение<select id="brMode"><option value="auto">Автоматически</option><option value="manual">Вручную</option><option value="self">Участники выбирают сами</option></select></label></div>
        <div class="field-row"><label class="field">Автозакрытие через, мин<input type="number" id="brT" value="15" min="0"></label><label class="field">Обратный отсчёт при закрытии, сек<input type="number" id="brC" value="60" min="0"></label></div>
        <label class="check"><input type="checkbox" id="brRet" checked> Разрешить возврат в основной зал в любое время</label>`, [{ label: 'Отмена', cls: 'btn-ghost', act: 'close' }, { label: 'Создать', cls: 'btn-gradient', act: 'ok' }], null, () => {
        const n = Math.max(1, Math.min(10, +$('#brN').value || 2));
        RTC.send({ t: 'rooms', action: 'create', rooms: Array.from({ length: n }, (_, i) => ({ name: `Зал ${i + 1}` })), mode: $('#brMode').value });
        toast(`Создано залов: ${n}`, 'ok');
      });
    },
    bindChat(sp) {
      const S = this.S, ta = $('#chatText', sp), list = $('#chatList', sp);
      if (list) list.parentElement.scrollTop = list.parentElement.scrollHeight;
      $('#chatTo', sp).addEventListener('change', e => S.chatTo = e.target.value);
      const send = () => {
        const t = ta.value.trim(); if (!t) return;
        const to = S.chatTo, toP = S.participants.find(p => p.id === to);
        if (to !== 'all' && !toP) { S.chatTo = 'all'; return toast('Этот участник уже вышел', 'bad'); }
        S.chat.push({ from: S.name, me: true, initials: App.user.initials, color: App.user.color, text: t, time: now(), to, toName: toP ? toP.name : '' });
        RTC.send({ t: 'chat', text: t, to });
        ta.value = ''; this.renderPanel();
      };
      $('#chatSend', sp).addEventListener('click', send);
      ta && ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      $('#chatFile', sp).addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; if (f.size > 3 * 1048576) return toast('Файл больше 3 МБ — отправьте ссылку на него', 'bad', 4000); const rd = new FileReader(); rd.onload = () => { const label = `${f.name} · ${f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(f.size / 1024)) + " КБ"}`; S.chat.push({ from: S.name, me: true, initials: App.user.initials, color: App.user.color, file: label, fileName: f.name, data: rd.result, time: now(), to: S.chatTo }); RTC.send({ t: 'chat', file: label, fileName: f.name, data: rd.result, to: S.chatTo }); this.renderPanel(); }; rd.readAsDataURL(f); });
      $('#chatEmoji', sp).addEventListener('click', e => { this.popover(e.currentTarget, `<div class="emoji-row">${['😀', '👍', '❤️', '🎉', '🤔', '👏', '🔥', '✅', '📐', '📏', '✏️', '🧮'].map(x => `<button data-e="${x}">${x}</button>`).join('')}</div>`, m => m.querySelectorAll('[data-e]').forEach(b => b.addEventListener('click', () => { ta.value += b.dataset.e; this.closePop(); ta.focus(); }))); e.currentTarget.closest('.chat-input').style.position = 'relative'; });
      ta && ta.focus();
    },
    /* ---------- клавиатура ---------- */
    keys(e) {
      const S = this.S; if (!S || !S.joined || S.ended) return;
      if (e.target.matches('input, textarea, [contenteditable]')) return;
      if (e.altKey) {
        const map = { a: 'mic', v: 'cam', s: 'share', r: 'record', h: 'panel:chat', u: 'panel:participants', y: 'hand', w: 'whiteboard', c: 'captions', f: 'fullscreen', m: 'music' };
        const k = e.key.toLowerCase(); const ru = { 'ф': 'a', 'м': 'v', 'ы': 's', 'к': 'r', 'р': 'h', 'г': 'u', 'н': 'y', 'ц': 'w', 'с': 'c', 'а': 'f', 'ь': 'm' };
        const a = map[k] || map[ru[k]]; if (a) { e.preventDefault(); this.action(a); }
      }
      if (e.key === 'Escape') { this.closePop(); this.layer.classList.remove('focus-mode'); if (S.panel) { S.panel = null; this.renderRoom(); } }
      if (e.code === 'Space' && !S.mic && !e.repeat && !e.target.closest('button, a, select, [role="button"]') && S.stream && S.stream.getAudioTracks().length) {
        e.preventDefault(); S.ptt = true; S.stream.getAudioTracks().forEach(t => t.enabled = true); toast('Микрофон включён, пока удерживаете пробел');
        const release = () => { if (!S.ptt) return; S.ptt = false; if (S.stream && !S.mic) S.stream.getAudioTracks().forEach(t => t.enabled = false); document.removeEventListener('keyup', onUp); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', release); };
        const onUp = ev => { if (ev.code === 'Space') release(); };
        document.addEventListener('keyup', onUp); window.addEventListener('blur', release); document.addEventListener('visibilitychange', release);
        setTimeout(release, 30000);
      }
    },

    /* =============== ВЫХОД =============== */
    end(forAll, remote) {
      const S = this.S; if (S.ended) return; S.ended = true; S.joined = false;
      if (!remote) { if (forAll) RTC.send({ t: 'host', action: 'end' }); RTC.close(); } else RTC.close();
      Object.values(this.remoteVideos).forEach(v => v.remove()); this.remoteVideos = {}; this.audioSink.innerHTML = '';
      if (S.recording) this.stopRecording();
      if (S.displayStream) S.displayStream.getTracks().forEach(t => t.stop());
      if (S.rec) { S.rec.onend = null; try { S.rec.stop(); } catch (e) { } }
      this.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); this.timers = [];
      document.onkeydown = null; document.onkeyup = null;
      if (S.wb) S.wb.destroy();
      try { if (location.hash.indexOf('#/join') === 0) history.replaceState(null, '', location.pathname + location.search + '#/home'); } catch (e) { }
      App.history.unshift({ topic: S.topic, date: new Date(), dur: fmtTime(S.secs), participants: S.participants.length + 1 });
      this.layer.innerHTML = `<div class="ended">
        <span class="avatar avatar-xl" style="background:var(--grad)">${icon('check')}</span>
        <h2>${forAll ? 'Встреча завершена для всех' : S.endReason ? esc(S.endReason) : 'Вы покинули встречу'}</h2>
        <p class="muted">«${esc(S.topic)}» · ${fmtTime(S.secs)} · ${S.participants.length + 1} участник(ов)${App.recordings.length && App.recordings[0].blob ? ' · запись сохранена' : ''}</p>
        <p style="margin-top:10px;font-weight:700">Как прошла встреча?</p>
        <div class="stars">${[1, 2, 3, 4, 5].map(i => `<button data-star="${i}">⭐</button>`).join('')}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:10px">
          <button class="btn-gradient" data-a="home">На главную</button>
          ${App.recordings[0] && App.recordings[0].blob ? `<button class="btn-ghost" data-a="rec">${icon('play')} Открыть запись</button>` : ''}
          <button class="btn-ghost" data-a="rejoin">${icon('video')} Подключиться снова</button>
        </div></div>`;
      this.layer.querySelectorAll('[data-star]').forEach(b => b.addEventListener('click', () => { this.layer.querySelectorAll('[data-star]').forEach(x => x.classList.toggle('on', +x.dataset.star <= +b.dataset.star)); toast('Спасибо за оценку!', 'ok'); }));
      this.layer.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => { const a = b.dataset.a; if (a === 'rejoin') { const o = { id: S.id, topic: S.topic, host: S.isHost, pw: S.pw }; this.close(); this.open(o); } else { this.close(); location.hash = a === 'rec' ? '#/recordings' : '#/home'; } }));
      if (S.stream) S.stream.getTracks().forEach(t => t.stop()); S.stream = null;
      if (S.audioCtx) S.audioCtx.close().catch(() => { });
    },
    close() {
      const S = this.S;
      RTC.close(); Object.values(this.remoteVideos || {}).forEach(v => v.remove()); this.remoteVideos = {}; if (this.audioSink) this.audioSink.innerHTML = '';
      if (S) { if (S.stream) S.stream.getTracks().forEach(t => t.stop()); if (S.displayStream) S.displayStream.getTracks().forEach(t => t.stop()); if (S.wb) S.wb.destroy(); if (S.annotWb) S.annotWb.destroy(); if (S.rec) { S.rec.onend = null; try { S.rec.stop(); } catch (e) { } } if (S.audioCtx) S.audioCtx.close().catch(() => { }); }
      this.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); this.timers = [];
      document.onkeydown = null; document.onkeyup = null;
      this.layer.classList.add('hidden'); this.layer.innerHTML = '';
      document.body.classList.remove('in-meeting'); this.S = null;
    },
  };
  window.Meeting = M;
})();
