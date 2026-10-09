import { app } from './app.js';
await app.listen({ port: Number(process.env.PORT ?? 3333), host: process.env.HOST ?? '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
