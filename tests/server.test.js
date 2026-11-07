const test = require('node:test');
const assert = require('node:assert/strict');
const { server, canJoinVoiceChannel, getIceServers } = require('../server');

const VALID_CHANNEL = '10000000-0000-4000-8000-000000000001';
const originalFetch = global.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;
const originalTurnEnv = Object.fromEntries([
  'CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN', 'CLOUDFLARE_TURN_TTL_SECONDS',
  'TURN_URLS', 'TURN_SHARED_SECRET', 'TURN_TTL_SECONDS', 'STUN_URLS'
].map((key) => [key, process.env[key]]));

test('HTTP app serves the shell, public config, and security headers', async () => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'publishable-test-key';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const root = await originalFetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('cache-control'), 'no-cache');
    assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    await root.text();
    const config = await originalFetch(`http://127.0.0.1:${address.port}/config.json`);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), { supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
  for (const [key, value] of Object.entries(originalTurnEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Cloudflare TURN credentials are fetched server-side and passed as ICE servers', async () => {
  process.env.CLOUDFLARE_TURN_KEY_ID = 'turn-key-id';
  process.env.CLOUDFLARE_TURN_API_TOKEN = 'private-api-token';
  delete process.env.CLOUDFLARE_TURN_TTL_SECONDS;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SHARED_SECRET;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 201,
      json: async () => ({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'short-lived-user', credential: 'short-lived-password' }
      ] })
    };
  };

  const iceServers = await getIceServers('test-client');
  assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate-ice-servers');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer private-api-token');
  assert.deepEqual(JSON.parse(request.options.body), { ttl: 172800 });
  assert.ok(iceServers.some((entry) => entry.username === 'short-lived-user' && entry.credential === 'short-lived-password'));
  assert.equal(JSON.stringify(iceServers).includes('private-api-token'), false);
});

test('Cloudflare TURN TTL is clamped to the documented 48-hour maximum', async () => {
  process.env.CLOUDFLARE_TURN_KEY_ID = 'turn-key-id';
  process.env.CLOUDFLARE_TURN_API_TOKEN = 'private-api-token';
  process.env.CLOUDFLARE_TURN_TTL_SECONDS = '999999';
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ iceServers: [
      { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' }
    ] }) };
  };
  await getIceServers('test-client');
  assert.deepEqual(requestBody, { ttl: 172800 });
});

test('community voice access is denied until Supabase is configured', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('unexpected'); };
  assert.equal(await canJoinVoiceChannel(VALID_CHANNEL, 'a'.repeat(60)), false);
  assert.equal(fetchCalled, false);
});

test('community voice access rejects malformed IDs and missing tokens', async () => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-test-key';
  global.fetch = async () => { throw new Error('fetch must not run'); };
  assert.equal(await canJoinVoiceChannel('not-a-uuid', 'a'.repeat(60)), false);
  assert.equal(await canJoinVoiceChannel(VALID_CHANNEL, ''), false);
});

test('voice authorization asks Supabase using the signed-in user token', async () => {
  process.env.SUPABASE_URL = 'https://project.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'public-test-key';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => true };
  };
  assert.equal(await canJoinVoiceChannel(VALID_CHANNEL, 'user-access-token'.repeat(4)), true);
  assert.equal(request.url, 'https://project.supabase.co/rest/v1/rpc/can_join_voice_channel');
  assert.equal(request.options.headers.apikey, 'public-test-key');
  assert.equal(request.options.headers.Authorization, `Bearer ${'user-access-token'.repeat(4)}`);
  assert.deepEqual(JSON.parse(request.options.body), { p_channel_id: VALID_CHANNEL });
});

test('voice authorization fails closed when Supabase denies or is unavailable', async () => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-test-key';
  global.fetch = async () => ({ ok: true, json: async () => false });
  assert.equal(await canJoinVoiceChannel(VALID_CHANNEL, 'x'.repeat(60)), false);
  global.fetch = async () => ({ ok: false, json: async () => true });
  assert.equal(await canJoinVoiceChannel(VALID_CHANNEL, 'x'.repeat(60)), false);
});

