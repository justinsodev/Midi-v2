import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StudioAudio } from './audio';
import { StudioRoom } from './room';
import type { PeerView } from './room';
import type { Delivery, RoomOptions } from '../shared/protocol';
import './style.css';

const keys = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B', 'C'];
const isBlack = (index: number) => [1, 3, 6, 8, 10].includes(index);
const ms = (n: number) => `${n.toFixed(1)} ms`;
function App() {
  const [name, setName] = useState(localStorage.getItem('midi-name') ?? '');
  const [roomId, setRoomId] = useState(new URLSearchParams(location.search).get('room') ?? '');
  const [delivery, setDelivery] = useState<Delivery>('fast'); const [forceRelay, setForceRelay] = useState(false);
  const [joined, setJoined] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [peers, setPeers] = useState<PeerView[]>([]); const [tick, setTick] = useState(0);
  const [patch, setPatch] = useState('triangle'); const [volume, setVolume] = useState(0.6);
  const [buffer, setBuffer] = useState(0); const [loss, setLoss] = useState(0); const [octave, setOctave] = useState(4);
  const [held, setHeld] = useState<Set<number>>(new Set()); const [sustain, setSustain] = useState(false);
  const [inputs, setInputs] = useState<MIDIInput[]>([]); const [selectedInput, setSelectedInput] = useState('');
  const [midiMessage, setMidiMessage] = useState('USB MIDI or virtual keys'); const [copied, setCopied] = useState(false);
  const [options, setOptions] = useState<RoomOptions>();
  const audioRef = useRef<StudioAudio | null>(null); const roomRef = useRef<StudioRoom | null>(null);
  const midiRef = useRef<MIDIAccess | null>(null); const virtualRef = useRef(new Map<string, number>());
  const benchmarkRef = useRef<ReturnType<typeof setTimeout> | null>(null); const [benchmark, setBenchmark] = useState(false);
  const refresh = () => { const room = roomRef.current; if (room) setPeers([...room.peers.values()].map(peer => ({ ...peer.view }))); setTick(n => n + 1); };

  async function enter(create: boolean) {
    if (!name.trim()) { setError('Enter your name to join the studio.'); return; }
    setBusy(true); setError('');
    const audio = new StudioAudio(); audioRef.current = audio;
    try {
      // Start audio during the join-button gesture, before any network awaits.
      await audio.start(); audio.master(volume);
      let id = roomId;
      if (create) {
        const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery, forceRelay }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Cannot create room');
        id = result.id;
      }
      if (!id) throw new Error('Paste a room link or create a studio.');
      const room = new StudioRoom(audio, refresh); roomRef.current = room;
      room.patch = patch; room.bufferMs = buffer; room.lossPercent = loss;
      await room.join(id, name.trim());
      localStorage.setItem('midi-name', name.trim()); setRoomId(id); setOptions(room.options); setJoined(true);
      const url = new URL(location.href); url.searchParams.set('room', id); history.replaceState(null, '', url);
      refresh();
    } catch (cause) { roomRef.current?.leave(); roomRef.current = null; await audio.stop(); audioRef.current = null; setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function releaseVirtual() {
    const room = roomRef.current;
    for (const note of virtualRef.current.values()) room?.play([0x80, note, 0]);
    virtualRef.current.clear(); room?.play([0xb0, 64, 0]); setHeld(new Set()); setSustain(false);
  }
  function leave() {
    if (benchmarkRef.current) clearTimeout(benchmarkRef.current); setBenchmark(false);
    releaseVirtual(); roomRef.current?.leave(); roomRef.current = null;
    void audioRef.current?.stop(); audioRef.current = null;
    if (midiRef.current) { for (const input of midiRef.current.inputs.values()) input.onmidimessage = null; midiRef.current.onstatechange = null; midiRef.current = null; }
    setInputs([]); setSelectedInput(''); setPeers([]); setJoined(false); setOptions(undefined);
  }
  const noteDown = (key: string, note: number) => {
    if (!roomRef.current || virtualRef.current.has(key)) return;
    virtualRef.current.set(key, note); roomRef.current.play([0x90, note, 100]); setHeld(new Set(virtualRef.current.values()));
  };
  const noteUp = (key: string) => {
    const note = virtualRef.current.get(key); if (note === undefined) return;
    roomRef.current?.play([0x80, note, 0]); virtualRef.current.delete(key); setHeld(new Set(virtualRef.current.values()));
  };
  function pedal(value: boolean) { roomRef.current?.play([0xb0, 64, value ? 127 : 0]); setSustain(value); }
  useEffect(() => {
    if (!joined) return;
    const down = (event: KeyboardEvent) => {
      if (event.repeat || /INPUT|SELECT|TEXTAREA/.test((event.target as HTMLElement)?.tagName)) return;
      const key = event.key.toLowerCase(); const index = keys.indexOf(key);
      if (index >= 0) { event.preventDefault(); noteDown(`key:${event.code}`, 12 * (octave + 1) + index); }
      if (event.code === 'Space') { event.preventDefault(); pedal(true); }
    };
    const up = (event: KeyboardEvent) => { noteUp(`key:${event.code}`); if (event.code === 'Space') { event.preventDefault(); pedal(false); } };
    const blur = () => releaseVirtual();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [joined, octave]);
  useEffect(() => { const timer = setInterval(refresh, 500); return () => { clearInterval(timer); roomRef.current?.leave(); void audioRef.current?.stop(); if (benchmarkRef.current) clearTimeout(benchmarkRef.current); }; }, []);
  useEffect(() => {
    if (!midiRef.current) return;
    for (const input of midiRef.current.inputs.values()) input.onmidimessage = input.id === selectedInput ? event => { if (event.data) roomRef.current?.play(event.data, event.timeStamp); } : null;
  }, [selectedInput, inputs]);
  async function connectMidi() {
    if (!navigator.requestMIDIAccess) { setMidiMessage('Hardware MIDI is unavailable here. Use desktop Chrome or Edge, or virtual keys.'); return; }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false }); midiRef.current = access;
      const update = () => {
        const connected = [...access.inputs.values()].filter(input => input.state === 'connected');
        setInputs(connected); setSelectedInput(previous => connected.some(input => input.id === previous) ? previous : connected[0]?.id ?? '');
        setMidiMessage(connected.length ? `${connected.length} MIDI input${connected.length === 1 ? '' : 's'} available` : 'No MIDI input detected. Connect your USB instrument.');
        roomRef.current?.panic();
      };
      access.onstatechange = update; update();
    } catch { setMidiMessage('MIDI access was declined. Virtual keys are still available.'); }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(`${location.origin}/?room=${encodeURIComponent(roomId)}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy the invite link from the field below.'); }
  }
  function exportReport() {
    const room = roomRef.current; const audio = audioRef.current;
    const report = { capturedAt: new Date().toISOString(), browser: navigator.userAgent, room: roomId, mode: options, receiverBufferMs: buffer, injectedLossPercent: loss,
      audio: { state: audio?.context.state, sampleRate: audio?.context.sampleRate, baseLatencyMs: (audio?.context.baseLatency ?? 0) * 1000, outputLatencyMs: (audio?.context.outputLatency ?? 0) * 1000, voices: audio?.voices, queueOverflows: audio?.overflows },
      sent: room?.sent, deliberatelyDroppedPackets: room?.droppedPackets, peers,
      measurementLimit: 'Event age is estimated from peer clock exchanges and excludes instrument input and audio output. RTT, event age, and browser audio estimates do not establish keypress-to-sound latency.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `midi-v2-${Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function startBenchmark() {
    if (benchmark) { if (benchmarkRef.current) clearTimeout(benchmarkRef.current); releaseVirtual(); setBenchmark(false); return; }
    setBenchmark(true); let index = 0;
    const next = () => {
      if (!roomRef.current || index >= 100) { setBenchmark(false); return; }
      const note = 60 + index % 12; noteDown('benchmark', note);
      benchmarkRef.current = setTimeout(() => { noteUp('benchmark'); index++; benchmarkRef.current = setTimeout(next, 30); }, 30);
    };
    next();
  }
  const audio = audioRef.current; const room = roomRef.current; void tick;
  const received = peers.reduce((sum, peer) => sum + peer.noteOns, 0);
  const connected = peers.filter(peer => peer.status === 'connected').length;
  const invite = `${location.origin}/?room=${roomId}`;
  return <div className="shell">
    <header><a className="brand" href="/" onClick={event => { if (joined) event.preventDefault(); }}><span className="brand-mark">▥</span> midi<span className="brand-version">v2</span></a><div className="header-right"><span className={`status-dot ${joined ? 'active' : ''}`} />{joined ? 'STUDIO OPEN' : 'REALTIME MIDI LAB'}</div></header>
    {!joined ? <main className="welcome">
      <div className="welcome-copy"><span className="eyebrow">PLAY TOGETHER, FROM ANYWHERE</span><h1>Your instruments.<br/>One shared studio.</h1><p>A small room for making music across distance.<br/>Connect your MIDI keyboard, invite your band, and play.</p><div className="feature-row"><span>◉ Browser instruments</span><span>↔ Direct connections</span><span>♫ Up to 6 musicians</span></div><div className="wave-art" aria-hidden="true">{Array.from({ length: 42 }, (_, i) => <i key={i} style={{ height: `${15 + Math.abs(Math.sin(i * 0.47)) * 70 * (1 - Math.abs(i - 21) / 30)}px` }}/>)}</div><p className="small muted">Core MVP · Start with three musicians on wired connections.<br/>The room measures network timing; real musical latency still needs hardware testing.</p></div>
      <section className="panel entry"><span className="eyebrow">STEP INTO THE STUDIO</span><h2>{roomId ? 'Your band is waiting.' : 'Make room for music.'}</h2><label>Your name<input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Justin" maxLength={40} autoComplete="nickname" /></label>
        {!roomId && <><label>Delivery experiment<select value={delivery} onChange={event => setDelivery(event.target.value as Delivery)}><option value="fast">Fast · unordered + recovery</option><option value="reliable">Reliable · unordered delivery</option></select></label><label className="check"><input type="checkbox" checked={forceRelay} onChange={event => setForceRelay(event.target.checked)} />Force TURN relay <span className="muted">requires configured server</span></label></>}
        {roomId && <p className="room-id">Invite room · {roomId.slice(0, 8)}</p>}
        <button className="primary" disabled={busy} onClick={() => void enter(!roomId)}>{busy ? 'Opening studio…' : roomId ? 'Enable audio & join studio' : 'Create studio'}<span>↗</span></button>
        <p className="small muted">Audio starts when you join. Hardware MIDI access is optional and requested separately.</p>
        {!roomId && <details><summary>Already have a room?</summary><label>Invite link or room ID<input placeholder="Paste your invitation" onChange={event => { const value = event.target.value.trim(); try { setRoomId(new URL(value).searchParams.get('room') ?? value); } catch { setRoomId(value); } }}/></label></details>}
      </section>
    </main> : <main className="studio">
      <div className="studio-heading"><div><span className="eyebrow">LIVE SESSION / {roomId.slice(0, 8).toUpperCase()}</span><h1>The studio.</h1><p className="muted">{connected + 1} musician{connected ? 's' : ''} connected · {options?.delivery === 'fast' ? 'Fast delivery with recovery' : 'Reliable unordered delivery'}{options?.forceRelay ? ' · forced TURN' : ''}</p></div><div className="actions"><button onClick={() => void copyLink()}>{copied ? 'Link copied ✓' : 'Copy invite link ↗'}</button><button className="quiet" onClick={leave}>Leave studio</button></div></div>
      <label className="invite-field">Invite your musicians<input readOnly value={invite} onFocus={event => event.target.select()} /></label>
      <div className="studio-grid"><section className="panel instrument">
        <div className="section-heading"><div><span className="eyebrow">YOUR INSTRUMENT</span><h2>{name}<span className="tag">YOU</span></h2></div><span className="engine" data-testid="audio-state">{audio?.context.state === 'running' ? '● Audio ready' : `Audio ${audio?.context.state}`}</span></div>
        <div className="instrument-controls"><label>Sound<select value={patch} onChange={event => { setPatch(event.target.value); room?.setPatch(event.target.value); }}><option value="triangle">Soft triangle</option><option value="sine">Pure sine</option><option value="warm">Warm harmonics</option></select></label><label>Octave<select value={octave} onChange={event => { releaseVirtual(); setOctave(Number(event.target.value)); }}>{[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></label><label>Master volume<input type="range" min="0" max="1" step="0.01" value={volume} onChange={event => { setVolume(Number(event.target.value)); audio?.master(Number(event.target.value)); }} /></label></div>
        <div className="keyboard" aria-label="Virtual MIDI keyboard">{keys.map((key, index) => <button key={key} aria-label={`Play ${noteNames[index]}${index === 12 ? octave + 1 : octave}`} data-testid={`note-${index}`} className={`piano-key ${isBlack(index) ? 'black' : 'white'} ${held.has(12 * (octave + 1) + index) ? 'held' : ''}`} style={isBlack(index) ? { left: `${([1, 3, 6, 8, 10].indexOf(index) < 2 ? [1, 2][[1, 3].indexOf(index)] : [4, 5, 6][[6, 8, 10].indexOf(index)]) * 12.5 - 3.75}%` } : undefined} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); noteDown(`pointer:${event.pointerId}`, 12 * (octave + 1) + index); }} onPointerUp={event => noteUp(`pointer:${event.pointerId}`)} onPointerCancel={event => noteUp(`pointer:${event.pointerId}`)} onLostPointerCapture={event => noteUp(`pointer:${event.pointerId}`)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); noteDown(`button:${index}`, 12 * (octave + 1) + index); } }} onKeyUp={event => { if (event.key === 'Enter') noteUp(`button:${index}`); }}><span>{noteNames[index]}</span><kbd>{key.toUpperCase()}</kbd></button>)}</div>
        <div className="keyboard-footer"><span className="muted small">A–K to play · Space for sustain</span><button className={sustain ? 'pedal active-pedal' : 'pedal'} onClick={() => pedal(!sustain)}>Sustain {sustain ? 'on' : 'off'}</button><button className="panic" onClick={() => { virtualRef.current.clear(); setHeld(new Set()); setSustain(false); room?.panic(); }}>All notes off</button></div>
        <div className="midi-row"><div><strong>Hardware MIDI</strong><p className="small muted">{midiMessage}</p></div><button onClick={() => void connectMidi()}>Connect MIDI</button></div>
        {inputs.length > 0 && <label>MIDI input<select value={selectedInput} onChange={event => { room?.panic(); setSelectedInput(event.target.value); }}><option value="">Virtual keyboard only</option>{inputs.map(input => <option key={input.id} value={input.id}>{input.name ?? input.id}</option>)}</select></label>}
      </section><section className="panel musicians"><span className="eyebrow">IN THE ROOM</span><h2>Your collaborators<span className="tag" data-testid="peer-count">{connected}</span></h2>
        {!peers.length && <div className="empty-room"><span>↗</span><h3>Music needs company.</h3><p className="muted small">Share the invitation with two musicians.<br/>Their instruments will sound here.</p></div>}
        {peers.map(peer => <article className="peer" key={peer.id} data-testid="peer-card"><div className="peer-name"><span className="avatar">{peer.name[0].toUpperCase()}</span><div><strong>{peer.name}</strong><div className="small muted" data-testid="peer-status">{peer.status} · {peer.route}</div></div></div><label className="peer-volume">Volume<input type="range" min="0" max="1" step="0.01" defaultValue="0.8" onChange={event => audio?.gain(peer.id, Number(event.target.value))}/></label><div className="peer-metrics"><span>RTT <b>{peer.clockReady ? ms(peer.rtt) : 'calibrating'}</b></span><span>Received notes <b data-testid="peer-note-ons">{peer.noteOns}</b></span></div></article>)}
      </section></div>
      <section className="panel diagnostics"><div className="section-heading"><div><span className="eyebrow">MEASURE BEFORE YOU ASSUME</span><h2>Connection lab</h2></div><button onClick={exportReport}>Export report ↓</button></div><div className="stat-grid"><div><span>Sent MIDI events</span><strong data-testid="sent-events">{room?.sent ?? 0}</strong></div><div><span>Received note-ons</span><strong data-testid="received-notes">{received}</strong></div><div><span>Active synth voices</span><strong data-testid="active-voices">{audio?.voices ?? 0}</strong></div><div><span>Audio output estimate</span><strong>{ms(((audio?.context.baseLatency ?? 0) + (audio?.context.outputLatency ?? 0)) * 1000)}</strong></div></div>
        <p className="small muted">Network event age is a clock-based estimate. Audio estimates exclude instrument scanning and may not cover every device delay. These numbers do not prove keypress-to-sound latency.</p>
        {peers.length > 0 && <div className="table-wrap"><table><thead><tr><th>Musician</th><th>Event age p95</th><th>Event age p99</th><th>Jitter*</th><th>Duplicates</th><th>Reordered recovery</th><th>Late note-ons</th><th>Queued bytes</th></tr></thead><tbody>{peers.map(peer => <tr key={peer.id}><td>{peer.name}</td><td>{peer.clockReady ? ms(peer.ageP95) : '—'}</td><td>{peer.clockReady ? ms(peer.ageP99) : '—'}</td><td>{ms(peer.jitter)}</td><td>{peer.duplicates}</td><td>{peer.recovered}</td><td>{peer.late}</td><td>{peer.buffered}</td></tr>)}</tbody></table></div>}
        <div className="lab-controls"><label>Remote playout target<select value={buffer} onChange={event => { setBuffer(Number(event.target.value)); if (room) room.bufferMs = Number(event.target.value); }}><option value="0">Immediate (minimum delay)</option><option value="5">5 ms from source event</option><option value="10">10 ms from source event</option><option value="20">20 ms from source event</option></select></label><label>Injected receive loss<select value={loss} onChange={event => { setLoss(Number(event.target.value)); if (room) room.lossPercent = Number(event.target.value); }}>{[0, 1, 5, 10, 25, 100].map(n => <option key={n} value={n}>{n}% of performance packets</option>)}</select></label><button onClick={startBenchmark}>{benchmark ? 'Stop test sequence' : 'Send 100-note test'}</button></div><p className="small muted">* Jitter = event-age p95 minus median. Recovery count measures reordered events, not every prevented loss. Receive loss is applied after transport delivery; use network impairment tools to test retransmission behaviour. Dropped test packets: {room?.droppedPackets ?? 0} · Audio queue overflows: {audio?.overflows ?? 0}</p>
      </section>
    </main>}
    {(error || room?.error || audio?.error) && <div className="error" role="alert">{error || room?.error || audio?.error}<button aria-label="Dismiss error" onClick={() => { setError(''); if (room) room.error = ''; if (audio) audio.error = ''; refresh(); }}>×</button></div>}
    <footer><span>MIDI V2 / CORE EXPERIMENT</span><span>Small messages. Shared moments.</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
