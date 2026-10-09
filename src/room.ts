import { clockSample, encodeEvents, EventReceiver, MidiSource, percentile, SnapshotRecovery } from '../shared/protocol';
import type { Member, MidiEvent, PerformanceState, RoomOptions } from '../shared/protocol';
import { StudioAudio } from './audio';
export interface PeerView extends Member {
  status: string; clockReady: boolean; rtt: number; jitter: number; ageP95: number; ageP99: number;
  noteOns: number; events: number; duplicates: number; recovered: number; late: number; buffered: number;
  route: string; patch: string; snapshots: number;
}
interface Peer {
  member: Member; pc: RTCPeerConnection; fast?: RTCDataChannel; control?: RTCDataChannel;
  receiver: EventReceiver; pending: RTCIceCandidateInit[]; descriptionSet: boolean; view: PeerView;
  samples: { rtt: number; offset: number }[]; offset: number; ages: number[]; serial: Promise<void>;
  lastControl: number; pings: Set<number>; heartbeatLost: boolean;
  recovery: SnapshotRecovery; snapshotTimer?: ReturnType<typeof setTimeout>;
}
export class StudioRoom {
  readonly source = new MidiSource(); readonly epoch = crypto.getRandomValues(new Uint32Array(1))[0];
  readonly peers = new Map<string, Peer>(); self?: Member; options!: RoomOptions; socket?: WebSocket;
  private history: MidiEvent[] = []; private resend?: ReturnType<typeof setTimeout>; private interval?: ReturnType<typeof setInterval>;
  private ice: RTCIceServer[] = []; private disposed = false; private ticking = false;
  patch = 'triangle'; bufferMs = 0; sent = 0; error = ''; droppedPackets = 0;
  // Reproducible receiver-side loss injection. This is packet loss, not simulated network delay.
  lossPercent = 0; private random = 0x12345678;
  constructor(readonly audio: StudioAudio, private changed: () => void) {}
  async join(roomId: string, name: string) {
    this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { this.socket?.close(); reject(new Error('Connection timed out')); }, 12000);
      this.socket!.onopen = () => this.sendSignal({ type: 'join', roomId, name });
      this.socket!.onerror = () => { clearTimeout(timeout); reject(new Error('Cannot connect to signalling server')); };
      this.socket!.onclose = () => {
        clearTimeout(timeout);
        if (!this.disposed) { this.error = 'Signalling disconnected. Leave and rejoin the room.'; for (const id of [...this.peers.keys()]) this.remove(id); this.changed(); reject(new Error(this.error)); }
      };
      this.socket!.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'welcome') {
            this.self = message.self; this.options = message.options; this.ice = message.iceServers;
            this.audio.patch(this.self!.id, this.patch);
            for (const member of message.members) this.createPeer(member);
            this.interval = setInterval(() => void this.tick(), 250);
            clearTimeout(timeout); resolve(); this.changed();
          } else if (message.type === 'member-joined') this.createPeer(message.member);
          else if (message.type === 'member-left') this.remove(message.id);
          else if (message.type === 'signal') {
            const peer = this.peers.get(message.from);
            if (peer) peer.serial = peer.serial.then(() => this.signal(peer, message)).catch(error => this.fail(error));
          } else if (message.type === 'error') { clearTimeout(timeout); this.fail(new Error(message.message)); reject(new Error(message.message)); }
        } catch (error) { this.fail(error); }
      };
    });
  }
  private sendSignal(message: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private fail(error: unknown) { this.error = error instanceof Error ? error.message : String(error); this.changed(); }
  private createPeer(member: Member) {
    if (this.disposed || this.peers.has(member.id)) return;
    const pc = new RTCPeerConnection({ iceServers: this.ice, iceTransportPolicy: this.options.forceRelay ? 'relay' : 'all' });
    const receiver = new EventReceiver();
    const peer: Peer = {
      member, pc, receiver, recovery: new SnapshotRecovery(receiver), pending: [], descriptionSet: false,
      view: { ...member, status: 'connecting', clockReady: false, rtt: 0, jitter: 0, ageP95: 0, ageP99: 0, noteOns: 0, events: 0, duplicates: 0, recovered: 0, late: 0, buffered: 0, route: 'checking', patch: 'triangle', snapshots: 0 },
      samples: [], offset: 0, ages: [], serial: Promise.resolve(), lastControl: performance.now(), pings: new Set(), heartbeatLost: false,
    };
    this.peers.set(member.id, peer);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.sendSignal({ type: 'signal', target: member.id, candidate: candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      peer.view.status = pc.connectionState === 'connected' && (peer.fast?.readyState !== 'open' || peer.control?.readyState !== 'open') ? 'connecting' : pc.connectionState;
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.audio.panic(member.id);
      this.changed();
    };
    pc.ondatachannel = ({ channel }) => this.attach(peer, channel);
    // Stable initiator selection prevents offer glare during concurrent joins.
    if (this.self!.id < member.id) {
      this.attach(peer, pc.createDataChannel('performance', this.options.delivery === 'fast' ? { ordered: false, maxRetransmits: 0 } : { ordered: false }));
      this.attach(peer, pc.createDataChannel('control', { ordered: true }));
      peer.serial = peer.serial.then(async () => { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); this.sendSignal({ type: 'signal', target: member.id, description: pc.localDescription }); }).catch(error => this.fail(error));
    }
    this.changed();
  }
  private async signal(peer: Peer, message: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (message.description) {
      await peer.pc.setRemoteDescription(message.description); peer.descriptionSet = true;
      for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate);
      if (message.description.type === 'offer') { await peer.pc.setLocalDescription(await peer.pc.createAnswer()); this.sendSignal({ type: 'signal', target: peer.member.id, description: peer.pc.localDescription }); }
    } else if (message.candidate) {
      if (peer.descriptionSet) await peer.pc.addIceCandidate(message.candidate); else peer.pending.push(message.candidate);
    }
  }
  private attach(peer: Peer, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    if (channel.label === 'performance') {
      peer.fast = channel;
      channel.onmessage = ({ data }) => {
        try {
          if (!(data instanceof ArrayBuffer)) return;
          this.random ^= this.random << 13; this.random ^= this.random >>> 17; this.random ^= this.random << 5;
          if ((this.random >>> 0) / 0x100000000 * 100 < this.lossPercent) { this.droppedPackets++; return; }
          const events = peer.receiver.accept(data); const now = performance.now(); const live: MidiEvent[] = [];
          for (const event of events) {
            const localTime = peer.samples.length ? event.time - peer.offset : now;
            const age = Math.max(0, now - localTime);
            if (peer.samples.length) { peer.ages.push(age); if (peer.ages.length > 1000) peer.ages.shift(); }
            peer.view.events++;
            const isNoteOn = (event.status & 0xf0) === 0x90 && event.b > 0;
            if (peer.samples.length && age > 100 && isNoteOn) { peer.view.late++; continue; }
            if (isNoteOn) peer.view.noteOns++;
            // Preserve source timing when events are buffered; overdue events play immediately.
            live.push({ ...event, time: localTime });
          }
          if (live.length) this.audio.events(peer.member.id, live, this.bufferMs);
          this.applySnapshot(peer, peer.recovery.flush(now));
          peer.view.duplicates = peer.receiver.duplicates; peer.view.recovered = peer.receiver.recovered;
        } catch (error) { this.fail(error); }
      };
    } else if (channel.label === 'control') {
      peer.control = channel;
      channel.onmessage = ({ data }) => {
        try {
          if (typeof data !== 'string' || data.length > 16384) return;
          const message = JSON.parse(data); const now = performance.now(); peer.lastControl = now;
          if (peer.heartbeatLost) { peer.heartbeatLost = false; peer.view.status = peer.pc.connectionState; }
          if (message.type === 'ping' && Number.isFinite(message.t0)) this.control(peer, { type: 'pong', t0: message.t0, t1: now, t2: performance.now() });
          else if (message.type === 'pong' && [message.t0, message.t1, message.t2].every(Number.isFinite) && peer.pings.delete(message.t0)) {
            const sample = clockSample(message.t0, message.t1, message.t2, now); peer.samples.push(sample);
            if (peer.samples.length > 20) peer.samples.shift();
            const best = [...peer.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
            peer.offset = best.reduce((sum, item) => sum + item.offset, 0) / best.length;
            peer.view.rtt = sample.rtt; peer.view.clockReady = true;
          } else if (message.type === 'snapshot' && this.validState(message.state)) { this.applySnapshot(peer, peer.recovery.offer(message.state, now)); }
          else if (message.type === 'patch' && ['triangle', 'sine', 'warm'].includes(message.patch)) { peer.view.patch = message.patch; this.audio.patch(peer.member.id, message.patch); }
          else if (message.type === 'panic') this.audio.panic(peer.member.id);
        } catch (error) { this.fail(error); }
      };
    } else { channel.close(); return; }
    channel.onopen = () => {
      if (peer.fast?.readyState === 'open' && peer.control?.readyState === 'open') peer.view.status = 'connected';
      this.control(peer, { type: 'patch', patch: this.patch }); this.control(peer, { type: 'snapshot', state: this.source.snapshot() }); this.changed();
    };
    channel.onclose = () => { peer.view.status = 'disconnected'; this.audio.panic(peer.member.id); this.changed(); };
    channel.onerror = () => { peer.view.status = 'channel error'; this.audio.panic(peer.member.id); this.changed(); };
  }
  private applySnapshot(peer: Peer, state: PerformanceState | null) {
    if (peer.snapshotTimer) { clearTimeout(peer.snapshotTimer); peer.snapshotTimer = undefined; }
    if (state) { this.audio.snapshot(peer.member.id, state); peer.view.snapshots++; }
    const deadline = peer.recovery.deadline;
    if (deadline !== undefined) peer.snapshotTimer = setTimeout(() => {
      if (!this.disposed && this.peers.get(peer.member.id) === peer) this.applySnapshot(peer, peer.recovery.flush(performance.now()));
    }, Math.max(0, deadline - performance.now()));
  }
  private validState(value: unknown): value is PerformanceState {
    if (!value || typeof value !== 'object') return false;
    const state = value as PerformanceState;
    return Number.isInteger(state.seq) && state.seq >= 0 && Array.isArray(state.voices) && state.voices.length <= 256 && state.voices.every(voice => Number.isInteger(voice.id) && voice.id > 0 && Number.isInteger(voice.channel) && voice.channel >= 0 && voice.channel < 16 && Number.isInteger(voice.note) && voice.note >= 0 && voice.note < 128 && Number.isInteger(voice.velocity) && voice.velocity > 0 && voice.velocity < 128) && Array.isArray(state.sustain) && state.sustain.length === 16 && state.sustain.every(n => Number.isInteger(n) && n >= 0 && n < 128) && Array.isArray(state.pitch) && state.pitch.length === 16 && state.pitch.every(n => Number.isInteger(n) && n >= 0 && n < 16384);
  }
  private control(peer: Peer, value: unknown) { if (peer.control?.readyState === 'open' && peer.control.bufferedAmount < 32768) peer.control.send(JSON.stringify(value)); }
  play(data: ArrayLike<number>, time = performance.now()) {
    if (!this.self || this.disposed) return;
    const event = this.source.event(data, Math.max(0, time)); if (!event) return;
    this.audio.events(this.self.id, [event]); this.sent++;
    this.history.push(event); if (this.history.length > 12) this.history.shift();
    this.transmit();
    if (this.resend) clearTimeout(this.resend);
    if (this.options.delivery === 'fast') {
      let repeats = 3;
      const retry = () => { if (this.disposed) return; this.transmit(); if (--repeats > 0) this.resend = setTimeout(retry, 5); };
      this.resend = setTimeout(retry, 5);
    }
  }
  private transmit() {
    if (!this.history.length) return;
    const packet = encodeEvents(this.epoch, this.options.delivery === 'fast' ? this.history : this.history.slice(-1));
    for (const peer of this.peers.values()) if (peer.fast?.readyState === 'open') {
      peer.view.buffered = peer.fast.bufferedAmount;
      if (peer.fast.bufferedAmount > 16384) { peer.view.late++; this.error = 'A peer connection is congested; stale packets are being skipped.'; continue; }
      try { peer.fast.send(packet); } catch (error) { this.fail(error); }
    }
  }
  setPatch(patch: string) { this.patch = patch; if (this.self) this.audio.patch(this.self.id, patch); for (const peer of this.peers.values()) this.control(peer, { type: 'patch', patch }); }
  panic() {
    if (!this.self) return;
    for (let channel = 0; channel < 16; channel++) this.play([0xb0 | channel, 120, 0]);
    this.audio.panic(); for (const peer of this.peers.values()) this.control(peer, { type: 'panic' });
  }
  private async tick() {
    if (this.ticking || this.disposed) return; this.ticking = true;
    try {
      for (const peer of this.peers.values()) {
        const t0 = performance.now(); peer.pings.add(t0);
        for (const stamp of peer.pings) if (t0 - stamp > 5000) peer.pings.delete(stamp);
        this.control(peer, { type: 'ping', t0 }); this.control(peer, { type: 'snapshot', state: this.source.snapshot() });
        if (t0 - peer.lastControl > 3000 && !peer.heartbeatLost) { this.audio.panic(peer.member.id); peer.view.status = 'unresponsive'; peer.heartbeatLost = true; }
        peer.view.ageP95 = percentile(peer.ages, 0.95); peer.view.ageP99 = percentile(peer.ages, 0.99);
        peer.view.jitter = Math.max(0, peer.view.ageP95 - percentile(peer.ages, 0.5));
        if (peer.pc.connectionState === 'connected') {
          try {
            const reports = await peer.pc.getStats();
            reports.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) {
              const pair = reports.get(report.selectedCandidatePairId); const local = reports.get(pair?.localCandidateId); const remote = reports.get(pair?.remoteCandidateId);
              peer.view.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? `TURN (${local?.protocol ?? remote?.protocol ?? '?'})` : `direct (${local?.protocol ?? '?'})`;
            } });
          } catch { /* A peer can leave while diagnostics are collected. */ }
        }
      }
      if (!this.disposed) this.changed();
    } finally { this.ticking = false; }
  }
  private remove(id: string) { const peer = this.peers.get(id); if (!peer) return; if (peer.snapshotTimer) clearTimeout(peer.snapshotTimer); this.peers.delete(id); this.audio.panic(id); peer.pc.close(); this.changed(); }
  leave() { this.disposed = true; if (this.interval) clearInterval(this.interval); if (this.resend) clearTimeout(this.resend); this.audio.panic(); for (const id of [...this.peers.keys()]) this.remove(id); this.socket?.close(); }
}
