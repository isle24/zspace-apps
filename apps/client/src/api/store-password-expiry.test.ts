import { afterEach, expect, it, vi } from 'vitest';
import { Gateway } from './client';

afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

it('expires a password session at the server deadline even while the store window is closed', async () => {
  vi.useFakeTimers();
  const sessionId = 'd'.repeat(48);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const client = new Gateway(async () => new Response(JSON.stringify({ ok: true, data: { sessionId, expiresAt } })));
  const grant = await client.store<{ sessionId: string }>('login', { username: 'fixture', password: 'synthetic-only' }, true);
  client.storeSession = grant.sessionId;
  expect(client.storeSession).toBe(sessionId);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(client.storeSession).toBe('');
});

it('does not allow an old password deadline to clear a replacement session', async () => {
  vi.useFakeTimers();
  const sessionId = 'd'.repeat(48);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const client = new Gateway(async () => new Response(JSON.stringify({ ok: true, data: { sessionId, expiresAt } })));
  const grant = await client.store<{ sessionId: string }>('login', {}, true);
  client.storeSession = grant.sessionId;
  client.storeSession = 'replacement';
  await vi.advanceTimersByTimeAsync(60_001);
  expect(client.storeSession).toBe('replacement');
  client.storeSession = '';
});
