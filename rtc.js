/* rtc.js — подключение к серверу встреч (WebSocket) и WebRTC-соединения между участниками (mesh) */
(function () {
  // STUN — всегда; TURN приходит с сервера встреч (сообщение hello), если он настроен
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

  function defaultUrl() {
    if (window.FM_SIGNAL_URL) return window.FM_SIGNAL_URL;
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return `ws://${h}:8787/ws`;
    if (location.protocol === 'https:' && /formyla-meet\.onrender\.com$/.test(h)) return 'wss://formyla-meet-signal.onrender.com/ws';
    return 'wss://formyla-meet-signal.onrender.com/ws';
  }

  const RTC = {
    ws: null, me: null, peers: new Map(), handlers: {}, localStream: null, screenTrack: null, connected: false, pending: [],

    on(t, fn) { this.handlers[t] = fn; return this; },
    emit(t, m) { const fn = this.handlers[t]; if (fn) try { fn(m); } catch (e) { console.error('RTC handler', t, e); } },

    /* ---------- сигнализация ---------- */
    url() { return defaultUrl(); },
    connect(url) {
      return new Promise((resolve, reject) => {
        if (this.ws && this.ws.readyState === 1) return resolve();
        const u = url || defaultUrl();
        let settled = false;
        const ws = new WebSocket(u); this.ws = ws;
        const timer = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch (e) { } reject(new Error('timeout')); } }, 45000);
        ws.onopen = () => { clearTimeout(timer); this.connected = true; settled = true; this.pending.splice(0).forEach(m => ws.send(JSON.stringify(m))); resolve(); };
        ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('unreachable')); } };
        ws.onclose = () => { this.connected = false; if (this.ws === ws) { this.ws = null; this.emit('disconnected'); } };
        ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.route(m); };
      });
    },
    send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); else this.pending.push(m); },
    close() { const ws = this.ws; this.ws = null; if (ws) { try { ws.onclose = null; ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } catch (e) { } } this.closePeers(); this.me = null; this.pending = []; },

    route(m) {
      switch (m.t) {
        case 'hello': this.ice = Array.isArray(m.ice) ? m.ice : []; this.turn = !!m.turn; this.emit('hello', m); break;
        case 'joined': this.me = m.you; this.emit('joined', m); m.peers.forEach(p => this.ensurePeer(p.id, true)); break;
        case 'peer': this.emit('peer', m.peer); this.ensurePeer(m.peer.id, false); break;
        case 'left': this.dropPeer(m.id); this.emit('left', m); break;
        case 'signal': this.onSignal(m.from, m.data); break;
        default: this.emit(m.t, m);
      }
    },

    /* ---------- медиа ---------- */
    setLocalStream(stream) {
      this.localStream = stream;
      for (const pc of this.peers.values()) this.syncSenders(pc);
    },
    setScreenTrack(track) {
      this.screenTrack = track || null;
      for (const pc of this.peers.values()) this.syncSenders(pc);
    },
    syncSenders(pc) {
      const a = this.localStream ? this.localStream.getAudioTracks()[0] || null : null;
      const v = this.localStream ? this.localStream.getVideoTracks()[0] || null : null;
      const at = pc.getTransceivers().find(t => t.__kind === 'audio'), vt = pc.getTransceivers().find(t => t.__kind === 'video'), st = pc.getTransceivers().find(t => t.__kind === 'screen');
      const rep = (tr, track) => { if (tr && tr.sender && tr.sender.track !== track) tr.sender.replaceTrack(track).catch(() => { }); };
      rep(at, a); rep(vt, v); rep(st, this.screenTrack);
    },

    /* ---------- WebRTC (perfect negotiation) ---------- */
    ensurePeer(id, initiator) {
      if (this.peers.has(id)) return this.peers.get(id);
      const pc = new RTCPeerConnection({ iceServers: STUN.concat(this.ice || []) });
      pc.__id = id; pc.__polite = !initiator; pc.__makingOffer = false; pc.__ignoreOffer = false; pc.__cands = [];
      pc.__stream = new MediaStream(); pc.__screen = new MediaStream();
      // Фиксированные m-секции: mid 0 — аудио, 1 — видео камеры, 2 — экран. Их создаёт только инициатор (новый участник);
      // отвечающая сторона получает готовые трансиверы из предложения и подставляет в них свои дорожки.
      if (initiator) {
        const ta = pc.addTransceiver('audio', { direction: 'sendrecv' }); ta.__kind = 'audio';
        const tv = pc.addTransceiver('video', { direction: 'sendrecv' }); tv.__kind = 'video';
        const ts = pc.addTransceiver('video', { direction: 'sendrecv' }); ts.__kind = 'screen';
        this.syncSenders(pc);
      }
      pc.ontrack = e => {
        const isScreen = e.transceiver.mid === '2';
        if (isScreen) { pc.__screen.addTrack(e.track); this.emit('screenTrack', { id, stream: pc.__screen, track: e.track }); }
        else { pc.__stream.addTrack(e.track); this.emit('track', { id, stream: pc.__stream, kind: e.track.kind }); }
        e.track.onunmute = () => this.emit('trackchange', { id, kind: isScreen ? 'screen' : e.track.kind, live: true });
        e.track.onmute = () => this.emit('trackchange', { id, kind: isScreen ? 'screen' : e.track.kind, live: false });
      };
      pc.onicecandidate = e => { if (e.candidate) this.send({ t: 'signal', to: id, data: { candidate: e.candidate } }); };
      pc.onnegotiationneeded = async () => {
        if (!initiator && !pc.remoteDescription) return; // отвечающая сторона ждёт предложение
        try { pc.__makingOffer = true; await pc.setLocalDescription(); this.send({ t: 'signal', to: id, data: { description: pc.localDescription } }); }
        catch (e) { console.warn('offer', e); } finally { pc.__makingOffer = false; }
      };
      pc.__restarts = 0;
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' && pc.__restarts < 2) { pc.__restarts++; try { pc.restartIce(); } catch (e) { } }
        this.emit('conn', { id, state: pc.iceConnectionState, restarts: pc.__restarts, turn: !!(this.ice && this.ice.length) });
      };
      pc.onconnectionstatechange = () => this.emit('conn', { id, state: pc.connectionState, restarts: pc.__restarts, turn: !!(this.ice && this.ice.length) });
      this.peers.set(id, pc);
      return pc;
    },
    async onSignal(from, data) {
      const pc = this.ensurePeer(from, false);
      try {
        if (data.description) {
          const offerCollision = data.description.type === 'offer' && (pc.__makingOffer || pc.signalingState !== 'stable');
          pc.__ignoreOffer = !pc.__polite && offerCollision;
          if (pc.__ignoreOffer) return;
          await pc.setRemoteDescription(data.description);
          // разметить трансиверы по mid и подставить свои дорожки (для отвечающей стороны — при первом предложении)
          pc.getTransceivers().forEach(t => { if (!t.__kind) { t.__kind = { '0': 'audio', '1': 'video', '2': 'screen' }[t.mid] || null; if (t.__kind) { try { t.direction = 'sendrecv'; } catch (e) { } } } });
          this.syncSenders(pc);
          while (pc.__cands.length) { const c = pc.__cands.shift(); try { await pc.addIceCandidate(c); } catch (e) { console.warn('cand', e); } }
          if (data.description.type === 'offer') { await pc.setLocalDescription(); this.send({ t: 'signal', to: from, data: { description: pc.localDescription } }); }
        } else if (data.candidate) {
          if (!pc.remoteDescription) { pc.__cands.push(data.candidate); return; }
          try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!pc.__ignoreOffer) console.warn('cand', e); }
        }
      } catch (e) { console.warn('signal', e); }
    },
    dropPeer(id) { const pc = this.peers.get(id); if (pc) { try { pc.close(); } catch (e) { } this.peers.delete(id); } },
    closePeers() { for (const id of [...this.peers.keys()]) this.dropPeer(id); },
    remoteStream(id) { const pc = this.peers.get(id); return pc ? pc.__stream : null; },
    remoteScreen(id) { const pc = this.peers.get(id); return pc ? pc.__screen : null; },
    async stats(id) {
      const pc = this.peers.get(id); if (!pc) return null;
      const out = { rtt: null, loss: 0, jitter: null, fps: null, kbps: null, w: 0, h: 0, state: pc.connectionState, path: null };
      try {
        const rep = await pc.getStats(); let bytes = 0;
        rep.forEach(s => {
          if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.nominated) && s.currentRoundTripTime != null) { out.rtt = Math.round(s.currentRoundTripTime * 1000); const loc = rep.get(s.localCandidateId), rem = rep.get(s.remoteCandidateId); if (loc && rem) out.path = (loc.candidateType === 'relay' || rem.candidateType === 'relay') ? 'relay' : 'direct'; }
          if (s.type === 'inbound-rtp' && s.kind === 'video') { out.fps = s.framesPerSecond || out.fps; out.w = s.frameWidth || out.w; out.h = s.frameHeight || out.h; bytes += s.bytesReceived || 0; if (s.jitter != null) out.jitter = Math.round(s.jitter * 1000); if (s.packetsLost) out.loss += s.packetsLost; }
        });
        out.bytes = bytes;
      } catch (e) { /* без статистики */ }
      return out;
    },
  };
  window.RTC = RTC;
})();
