import { describe, expect, it } from 'vitest';
import { SynthCore } from '../public/synth-core.js';
const on = (voice = 1, status = 0x90) => ({ voice, status, a: 60, b: 100 });
const off = (voice = 1, status = 0x80) => ({ voice, status, a: 60, b: 0 });
function render(synth: SynthCore, blocks = 30) { const left = new Float32Array(128); const right = new Float32Array(128); for (let i = 0; i < blocks; i++) synth.render(left, right); return left; }
describe('synth DSP', () => {
  it('produces bounded, nonzero PCM and releases notes', () => {
    const synth = new SynthCore(); synth.event('a', on());
    const pcm = render(synth); expect([...pcm].some(sample => Math.abs(sample) > .001)).toBe(true);
    expect([...pcm].every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1)).toBe(true);
    synth.event('a', off()); render(synth); expect(synth.voices.size).toBe(0);
  });
  it('isolates identical voice IDs from different musicians', () => {
    const synth = new SynthCore(); synth.event('a', on()); synth.event('b', on()); render(synth);
    synth.panic('a'); render(synth); expect(synth.voices.size).toBe(1);
    expect([...synth.voices.values()][0].owner).toBe('b');
  });
  it('honours sustain and releases after the pedal is lifted', () => {
    const synth = new SynthCore(); synth.event('a', on()); render(synth);
    synth.event('a', { voice: 0, status: 0xb0, a: 64, b: 127 }); synth.event('a', off());
    render(synth); expect(synth.voices.size).toBe(1);
    synth.event('a', { voice: 0, status: 0xb0, a: 64, b: 0 }); render(synth); expect(synth.voices.size).toBe(0);
  });
  it('repairs a lost final note-off from a state snapshot', () => {
    const synth = new SynthCore(); synth.event('a', on()); render(synth);
    synth.reconcile('a', { voices: [], sustain: Array(16).fill(0), pitch: Array(16).fill(8192) });
    render(synth); expect(synth.voices.size).toBe(0);
  });
  it('bounds voice count under controller floods', () => {
    const synth = new SynthCore(); for (let id = 1; id < 1000; id++) synth.event('a', on(id));
    expect(synth.voices.size).toBe(96); synth.panic(); render(synth); expect(synth.voices.size).toBe(0);
  });
});
