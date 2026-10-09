import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocket } from 'ws';
import type { Member, RoomOptions } from '../shared/protocol.js';

export const app = Fastify({ logger: true, bodyLimit: 8192 });
await app.register(websocket, { options: { maxPayload: 32768 } });
interface Client extends Member { socket: WebSocket; alive: boolean; rate: number; rateAt: number }
interface Room { options: RoomOptions; members: Map<string, Client>; created: number }
const rooms = new Map<string, Room>();
const creationRates = new Map<string, { count: number; at: number }>();
const turnUrls = (process.env.TURN_URLS ?? '').split(',').filter(Boolean);
const turnSecret = process.env.TURN_SECRET;
function iceServers() {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [];
  const stun = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').filter(Boolean);
  if (stun.length) servers.push({ urls: stun });
  if (turnUrls.length && turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:midi-v2`;
    servers.push({ urls: turnUrls, username, credential: createHmac('sha1', turnSecret).update(username).digest('base64') });
  }
  return servers;
}
function send(socket: WebSocket, value: unknown) { if (socket.readyState === 1) socket.send(JSON.stringify(value)); }
function broadcast(room: Room, value: unknown, except?: string) { for (const member of room.members.values()) if (member.id !== except) send(member.socket, value); }
app.get('/api/health', async () => ({ ok: true, turnConfigured: !!(turnUrls.length && turnSecret), rooms: rooms.size }));
app.post<{ Body: Partial<RoomOptions> }>('/api/rooms', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && !originAllowed(origin, request.headers.host ?? '')) return reply.code(403).send({ error: 'Origin is not allowed' });
  const now = Date.now(); let rate = creationRates.get(request.ip);
  if (!rate || now - rate.at > 60000) { rate = { count: 0, at: now }; creationRates.set(request.ip, rate); }
  if (++rate.count > 20) return reply.code(429).send({ error: 'Too many room requests; please wait a minute' });
  if (rooms.size >= 1000) return reply.code(503).send({ error: 'Room capacity reached' });
  const body = request.body ?? {};
  if (body.delivery !== undefined && body.delivery !== 'fast' && body.delivery !== 'reliable') return reply.code(400).send({ error: 'Invalid delivery mode' });
  const options: RoomOptions = { delivery: body.delivery ?? 'fast', forceRelay: body.forceRelay === true };
  if (options.forceRelay && (!turnUrls.length || !turnSecret)) return reply.code(400).send({ error: 'Forced relay needs TURN_URLS and TURN_SECRET configured on the server' });
  const id = randomBytes(18).toString('base64url');
  rooms.set(id, { options, members: new Map(), created: now });
  return { id, options };
});
function originAllowed(origin: string, host: string) {
  const explicit = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
  if (explicit.length) return explicit.includes(origin);
  try { const url = new URL(origin); return url.host === host || (['localhost', '127.0.0.1'].includes(url.hostname) && ['localhost', '127.0.0.1'].includes(host.split(':')[0])); } catch { return false; }
}
app.get('/ws', { websocket: true }, (socket, request) => {
  if (!request.headers.origin || !originAllowed(request.headers.origin, request.headers.host ?? '')) { socket.close(1008, 'Origin is not allowed'); return; }
  let client: Client | undefined; let room: Room | undefined;
  const joinDeadline = setTimeout(() => { if (!client) socket.close(1008, 'Join timed out'); }, 10000);
  socket.on('pong', () => { if (client) client.alive = true; });
  socket.on('message', (raw, binary) => {
    try {
      if (binary) throw new Error('Signalling expects JSON');
      const message = JSON.parse(raw.toString());
      if (!client) {
        if (message.type !== 'join' || typeof message.roomId !== 'string') throw new Error('Join first');
        room = rooms.get(message.roomId);
        if (!room) throw new Error('Room does not exist or has expired');
        if (room.members.size >= 6) throw new Error('Room is full (six musicians maximum)');
        const name = typeof message.name === 'string' ? message.name.trim().slice(0, 40) : '';
        if (!name) throw new Error('Enter your name');
        client = { id: randomUUID(), name, socket, alive: true, rate: 0, rateAt: Date.now() };
        clearTimeout(joinDeadline);
        send(socket, { type: 'welcome', self: { id: client.id, name }, members: [...room.members.values()].map(({ id, name }) => ({ id, name })), options: room.options, iceServers: iceServers() });
        room.members.set(client.id, client);
        broadcast(room, { type: 'member-joined', member: { id: client.id, name } }, client.id);
        return;
      }
      if (Date.now() - client.rateAt > 1000) { client.rate = 0; client.rateAt = Date.now(); }
      if (++client.rate > 100) throw new Error('Signalling rate exceeded');
      if (message.type === 'signal' && typeof message.target === 'string') {
        const target = room!.members.get(message.target);
        if (target && target.id !== client.id) send(target.socket, { type: 'signal', from: client.id, description: message.description, candidate: message.candidate });
      }
    } catch (error) { send(socket, { type: 'error', message: error instanceof Error ? error.message : 'Invalid message' }); socket.close(1008, 'Invalid request'); }
  });
  socket.on('close', () => { clearTimeout(joinDeadline); if (client && room) { room.members.delete(client.id); broadcast(room, { type: 'member-left', id: client.id }); } });
  socket.on('error', () => socket.close());
});
const cleanup = setInterval(() => {
  for (const [id, room] of rooms) {
    if (!room.members.size && Date.now() - room.created > 3600000) { rooms.delete(id); continue; }
    for (const member of room.members.values()) { if (!member.alive) member.socket.terminate(); else { member.alive = false; member.socket.ping(); } }
  }
  for (const [ip, rate] of creationRates) if (Date.now() - rate.at > 60000) creationRates.delete(ip);
}, 15000);
cleanup.unref();
const dist = resolve('dist');
if (existsSync(dist)) {
  await app.register(staticFiles, { root: dist });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') || request.url.startsWith('/ws') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
}

app.addHook('onClose', async () => { clearInterval(cleanup); for (const room of rooms.values()) for (const member of room.members.values()) member.socket.close(); });