import { SynthCore } from './synth-core.js';
class StudioSynth extends AudioWorkletProcessor {
  constructor() {
    super(); this.synth = new SynthCore(sampleRate); this.queue = []; this.blocks = 0; this.overflows = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'events') {
        if (this.queue.length + data.events.length > 2048) { this.overflows++; this.queue = []; this.synth.panic(); return; }
        for (const item of data.events) this.queue.push({ owner: data.owner, event: item.event, at: item.at });
        this.queue.sort((a, b) => a.at - b.at || a.event.seq - b.event.seq);
      } else if (data.type === 'panic') {
        this.queue = this.queue.filter(item => data.owner && item.owner !== data.owner); this.synth.panic(data.owner);
      } else if (data.type === 'snapshot') {
        this.queue = this.queue.filter(item => item.owner !== data.owner || item.event.seq > data.state.seq);
        this.synth.reconcile(data.owner, data.state);
      } else if (data.type === 'patch') this.synth.patches.set(data.owner, data.patch);
      else if (data.type === 'gain') this.synth.gains.set(data.owner, data.gain);
      else if (data.type === 'master') this.synth.master = data.gain;
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0]; if (!output || output.length < 2) return true;
    const frames = output[0].length; let position = 0;
    while (this.queue.length && this.queue[0].at < currentTime + frames / sampleRate) {
      const item = this.queue.shift(); const target = Math.max(position, Math.min(frames, Math.round((item.at - currentTime) * sampleRate)));
      if (target > position) this.synth.render(output[0].subarray(position, target), output[1].subarray(position, target));
      this.synth.event(item.owner, item.event); position = target;
    }
    if (position < frames) this.synth.render(output[0].subarray(position), output[1].subarray(position));
    if (++this.blocks % 75 === 0) this.port.postMessage({ voices: this.synth.voices.size, overflows: this.overflows });
    return true;
  }
}
registerProcessor('studio-synth', StudioSynth);
