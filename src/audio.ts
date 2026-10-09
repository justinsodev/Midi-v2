import type { MidiEvent, PerformanceState } from '../shared/protocol';
export class StudioAudio {
  context!: AudioContext; node!: AudioWorkletNode; voices = 0; overflows = 0; error = '';
  async start() {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    await this.context.audioWorklet.addModule('/synth-worklet.js');
    this.node = new AudioWorkletNode(this.context, 'studio-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.connect(this.context.destination);
    this.node.port.onmessage = ({ data }) => { this.voices = data.voices; this.overflows = data.overflows; };
    this.node.onprocessorerror = () => { this.error = 'The audio engine stopped. Leave and rejoin to restart it.'; };
    await this.context.resume();
  }
  events(owner: string, events: MidiEvent[], bufferMs = 0) {
    if (!events.length) return;
    const now = performance.now(); const audioNow = this.context.currentTime;
    this.node.port.postMessage({ type: 'events', owner, events: events.map(event => ({ event, at: audioNow + Math.max(0, event.time + bufferMs - now) / 1000 })) });
  }
  snapshot(owner: string, state: PerformanceState) { this.node.port.postMessage({ type: 'snapshot', owner, state }); }
  panic(owner?: string) { this.node?.port.postMessage({ type: 'panic', owner }); }
  patch(owner: string, patch: string) { this.node.port.postMessage({ type: 'patch', owner, patch }); }
  gain(owner: string, gain: number) { this.node.port.postMessage({ type: 'gain', owner, gain }); }
  master(gain: number) { this.node.port.postMessage({ type: 'master', gain }); }
  async stop() { this.panic(); this.node?.disconnect(); if (this.context && this.context.state !== 'closed') await this.context.close(); }
}
