import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../server/app';
import type { WebSocket } from 'ws';
afterAll(() => app.close());
describe('room API', () => {
  it('reports health without opening a network socket', async () => {
    const response = await app.inject({ url: '/api/health' });
    expect(response.statusCode).toBe(200); expect(response.json().ok).toBe(true);
  });
  it('creates unguessable room capabilities with fixed delivery options', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/rooms', payload: { delivery: 'fast' } });
    const second = await app.inject({ method: 'POST', url: '/api/rooms', payload: { delivery: 'reliable' } });
    expect(first.statusCode).toBe(200); expect(first.json().id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(first.json().id).not.toBe(second.json().id);
    expect(second.json().options).toEqual({ delivery: 'reliable', forceRelay: false });
  });
  it('rejects invalid mode and unconfigured forced relay', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: { delivery: 'invalid' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: { forceRelay: true } })).statusCode).toBe(400);
  });
  it('rejects cross-origin room creation', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/rooms', headers: { origin: 'https://other.example', host: 'studio.example' }, payload: {} });
    expect(response.statusCode).toBe(403);
  });
  it('serves the built synth and application without external dependencies', async () => {
    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
    const worklet = await app.inject({ url: '/synth-worklet.js' });
    expect(worklet.statusCode).toBe(200); expect(worklet.body).toContain("registerProcessor('studio-synth'");
  });
  it('joins three musicians, routes offers within the room, and reports departure', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/rooms', payload: {} });
    const id = response.json().id;
    const clients: WebSocket[] = [];
    function inbox(socket: WebSocket) {
      const messages: Record<string, any>[] = [];
      socket.on('message', data => messages.push(JSON.parse(data.toString())));
      return async (type: string) => {
        for (let retry = 0; retry < 100; retry++) {
          const index = messages.findIndex(message => message.type === type);
          if (index >= 0) return messages.splice(index, 1)[0];
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error(`Missing signalling message: ${type}`);
      };
    }
    try {
      const welcomes: Record<string, any>[] = []; const readers: ReturnType<typeof inbox>[] = [];
      for (const name of ['Alice', 'Bob', 'Cara']) {
        const client = await app.injectWS('/ws', { headers: { origin: 'http://localhost', host: 'localhost' } });
        clients.push(client); const next = inbox(client); readers.push(next);
        client.send(JSON.stringify({ type: 'join', roomId: id, name }));
        const welcome = await next('welcome'); welcomes.push(welcome);
        expect(welcome.members).toHaveLength(clients.length - 1);
      }
      const offer = { type: 'offer', sdp: 'test-offer' };
      clients[0].send(JSON.stringify({ type: 'signal', target: welcomes[1].self.id, description: offer }));
      const routed = await readers[1]('signal');
      expect(routed.from).toBe(welcomes[0].self.id); expect(routed.description).toEqual(offer);
      clients[2].terminate();
      expect((await readers[0]('member-left')).id).toBe(welcomes[2].self.id);
      expect((await readers[1]('member-left')).id).toBe(welcomes[2].self.id);
    } finally { for (const client of clients) client.terminate(); }
  });
  it('rejects unknown invitations before joining', async () => {
    const client = await app.injectWS('/ws', { headers: { origin: 'http://localhost', host: 'localhost' } });
    try {
      const result = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())));
      client.send(JSON.stringify({ type: 'join', roomId: 'missing-room', name: 'Alice' }));
      expect(JSON.parse(await result).message).toContain('does not exist');
    } finally { client.terminate(); }
  });
});
