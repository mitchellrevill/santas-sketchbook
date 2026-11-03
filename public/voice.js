export class Voice {
  constructor({ audio, post, onState, onTranscript, onError, onAudio = () => {}, onDelegation = () => {} }) {
    Object.assign(this, { audio, post, onState, onTranscript, onError, onAudio, onDelegation });
    this.state = 'idle'; this.generation = 0; this.muted = false;
  }
  setState(state) { this.state = state; this.onState(state, this.muted); }
  async start() {
    if (this.state !== 'idle') return;
    const generation = ++this.generation; this.muted = false; this.setState('connecting');
    this.delegations = new Set();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Use localhost in a browser with microphone support.');
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (generation !== this.generation) { microphone.getTracks().forEach(track => track.stop()); return; }
      this.microphone = microphone;
      this.peer = new RTCPeerConnection(); const peer = this.peer;
      this.audio.autoplay = true;
      peer.addEventListener('track', event => {
        if (generation !== this.generation || this.state === 'stopping') return;
        this.audio.srcObject = new MediaStream([event.track]);
        this.onAudio(this.audio.srcObject);
        this.audio.play().catch(() => { this.audio.hidden = false; this.onError('Press play below to hear Pip.'); });
      });
      for (const track of microphone.getTracks()) peer.addTrack(track, microphone);
      this.events = peer.createDataChannel('oai-events');
      this.events.addEventListener('message', ({ data }) => {
        if (generation !== this.generation) return;
        let event; try { event = JSON.parse(data); } catch { return; }
        if (event.type === 'session.started' && this.state === 'connecting') {
          clearTimeout(this.connectTimer); this.setState('active');
          this.limitTimer = setTimeout(() => { this.onError('Time for a little break. Tap Talk to Pip to start again.'); this.stop(); }, 180_000);
        } else if (event.type === 'session.closed') this.cleanup();
        else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
          if (this.state === 'active' && typeof event.delta === 'string') this.onTranscript(event.type.includes('input_') ? 'You' : 'Pip', event.delta, event.start_ms, event.end_ms);
        } else if (event.type === 'session.delegation.created') {
          const id = event.delegation?.id;
          if (this.state === 'active' && event.delegation?.target === 'client' && typeof id === 'string' && !this.delegations.has(id)) {
            this.delegations.add(id); this.onDelegation(id);
          }
        } else if (event.type === 'error') {
          this.onError('Pip’s connection had a problem. Please try starting a new conversation.'); this.stop();
        }
      });
      this.events.addEventListener('close', () => { if (generation === this.generation) this.cleanup(); });
      peer.addEventListener('connectionstatechange', () => {
        if (generation === this.generation && ['failed', 'disconnected'].includes(peer.connectionState)) {
          this.onError('The voice connection was interrupted. Your drawing is safe.'); this.cleanup();
        }
      });
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('The microphone connection took too long.')); }, 10_000);
          function check() { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); } }
          peer.addEventListener('icegatheringstatechange', check); check();
        });
      }
      if (generation !== this.generation) return;
      this.controller = new AbortController();
      const result = await this.post('/api/session', { sdp: peer.localDescription.sdp }, this.controller.signal);
      if (generation !== this.generation) return;
      this.connectTimer = setTimeout(() => { this.onError('Pip did not connect in time. Please try again.'); this.stop(); }, 20_000);
      await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
    } catch (error) {
      if (generation !== this.generation) return;
      this.onError(error.name === 'NotAllowedError' ? 'Microphone permission is off. You can allow it in your browser, or keep drawing.' : error.message);
      this.cleanup();
    }
  }
  context(content, delegationId = null) {
    if (this.state === 'active' && this.events?.readyState === 'open') this.events.send(JSON.stringify({ type: 'session.thinking.append', delegation_id: delegationId, content }));
  }
  toggleMute() {
    if (this.state !== 'active') return;
    this.muted = !this.muted; this.microphone?.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    this.onState(this.state, this.muted);
  }
  stop() {
    if (this.state === 'idle' || this.state === 'stopping') return;
    this.microphone?.getTracks().forEach(track => { track.enabled = false; track.stop(); });
    this.audio.pause(); this.setState('stopping'); clearTimeout(this.limitTimer); clearTimeout(this.connectTimer);
    if (this.events?.readyState === 'open') {
      this.events.send(JSON.stringify({ type: 'session.close' }));
      this.closeTimer = setTimeout(() => this.cleanup(), 5000);
    } else this.cleanup();
  }
  cleanup() {
    ++this.generation; clearTimeout(this.closeTimer); clearTimeout(this.connectTimer); clearTimeout(this.limitTimer);
    this.controller?.abort(); this.microphone?.getTracks().forEach(track => track.stop());
    this.events?.close(); this.peer?.close(); this.audio.pause(); this.audio.srcObject = null; this.audio.hidden = true;
    this.events = null; this.peer = null; this.microphone = null; this.setState('idle');
  }
}

// Measure only the returned model audio. The existing audio element plays it;
// this silent analysis branch must never play a second copy or analyse the mic.
export class AudioOrb {
  constructor(element, audio) {
    this.element = element; this.audio = audio; this.level = 0;
  }
  unlock() {
    try {
      this.context ??= new AudioContext();
      this.context.resume().catch(() => {});
    } catch { /* Voice can still work without Web Audio visualisation. */ }
  }
  attach(stream) {
    this.detach();
    if (!this.context || this.context.state === 'closed') return;
    try {
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512;
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      this.source.connect(this.analyser); this.analyser.connect(this.silent); this.silent.connect(this.context.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
      this.tick();
    } catch { this.detach(); }
  }
  tick() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let power = 0;
    for (const sample of this.samples) power += sample * sample;
    const target = this.audio.paused ? 0 : Math.min(1, Math.sqrt(power / this.samples.length) * 5);
    this.level += (target - this.level) * (target > this.level ? .32 : .14);
    this.element.style.setProperty('--level', this.level.toFixed(4));
    this.frame = requestAnimationFrame(() => this.tick());
  }
  detach() {
    cancelAnimationFrame(this.frame); this.source?.disconnect(); this.analyser?.disconnect(); this.silent?.disconnect();
    this.source = null; this.analyser = null; this.silent = null; this.level = 0;
    this.element.style.setProperty('--level', '0');
  }
  dispose() { this.detach(); this.context?.close().catch(() => {}); }
}
