const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js';
const SDK_SHA384 = 'uteMfOloLDGt042uDz+xHGF3ym63/WQ6rFq7murQRG8Ih7QrXGEGNtWd8688sb4O';
const PROJECT_URL = 'https://school-test.supabase.co';
const AUTH_STORAGE_KEY = 'sb-school-test-auth-token';
const EMAIL = 'admin@example.test';
const PASSWORD = 'Test-password-123!';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function createCloudStore() {
  return { rows: new Map(), requests: [] };
}

function sdkSource() {
  const cached = path.join(os.tmpdir(), 'thpt-supabase-2.119.0.js');
  const supplied = process.env.SUPABASE_TEST_SDK_PATH;
  const source = supplied || (fs.existsSync('/tmp/thpt-supabase.js') ? '/tmp/thpt-supabase.js' : cached);
  if (!fs.existsSync(source)) fs.writeFileSync(source, execFileSync('curl', ['-fsS', '--max-time', '30', SDK_URL]));
  const body = fs.readFileSync(source);
  assert.equal(crypto.createHash('sha384').update(body).digest('base64'), SDK_SHA384, 'Tests must use the exact pinned Supabase SDK');
  return body;
}

async function startTestServer() {
  const root = path.join(__dirname, '..');
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'auth.js', 'auth-config.js', 'cloud-sync.js', 'workspace-sync.js'].includes(filename) || !fs.existsSync(path.join(root, filename))) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    response.end(fs.readFileSync(path.join(root, filename)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function installAuthMocks(page, options = {}) {
  const body = sdkSource();
  const state = {
    revoked: false, userNetworkError: false, tokenNetworkError: false, logoutNetworkError: false,
    holdUser: false, accessLifetime: 3600, userWaiters: [], requests: [], accessTokens: new Set(), refreshTokens: new Set(),
    counts: { password: 0, refresh: 0, user: 0, logout: 0, failedRefresh: 0 }, ...options,
  };
  const makeUser = account => ({ id: account.id || USER_ID, aud: 'authenticated', role: 'authenticated', email: account.email || EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  const primary = { id: options.userId || USER_ID, email: options.email || EMAIL, password: options.password || PASSWORD };
  const accounts = [primary, ...(options.accounts || [])].map(account => ({ ...account, user: makeUser(account) }));
  const accessUsers = new Map(), refreshUsers = new Map();
  state.user = accounts[0].user;
  let sequence = 0;
  const session = user => {
    const now = Math.floor(Date.now() / 1000), serial = ++sequence, lifetime = state.accessLifetime;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: `${PROJECT_URL}/auth/v1`, sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now + lifetime, serial })}.test-signature`;
    const refresh = `refresh-token-${serial}`;
    state.accessTokens.add(token); state.refreshTokens.add(refresh);
    accessUsers.set(token, user); refreshUsers.set(refresh, user);
    return { access_token: token, refresh_token: refresh, token_type: 'bearer', expires_in: lifetime, expires_at: now + lifetime, user };
  };
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route(SDK_URL, route => options.sdkFailure ? route.abort('failed') : route.fulfill({ body, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } }));
  await page.route('**/auth-config.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.SCHOOL_AUTH_CONFIG=${JSON.stringify(options.missingConfig ? { supabaseUrl: '', publishableKey: '' } : { supabaseUrl: PROJECT_URL, publishableKey: 'sb_publishable_test_key' })};` }));
  await page.route(`${PROJECT_URL}/auth/v1/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    state.requests.push({ path: url.pathname, grant: url.searchParams.get('grant_type'), method: request.method() });
    const json = (status, value) => route.fulfill({ status, headers, body: JSON.stringify(value) });
    if (url.pathname.endsWith('/token')) {
      const grant = url.searchParams.get('grant_type'), data = request.postDataJSON();
      state.counts[grant === 'refresh_token' ? 'refresh' : 'password']++;
      if (state.tokenNetworkError) { if (grant === 'refresh_token') state.counts.failedRefresh++; return route.abort('failed'); }
      const account = accounts.find(item => item.email === data.email && item.password === data.password);
      if (grant === 'password' && account && !state.revoked) return json(200, session(account.user));
      if (grant === 'refresh_token' && state.refreshTokens.has(data.refresh_token) && !state.revoked) return json(200, session(refreshUsers.get(data.refresh_token)));
      return json(400, { code: 400, error_code: grant === 'refresh_token' ? 'refresh_token_not_found' : 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (url.pathname.endsWith('/user')) {
      state.counts.user++;
      if (state.holdUser) await new Promise(resolve => state.userWaiters.push(resolve));
      if (state.userNetworkError) return route.abort('failed');
      const token = (request.headers().authorization || '').replace(/^Bearer\s+/i, '');
      return state.accessTokens.has(token) && !state.revoked ? json(200, accessUsers.get(token)) : json(401, { code: 401, error_code: 'bad_jwt', msg: 'Invalid JWT' });
    }
    if (url.pathname.endsWith('/logout')) {
      state.counts.logout++;
      if (state.logoutNetworkError) return route.abort('failed');
      return route.fulfill({ status: 204, headers });
    }
    return json(404, { message: 'Unmocked auth endpoint' });
  });
  const cloudStore = options.cloudStore || createCloudStore();
  const cloud = state.cloud = { store: cloudStore, offline: false, holdReads: false, holdWrites: false, readWaiters: [], writeWaiters: [], reads: 0, writes: 0, conflicts: 0, ...options.cloud };
  cloud.releaseReads = () => { cloud.holdReads = false; cloud.readWaiters.splice(0).forEach(resolve => resolve()); };
  cloud.releaseWrites = () => { cloud.holdWrites = false; cloud.writeWaiters.splice(0).forEach(resolve => resolve()); };
  await page.route(`${PROJECT_URL}/rest/v1/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const token = (request.headers().authorization || '').replace(/^Bearer\s+/i, ''), user = accessUsers.get(token);
    const json = (status, value) => route.fulfill({ status, headers, body: JSON.stringify(value) });
    const record = { path: url.pathname, method: request.method(), userId: user && user.id, query: url.search };
    cloudStore.requests.push(record);
    if (!user || state.revoked) return json(401, { code: 'PGRST301', message: 'Invalid JWT' });
    if (cloud.offline) return route.abort('failed');
    if (url.pathname.endsWith('/school_workspaces') && ['GET', 'HEAD'].includes(request.method())) {
      cloud.reads++;
      if (cloud.holdReads) await new Promise(resolve => cloud.readWaiters.push(resolve));
      if (cloud.offline) return route.abort('failed');
      const filter = url.searchParams.get('user_id'), row = cloudStore.rows.get(user.id);
      const selected = url.searchParams.get('select') || '*';
      const visible = row && (!filter || filter === `eq.${user.id}`) ? row : null;
      const project = value => selected === '*' ? value : Object.fromEntries(selected.split(',').map(key => key.trim()).filter(key => key in value).map(key => [key, value[key]]));
      if ((request.headers().accept || '').includes('vnd.pgrst.object')) return visible ? json(200, project(visible)) : json(406, { code: 'PGRST116', details: 'The result contains 0 rows', message: 'JSON object requested, multiple (or no) rows returned' });
      return json(200, visible ? [project(visible)] : []);
    }
    if (url.pathname.endsWith('/rpc/save_school_workspace') && request.method() === 'POST') {
      cloud.writes++;
      record.body = request.postDataJSON();
      if (cloud.holdWrites) await new Promise(resolve => cloud.writeWaiters.push(resolve));
      if (cloud.offline) return route.abort('failed');
      const { p_expected_revision: expected, p_payload: payload } = record.body, previous = cloudStore.rows.get(user.id);
      if ((previous ? previous.revision : 0) !== expected) {
        cloud.conflicts++;
        return json(400, { code: 'P0001', message: 'sync_conflict', details: null, hint: null });
      }
      const next = { user_id: user.id, payload: structuredClone(payload), revision: expected + 1, updated_at: new Date().toISOString() };
      cloudStore.rows.set(user.id, next);
      return json(200, [next]);
    }
    return json(404, { message: 'Unmocked REST endpoint' });
  });
  state.releaseUser = () => { state.holdUser = false; state.userWaiters.splice(0).forEach(resolve => resolve()); };
  state.signIn = async (email = primary.email, password = primary.password) => {
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginSubmit').click();
    await page.locator('#appRoot').waitFor({ state: 'visible' });
  };
  state.resetWorkspace = async () => {
    await page.evaluate(() => {
      if (window.schoolDataSync) window.schoolDataSync.disconnect();
      Object.keys(localStorage).filter(key => key.startsWith('thpt-school-sync-')).forEach(key => localStorage.removeItem(key));
    });
    cloudStore.rows.clear();
  };
  return state;
}

async function prepareAuthenticatedPage(page, url) {
  const state = await installAuthMocks(page);
  await page.goto(url);
  await state.signIn();
  return state;
}

module.exports = { startTestServer, installAuthMocks, prepareAuthenticatedPage, createCloudStore, AUTH_STORAGE_KEY, EMAIL, PASSWORD, USER_ID, PROJECT_URL };
