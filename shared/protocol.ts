export type Delivery = 'fast' | 'reliable';
export interface RoomOptions { delivery: Delivery; forceRelay: boolean }
export interface Member { id: string; name: string }
export interface MidiEvent { seq: number; time: number; voice: number; status: number; a: number; b: number }
export interface VoiceState { id: number; channel: number; note: number; velocity: number }
export interface PerformanceState { seq: number; voices: VoiceState[]; sustain: number[]; pitch: number[] }
export const HEADER_BYTES = 8;
export const EVENT_BYTES = 20;
export function encodeEvents(epoch: number, events: MidiEvent[]): ArrayBuffer {
  if (!events.length || events.length > 64) throw new Error('Invalid event count');
  const buffer = new ArrayBuffer(HEADER_BYTES + events.length * EVENT_BYTES);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4d32); view.setUint8(2, 1); view.setUint8(3, events.length); view.setUint32(4, epoch);
  events.forEach((event, index) => {
    const offset = HEADER_BYTES + index * EVENT_BYTES;
    view.setUint32(offset, event.seq); view.setFloat64(offset + 4, event.time);
    view.setUint32(offset + 12, event.voice); view.setUint8(offset + 16, event.status);
    view.setUint8(offset + 17, event.a); view.setUint8(offset + 18, event.b);
  });
  return buffer;
}
export function decodeEvents(buffer: ArrayBuffer): { epoch: number; events: MidiEvent[] } {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES || view.getUint16(0) !== 0x4d32 || view.getUint8(2) !== 1) throw new Error('Invalid MIDI packet');
  const count = view.getUint8(3);
  if (!count || count > 64 || buffer.byteLength !== HEADER_BYTES + count * EVENT_BYTES) throw new Error('Invalid MIDI packet length');
  const events: MidiEvent[] = [];
  for (let i = 0; i < count; i++) {
    const offset = HEADER_BYTES + i * EVENT_BYTES;
    const event = { seq: view.getUint32(offset), time: view.getFloat64(offset + 4), voice: view.getUint32(offset + 12), status: view.getUint8(offset + 16), a: view.getUint8(offset + 17), b: view.getUint8(offset + 18) };
    if (!event.seq || !Number.isFinite(event.time) || event.time < 0 || event.status < 0x80 || event.status > 0xef || event.a > 127 || event.b > 127) throw new Error('Invalid MIDI event');
    events.push(event);
  }
  return { epoch: view.getUint32(4), events };
}

// Each note-on gets an instance ID, so reordered note-offs cannot release a later strike.
export class MidiSource {
  seq = 0;
  private nextVoice = 1;
  private voices = new Map<number, VoiceState>();
  private held = new Map<string, number[]>();
  sustain = Array<number>(16).fill(0);
  pitch = Array<number>(16).fill(8192);
  event(data: ArrayLike<number>, time: number): MidiEvent | null {
    const status = data[0]; const kind = status & 0xf0; const channel = status & 15;
    if (![0x80, 0x90, 0xb0, 0xe0].includes(kind) || data.length < 3 || data[1] > 127 || data[2] > 127) return null;
    const a = data[1]; const b = data[2]; const key = `${channel}:${a}`;
    let voice = 0;
    if (kind === 0x90 && b > 0) {
      voice = this.nextVoice++;
      this.voices.set(voice, { id: voice, channel, note: a, velocity: b });
      this.held.set(key, [...(this.held.get(key) ?? []), voice]);
    } else if (kind === 0x80 || kind === 0x90) {
      const ids = this.held.get(key) ?? []; voice = ids.shift() ?? 0;
      if (ids.length) this.held.set(key, ids); else this.held.delete(key);
      this.voices.delete(voice);
    } else if (kind === 0xb0 && a === 64) this.sustain[channel] = b;
    else if (kind === 0xe0) this.pitch[channel] = a + (b << 7);
    else if (kind === 0xb0 && (a === 120 || a === 123)) {
      for (const [id, note] of this.voices) if (note.channel === channel) this.voices.delete(id);
      for (const heldKey of this.held.keys()) if (heldKey.startsWith(`${channel}:`)) this.held.delete(heldKey);
      this.sustain[channel] = 0;
    }
    return { seq: ++this.seq, time, voice, status, a, b };
  }
  snapshot(): PerformanceState { return { seq: this.seq, voices: [...this.voices.values()], sustain: [...this.sustain], pitch: [...this.pitch] }; }
}

export class EventReceiver {
  private epoch: number | null = null;
  private seen = new Set<number>();
  private ended = new Set<number>();
  private controllers = new Map<string, number>();
  private channelFence = new Map<number, number>();
  private floor = 0;
  private contiguous = 0;
  high = 0; duplicates = 0; recovered = 0; reordered = 0;
  accept(buffer: ArrayBuffer): MidiEvent[] {
    const packet = decodeEvents(buffer);
    if (this.epoch === null) this.epoch = packet.epoch;
    if (this.epoch !== packet.epoch) return [];
    const accepted: MidiEvent[] = [];
    for (const event of packet.events.sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= this.floor || this.seen.has(event.seq)) { this.duplicates++; continue; }
      this.seen.add(event.seq);
      while (this.seen.has(this.contiguous + 1)) this.contiguous++;
      if (event.seq < this.high) { this.reordered++; this.recovered++; }
      this.high = Math.max(this.high, event.seq);
      const kind = event.status & 0xf0;
      const channel = event.status & 15;
      if (event.seq < (this.channelFence.get(channel) ?? 0)) continue;
      if (kind === 0xb0 && (event.a === 120 || event.a === 123)) this.channelFence.set(channel, event.seq);
      if (kind === 0x80 || (kind === 0x90 && event.b === 0)) this.ended.add(event.voice);
      if (kind === 0x90 && event.b > 0 && this.ended.has(event.voice)) continue;
      if (kind === 0xb0 || kind === 0xe0) {
        const key = `${event.status}:${kind === 0xb0 ? event.a : 0}`;
        if ((this.controllers.get(key) ?? 0) > event.seq) continue;
        this.controllers.set(key, event.seq);
      }
      accepted.push(event);
    }
    // Bound memory without discarding ordinary out-of-order events.
    if (this.seen.size > 8192) {
      this.floor = Math.max(this.floor, this.high - 4096);
      this.contiguous = Math.max(this.contiguous, this.floor);
      for (const seq of this.seen) if (seq <= this.floor) this.seen.delete(seq);
    }
    if (this.ended.size > 8192) this.ended.delete(this.ended.values().next().value!);
    return accepted;
  }
  reconcile(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < this.high || seq < this.floor) return false;
    this.floor = seq; this.high = seq; this.contiguous = seq; this.seen.clear(); return true;
  }
  completeThrough(seq: number): boolean { return seq <= this.contiguous; }
}

// The reliable control channel can overtake performance packets. Give missing
// events a bounded chance to arrive before an authoritative snapshot fences them.
export class SnapshotRecovery {
  private pending?: { state: PerformanceState; deadline: number };
  constructor(private receiver: EventReceiver, private graceMs = 100) {}
  get deadline(): number | undefined { return this.pending?.deadline; }
  offer(state: PerformanceState, now: number): PerformanceState | null {
    if (state.seq < this.receiver.high || (this.pending && state.seq < this.pending.state.seq)) return null;
    this.pending = { state, deadline: this.pending?.deadline ?? now + this.graceMs };
    return this.flush(now);
  }
  flush(now: number): PerformanceState | null {
    if (!this.pending) return null;
    const { state, deadline } = this.pending;
    if (state.seq < this.receiver.high) { this.pending = undefined; return null; }
    if (!this.receiver.completeThrough(state.seq) && now < deadline) return null;
    this.pending = undefined;
    return this.receiver.reconcile(state.seq) ? state : null;
  }
}

export function clockSample(t0: number, t1: number, t2: number, t3: number) {
  return { rtt: Math.max(0, (t3 - t0) - (t2 - t1)), offset: ((t1 - t0) + (t2 - t3)) / 2 };
}
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
