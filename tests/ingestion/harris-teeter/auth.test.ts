import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/setup';
import fixture from './fixtures/token-response.json';
import { getKrogerAccessToken } from '@/lib/ingestion/harris-teeter/auth';

describe('getKrogerAccessToken', () => {
  beforeEach(() => {
    process.env.KROGER_CLIENT_ID = 'test-client-id';
    process.env.KROGER_CLIENT_SECRET = 'test-client-secret';
  });

  it('exchanges client credentials for an access token', async () => {
    let capturedAuth: string | null = null;
    let capturedBody: string | null = null;

    server.use(
      http.post('https://api.kroger.com/v1/connect/oauth2/token', async ({ request }) => {
        capturedAuth = request.headers.get('authorization');
        capturedBody = await request.text();
        return HttpResponse.json(fixture);
      })
    );

    const token = await getKrogerAccessToken();
    expect(token).toBe('fake-access-token-abc123');

    // Verify Basic auth header uses base64(client_id:client_secret)
    const expected = 'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64');
    expect(capturedAuth).toBe(expected);

    // Verify body uses correct scope
    expect(capturedBody).toContain('grant_type=client_credentials');
    expect(capturedBody).toContain('scope=product.compact');
  });

  it('throws when credentials are missing', async () => {
    delete process.env.KROGER_CLIENT_ID;
    await expect(getKrogerAccessToken()).rejects.toThrow(/KROGER_CLIENT_ID/);
  });

  it('throws on non-2xx response', async () => {
    server.use(
      http.post('https://api.kroger.com/v1/connect/oauth2/token', () =>
        HttpResponse.json({ error: 'invalid_client' }, { status: 401 })
      )
    );
    await expect(getKrogerAccessToken()).rejects.toThrow(/401/);
  });
});
