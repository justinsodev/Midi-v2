import { describe, expect, it } from 'vitest';
import { clockSample, decodeEvents, encodeEvents, EventReceiver, MidiSource, percentile, SnapshotRecovery } from '../shared/protocol';
const event = (seq: number, status = 0x90, voice = seq) => ({ seq, time: seq * 2, status, voice, a: 60, b: status === 0x90 ? 100 : 0 });
describe('binary protocol', () => {
  it('preserves timestamps, MIDI bytes, voice IDs and generation', () => {
    const events = [event(1), { ...event(2, 0x80, 1), time: 1234.125 }];
    expect(decodeEvents(encodeEvents(99, events))).toEqual({ epoch: 99, events });
  });
  it('rejects truncated, oversized, malformed and nonfinite packets', () => {
    expect(() => decodeEvents(new ArrayBuffer(2))).toThrow();
    const good = encodeEvents(1, [event(1)]);
    expect(() => decodeEvents(good.slice(0, 10))).toThrow();
    new DataView(good).setFloat64(12, NaN);
    expect(() => decodeEvents(good)).toThrow();
    expect(() => encodeEvents(1, [])).toThrow();
    expect(() => encodeEvents(1, Array.from({ length: 65 }, (_, index) => event(index + 1)))).toThrow();
  });
});
describe('performance recovery', () => {
  it('recovers a dropped packet from redundancy without duplicate playback', () => {
    const receiver = new EventReceiver();
    expect(receiver.accept(encodeEvents(1, [event(1)]))).toHaveLength(1);
    // The packet containing only event 2 is lost. The next carries history.
    expect(receiver.accept(encodeEvents(1, [event(1), event(2), event(3)]))).toHaveLength(2);
    expect(receiver.accept(encodeEvents(1, [event(1), event(2), event(3)]))).toHaveLength(0);
    expect(receiver.duplicates).toBe(4);
  });
  it('allows out-of-order notes rather than rejecting all lower sequences', () => {
    const receiver = new EventReceiver(); receiver.accept(encodeEvents(1, [event(3)]));
    expect(receiver.accept(encodeEvents(1, [event(1), event(2)]))).toHaveLength(2);
    expect(receiver.recovered).toBe(2);
  });
  it('prevents a late note-on from resurrecting an already released instance', () => {
    const receiver = new EventReceiver();
    receiver.accept(encodeEvents(1, [event(2, 0x80, 1)]));
    expect(receiver.accept(encodeEvents(1, [event(1, 0x90, 1)]))).toHaveLength(0);
    expect(receiver.accept(encodeEvents(1, [event(3, 0x90, 2)]))).toHaveLength(1);
  });
  it('does not roll pitch and sustain backwards after reordering', () => {
    const receiver = new EventReceiver();
    receiver.accept(encodeEvents(1, [{ ...event(2, 0xb0), a: 64, b: 0 }]));
    expect(receiver.accept(encodeEvents(1, [{ ...event(1, 0xb0), a: 64, b: 127 }]))).toEqual([]);
  });
  it('does not resurrect notes or sustain after an out-of-order panic', () => {
    const receiver = new EventReceiver();
    receiver.accept(encodeEvents(1, [{ ...event(3, 0xb0), a: 120, b: 0 }]));
    expect(receiver.accept(encodeEvents(1, [event(1), { ...event(2, 0xb0), a: 64, b: 127 }]))).toEqual([]);
    expect(receiver.accept(encodeEvents(1, [event(4)]))).toHaveLength(1);
  });
  it('fences old events after authoritative state recovery and rejects old generations', () => {
    const receiver = new EventReceiver(); receiver.accept(encodeEvents(1, [event(2)]));
    expect(receiver.reconcile(1)).toBe(false); expect(receiver.reconcile(5)).toBe(true);
    expect(receiver.reconcile(5)).toBe(true); // Repeated state can restore a watchdog-silenced held note.
    expect(receiver.accept(encodeEvents(1, [event(3)]))).toEqual([]);
    expect(receiver.accept(encodeEvents(2, [event(6)]))).toEqual([]);
    expect(receiver.accept(encodeEvents(1, [event(6)]))).toHaveLength(1);
  });
  it('assigns unique IDs to repeated strikes and normalises velocity-zero releases', () => {
    const source = new MidiSource();
    const first = source.event([0x90, 60, 100], 0)!; const second = source.event([0x90, 60, 100], 1)!;
    expect(first.voice).not.toBe(second.voice);
    expect(source.event([0x90, 60, 0], 2)!.voice).toBe(first.voice);
    expect(source.snapshot().voices.map(voice => voice.id)).toEqual([second.voice]);
    expect(source.event([0x80, 60, 0], 3)!.voice).toBe(second.voice);
    expect(source.snapshot().voices).toEqual([]);
  });
  it('keeps channels separate and clears state during panic', () => {
    const source = new MidiSource(); source.event([0x91, 60, 100], 0); source.event([0x90, 60, 100], 0);
    source.event([0xb0, 64, 127], 0); source.event([0xb0, 120, 0], 1);
    expect(source.snapshot().voices).toHaveLength(1); expect(source.snapshot().voices[0].channel).toBe(1);
    expect(source.snapshot().sustain[0]).toBe(0); expect(source.event([0xf8], 2)).toBeNull();
  });
});
describe('snapshot ordering across channels', () => {
  const state = (seq: number) => ({ seq, voices: [], sustain: Array(16).fill(0), pitch: Array(16).fill(8192) });
  it('lets a redundant note packet catch up when a snapshot arrives first', () => {
    const receiver = new EventReceiver(); const recovery = new SnapshotRecovery(receiver);
    expect(recovery.offer(state(2), 0)).toBeNull();
    expect(receiver.accept(encodeEvents(1, [event(1), event(2, 0x80, 1)]))).toHaveLength(2);
    expect(recovery.flush(5)).toEqual(state(2));
    expect(receiver.accept(encodeEvents(1, [event(1)]))).toEqual([]);
  });
  it('waits for gaps below the highest received sequence too', () => {
    const receiver = new EventReceiver(); const recovery = new SnapshotRecovery(receiver);
    receiver.accept(encodeEvents(1, [event(2)]));
    expect(recovery.offer(state(2), 0)).toBeNull();
    expect(receiver.accept(encodeEvents(1, [event(1)]))).toHaveLength(1);
    expect(recovery.flush(5)).toEqual(state(2));
  });
  it('repairs a fully lost release after a bounded wait and fences stale notes', () => {
    const receiver = new EventReceiver(); const recovery = new SnapshotRecovery(receiver);
    receiver.accept(encodeEvents(1, [event(1)]));
    expect(recovery.offer(state(2), 0)).toBeNull();
    expect(recovery.flush(99)).toBeNull(); expect(recovery.flush(100)).toEqual(state(2));
    expect(receiver.accept(encodeEvents(1, [event(2, 0x80, 1)]))).toEqual([]);
    expect(recovery.offer(state(2), 101)).toEqual(state(2));
  });
  it('does not extend recovery indefinitely when newer snapshots arrive', () => {
    const receiver = new EventReceiver(); const recovery = new SnapshotRecovery(receiver);
    recovery.offer(state(2), 0); recovery.offer(state(3), 50);
    expect(recovery.deadline).toBe(100); expect(recovery.flush(100)).toEqual(state(3));
  });
  it('rejects pending state after newer performance events arrive', () => {
    const receiver = new EventReceiver(); const recovery = new SnapshotRecovery(receiver);
    recovery.offer(state(1), 0); receiver.accept(encodeEvents(1, [event(1), event(2)]));
    expect(recovery.flush(5)).toBeNull(); expect(recovery.deadline).toBeUndefined();
    expect(recovery.offer(state(1), 6)).toBeNull();
  });
  it('preserves 100 onsets under seeded loss and snapshots overtaking packets', () => {
    const receiver = new EventReceiver(); const recovery = new SnapshotRecovery(receiver);
    const source = new MidiSource(); const history: ReturnType<MidiSource['event']>[] = [];
    let random = 0x12345678; let notes = 0; let dropped = 0;
    const deliver = () => {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      if ((random >>> 0) / 0x100000000 < .05) { dropped++; return; }
      notes += receiver.accept(encodeEvents(1, history.filter(item => item !== null))).filter(item => (item.status & 0xf0) === 0x90 && item.b > 0).length;
    };
    for (let index = 0; index < 100; index++) {
      for (const status of [0x90, 0x80]) {
        const now = source.seq * 30; history.push(source.event([status, 60, status === 0x90 ? 100 : 0], now));
        if (history.length > 12) history.shift();
        recovery.offer(source.snapshot(), now); // Deliberately make control win every race.
        for (let repeat = 0; repeat < 4; repeat++) { deliver(); recovery.flush(now + repeat * 5); }
      }
    }
    expect(dropped).toBeGreaterThan(0); expect(notes).toBe(100);
  });
});
describe('diagnostics', () => {
  it('estimates offset and removes remote processing time from RTT', () => {
    expect(clockSample(100, 125, 127, 112)).toEqual({ rtt: 10, offset: 20 });
  });
  it('reports percentiles without mutating samples', () => {
    const values = [8, 1, 4, 2]; expect(percentile(values, .5)).toBe(2); expect(percentile(values, .95)).toBe(8);
    expect(values).toEqual([8, 1, 4, 2]); expect(percentile([], .99)).toBe(0);
  });
});
