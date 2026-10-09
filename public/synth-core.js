// No explicit per-sample allocations. Control messages are processed between render segments.
export class SynthCore {
  constructor(rate = 48000) {
    this.rate = rate; this.voices = new Map(); this.sustain = new Map(); this.pitch = new Map();
    this.patches = new Map(); this.gains = new Map(); this.master = 0.6;
  }
  key(owner, channel) { return `${owner}:${channel}`; }
  release(voice, immediate = false) { voice.releasing = true; voice.releaseStep = Math.max(voice.level, 0.001) / (this.rate * (immediate ? 0.005 : 0.045)); }
  panic(owner) { for (const voice of this.voices.values()) if (!owner || voice.owner === owner) this.release(voice, true); for (const key of this.sustain.keys()) if (!owner || key.startsWith(`${owner}:`)) this.sustain.delete(key); }
  event(owner, event) {
    const channel = event.status & 15; const kind = event.status & 0xf0; const stateKey = this.key(owner, channel);
    const key = `${stateKey}:${event.voice}`;
    if (kind === 0x90 && event.b > 0 && event.voice) {
      if (this.voices.has(key)) return;
      if (this.voices.size >= 96) this.voices.delete(this.voices.keys().next().value);
      this.voices.set(key, { owner, channel, id: event.voice, note: event.a, velocity: event.b / 127, phase: 0, level: 0, keyDown: true, releasing: false, releaseStep: 0 });
    } else if (kind === 0x80 || (kind === 0x90 && event.b === 0)) {
      const voice = this.voices.get(key);
      if (voice) { voice.keyDown = false; if (!(this.sustain.get(stateKey) >= 64)) this.release(voice); }
    } else if (kind === 0xb0 && event.a === 64) {
      this.sustain.set(stateKey, event.b);
      if (event.b < 64) for (const voice of this.voices.values()) if (voice.owner === owner && voice.channel === channel && !voice.keyDown && !voice.releasing) this.release(voice);
    } else if (kind === 0xe0) this.pitch.set(stateKey, event.a + (event.b << 7));
    else if (kind === 0xb0 && (event.a === 120 || event.a === 123)) {
      this.sustain.set(stateKey, 0);
      for (const voice of this.voices.values()) if (voice.owner === owner && voice.channel === channel) this.release(voice, true);
    }
  }
  reconcile(owner, state) {
    for (let channel = 0; channel < 16; channel++) {
      this.event(owner, { status: 0xb0 | channel, a: 64, b: state.sustain[channel] ?? 0, voice: 0 });
      this.pitch.set(this.key(owner, channel), state.pitch[channel] ?? 8192);
    }
    const held = new Set(state.voices.map(voice => `${this.key(owner, voice.channel)}:${voice.id}`));
    for (const voice of this.voices.values()) if (voice.owner === owner && !held.has(`${this.key(owner, voice.channel)}:${voice.id}`)) {
      voice.keyDown = false;
      if (!(this.sustain.get(this.key(owner, voice.channel)) >= 64) && !voice.releasing) this.release(voice);
    }
    for (const voice of state.voices) this.event(owner, { status: 0x90 | voice.channel, a: voice.note, b: voice.velocity, voice: voice.id });
  }
  render(left, right) {
    left.fill(0); right.fill(0);
    for (const [key, voice] of this.voices) {
      const bend = ((this.pitch.get(this.key(voice.owner, voice.channel)) ?? 8192) - 8192) / 8192 * 2;
      const step = 2 * Math.PI * 440 * 2 ** ((voice.note - 69 + bend) / 12) / this.rate;
      const patch = this.patches.get(voice.owner) ?? 'triangle'; const gain = this.gains.get(voice.owner) ?? 0.8;
      for (let i = 0; i < left.length; i++) {
        if (voice.releasing) voice.level = Math.max(0, voice.level - voice.releaseStep);
        else voice.level = Math.min(1, voice.level + 1 / (this.rate * 0.003));
        const sine = Math.sin(voice.phase);
        const wave = patch === 'sine' ? sine : patch === 'warm' ? (sine + 0.25 * Math.sin(voice.phase * 2) + 0.12 * Math.sin(voice.phase * 3)) / 1.37 : 2 / Math.PI * Math.asin(sine);
        const value = wave * voice.velocity * voice.level * gain * 0.09 * this.master;
        left[i] += value; right[i] += value;
        voice.phase = (voice.phase + step) % (2 * Math.PI);
      }
      if (voice.releasing && voice.level <= 0) this.voices.delete(key);
    }
    for (let i = 0; i < left.length; i++) { left[i] = Math.tanh(left[i]); right[i] = Math.tanh(right[i]); }
  }
}
