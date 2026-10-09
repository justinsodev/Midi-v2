# Midi V2

A browser MIDI collaboration lab for three or more musicians. Each browser captures MIDI, sends compact binary events directly to its peers, and renders every musician through a local AudioWorklet synth.

## Start locally

Requires Node.js 22 and desktop Chrome or Edge. No DAW, account, MIDI device or audio samples are required to try the virtual keyboard.

```powershell
git clone https://github.com/justinsodev/Midi-v2.git
cd Midi-v2
npm ci
npm run dev
```

Open http://localhost:5173. Enter your name and create a studio. Copy the invitation into two other browser windows or profiles, enter different names, and join. Play using A–K, the onscreen keyboard, or an optional USB MIDI controller. Space controls sustain. Use headphones and start at a comfortable volume.

For the built app:

```powershell
npm run build
npm start
```

Open http://localhost:3333. `npm start` loads an optional `.env`; use `.env.example` as a template. `npm run dev` does not load `.env` for the backend: export server environment variables first or use the built app for TURN testing.

## Core features

- Capability-based room invitations; maximum six musicians, with three-person mesh tests included.
- Web MIDI input: note on/off, velocity, sustain, pitch bend, and all-notes/all-sound-off. System Exclusive, program changes, MIDI clock and MPE are outside this prototype.
- Virtual keyboard and three lightweight synth patches; independent collaborator volume.
- Local monitoring without waiting for the network. Remote events play immediately by default.
- Two room-wide transport policies: **fast** unordered delivery with no transport retries plus a rolling 12-event history and three tail repeats at roughly 5 ms intervals; **reliable** unordered delivery for comparison.
- Reliable control channel with 250 ms snapshots, clock exchanges, instrument selection and panic. State recovery fixes held notes/controllers; it cannot restore the correct timing of a missed transient.
- Voice instance IDs, deduplication, generation checks, controller ordering and panic fences prevent common stuck-note and stale-note failures.
- Direct/relayed route reporting, RTT, estimated event-age p95/p99, queue size, duplicate/reordering counters, and JSON report download.
- Deterministic receiver-side packet loss and a 100-note test sequence. This injection happens after WebRTC delivery and cannot model SCTP retransmissions; use network impairment tooling for that comparison.

## Architecture

React owns the UI. `StudioRoom` owns WebRTC connections and the performance protocol; MIDI events do not depend on React state updates. A three-person room has three peer connections, each with performance and control channels. The Node/Fastify server creates rooms and routes signalling only. Coturn handles relay fallback.

`shared/protocol.ts` defines a versioned 8-byte packet header and fixed 20-byte events containing sequence, source timestamp, voice instance and MIDI bytes. WebRTC provides transport encryption. Public room IDs act as bearer invitations: anyone with the link can join. Rooms and rate limits are held in memory; restarting the server closes the signalling sessions. There are no accounts, recordings or persistence.

The worklet mixes up to 96 synth voices into stereo PCM with short attack/release envelopes and limiting. It schedules incoming events within audio blocks. Pitch bend is ±2 semitones. Main-thread work is kept small, but MIDI and channel callbacks can still be delayed by browser scheduling or garbage collection.

Optional remote playout targets of 5/10/20 ms are measured from the source event after estimated clock mapping. Events that have already exceeded that target play immediately. This is a fixed scheduling experiment, not an adaptive jitter buffer or ensemble-wide synchronisation system. Snapshot application is immediate and can preempt buffered notes when deliberately testing long network delay.

Note-ons older than 100 ms according to the estimated peer clock are skipped on the performance path. Current held-note state may still be repaired from a later snapshot. A missing final release is normally repaired within the 250 ms snapshot interval plus transport delay. A peer that becomes unresponsive is silenced after a roughly 3-second heartbeat timeout. Disconnect and leave silence that performer's voices. Rejoin manually after signalling or ICE failure.

## What the measurements mean

The target is **physical keypress to sound at another musician's output**, ideally under 20 ms and initially under 35 ms on a declared supported hardware/network setup. This repository does not establish either target.

RTT is measured by application ping/pong. Event age is estimated from monotonic clock exchanges, using the lowest-RTT recent samples to estimate clock offset. Route asymmetry and scheduling can bias that estimate. Event age excludes instrument scanning, MIDI driver delivery, synthesis queues and physical audio output. Browser base/output latency properties are device estimates and may not cover every delay. Do not add dashboard values and claim a verified physical latency.

The jitter column is event-age p95 minus median. Reordered recovery counts late sequence arrivals; it does not count all events saved by repeated history. Snapshot counters do not prove correct original musical timing. The UI never labels a room as meeting the 35 ms target based solely on these estimates.

Validate on three physical computers, using the same audio devices and patches, wired networking/headphones first. Compare all six directed performance paths, p95/p99, late/missing notes, release recovery and perceived playability. Include direct and forced TURN routes. Use a calibrated trigger-to-audio measurement setup to validate real latency. Local three-browser testing is functional validation only.

## Remote testing and TURN

Different locations need an accessible HTTPS server and WSS signalling. A localhost invitation works only on that computer. Plain HTTP LAN addresses generally do not provide the secure browser context required by MIDI and AudioWorklet; expose a trusted HTTPS origin for other devices.

Set `TURN_URLS` and `TURN_SECRET` on the server. The shared secret must match coturn's `static-auth-secret`; it stays on the server. The API issues short-lived credentials to room participants. The default public Google STUN endpoint is a development convenience; configure your own production STUN/TURN service.

`deploy/compose.yml` and `deploy/Caddyfile` provide an unverified Linux deployment example with HTTPS termination and UDP TURN. Set `STUDIO_DOMAIN`, `TURN_DOMAIN`, `TURN_EXTERNAL_IP`, `TURN_URLS` and `TURN_SECRET` in the deployment environment. Point DNS at the server. Open TCP 80/443 for HTTPS and coturn TCP/UDP 3478 plus UDP 49160–49200; configure the provider firewall too. Coturn uses host networking; this example is intended for a public Linux host and must be adapted if that host is behind NAT. The example does not provide TURN-over-TLS on port 443 for networks that block UDP.

The Compose file uses moving image tags for an initial experiment; pin versions/digests for repeatable deployments. No cloud resources have been provisioned and no deployment is implied.

## Checks

```powershell
npm run build
npm test
npm run test:e2e
```

Windows browser tests use installed Edge. CI installs Chromium. The browser suite covers both delivery modes, all six three-person directions, held-note rendering, snapshot recovery when release packets are deliberately discarded, peer departure/rejoin, and deterministic five-percent receive loss. Build before browser tests because they exercise the production assets.

Local validation in the implementation environment: TypeScript/Vite build and protocol, synth and API tests passed. Browser tests could not complete because that environment blocked socket access, including localhost. GitHub Actions is configured to run the full suite in an unrestricted runner; check the workflow result before treating browser integration as verified. TURN, hardware MIDI, long sessions, actual network loss, and physical latency remain field-validation work.

## Next architecture experiment

Keep the event protocol and synth constant while comparing direct WebRTC, forced TURN and eventually WebTransport-over-HTTP/3 through a regional relay. WebTransport, SharedArrayBuffer transport into the worklet, WebAssembly synthesis and native clients are future experiments, not features of this MVP.
