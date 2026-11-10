const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { startTestServer, installAuthMocks, createCloudStore, EMAIL, PASSWORD, USER_ID } = require('./auth-fixture.cjs');
const { runSemanticMergeTests } = require('./cloud-sync-merges.cjs');

const YEAR = '2026-2027';
const CACHE_KEY = `thpt-school-sync-cache-v1:${USER_ID}`;
const BACKUP_KEY = `thpt-school-sync-legacy-backup-v1:${USER_ID}`;
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(condition, message = 'condition', timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('Đã đồng bộ'));
const capture = page => page.evaluate(() => window.schoolWorkspaceAdapter.capture());
const pull = page => page.evaluate(() => window.schoolDataSync.pull());
const retry = page => page.evaluate(() => window.schoolDataSync.retry());
async function edit(page, mutate, argument) {
  await page.evaluate(({ source, argument }) => { (0, eval)(`(${source})`)(argument); save(); render(); }, { source: mutate.toString(), argument });
}
async function rename(page, name) {
  await page.locator('#schoolNameButton').click();
  await page.locator('#f-schoolName').fill(name);
  await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
}
async function device(browser, origin, cloudStore, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const auth = await installAuthMocks(page, { cloudStore, ...options });
  if (options.captureClient) await page.addInitScript(() => {
    Object.defineProperty(window, 'supabase', { configurable: true, set(sdk) {
      Object.defineProperty(window, 'supabase', { configurable: true, writable: true, value: new Proxy(sdk, { get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== 'createClient') return value;
        return (...args) => { window.__testAuthClient = value(...args); return window.__testAuthClient; };
      } }) });
    } });
  });
  await page.goto(origin);
  return { context, page, auth, errors };
}

async function privacyRaceTests(browser, origin) {
  const store = createCloudStore();
  const d = await device(browser, origin, store, { captureClient: true, accounts: [{ id: OTHER_ID, email: 'second@example.test', password: PASSWORD }] });
  try {
    await d.page.evaluate(() => {
      displaySchoolName('Trường riêng tài khoản A');
      localStorage.setItem(SCHOOL_NAME_KEY, schoolBrand.name);
      data.classes.find(record => record.id === 'c10a1').room = 'Phòng riêng tài khoản A';
      save();
    });
    const privateLegacy = await capture(d.page);
    d.auth.cloud.holdReads = true;
    await d.page.locator('#loginEmail').fill(EMAIL); await d.page.locator('#loginPassword').fill(PASSWORD); await d.page.locator('#loginSubmit').click();
    await until(() => d.auth.cloud.reads === 1, 'first account preparation read');
    const stageKey = `${BACKUP_KEY}:pending`;
    assert.deepEqual(await d.page.evaluate(key => JSON.parse(localStorage.getItem(key)).snapshot, stageKey), privateLegacy, 'Legacy data must be protected before the first network read');
    d.auth.cloud.holdReads = false;
    await d.page.evaluate(async password => {
      const result = await window.__testAuthClient.auth.signInWithPassword({ email: 'second@example.test', password });
      if (result.error) throw result.error;
    }, PASSWORD);
    await d.page.locator('#appRoot').waitFor({ state: 'visible' }); await synced(d.page);
    assert.equal(await d.page.locator('#currentAccountName').textContent(), 'second@example.test');
    d.auth.cloud.releaseReads();
    const second = await capture(d.page);
    assert.notEqual(second.school.name, privateLegacy.school.name);
    assert.notEqual(second.years[YEAR].classes.find(record => record.id === 'c10a1').room, 'Phòng riêng tài khoản A');
    assert.deepEqual(store.rows.get(OTHER_ID).payload, second);
    assert.equal(store.requests.some(request => request.userId === OTHER_ID && request.body?.p_payload?.school.name === privateLegacy.school.name), false, 'An interrupted account preparation must never send its payload using another account token');

    await d.page.locator('#logoutButton').click(); await d.page.locator('#authScreen').waitFor({ state: 'visible' });
    await d.auth.signIn(); await synced(d.page);
    assert.deepEqual(await capture(d.page), privateLegacy, 'Returning to the first account must recover its interrupted migration');
    assert.deepEqual(store.rows.get(USER_ID).payload, privateLegacy);
    assert.deepEqual(store.rows.get(OTHER_ID).payload, second);
    assert.equal(await d.page.evaluate(key => localStorage.getItem(key), stageKey), null, 'A durable main cache finishes the migration stage');

    const png = await d.page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16; canvas.getContext('2d').fillRect(0, 0, 16, 16); return canvas.toDataURL('image/png'); });
    await d.page.evaluate(() => {
      const NativeImage = window.Image;
      window.Image = function (...args) {
        window.Image = NativeImage;
        const image = new NativeImage(...args);
        Object.defineProperty(image, 'onload', { configurable: true, set(handler) {
          image.addEventListener('load', event => { window.__releaseAvatarDecode = () => handler.call(image, event); }, { once: true });
        } });
        return image;
      };
    });
    await d.page.locator('#schoolAvatarInput').setInputFiles({ name: 'pending-account-a.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
    await d.page.waitForFunction(() => typeof window.__releaseAvatarDecode === 'function');
    assert.equal(await d.page.locator('#schoolAvatarButton').isDisabled(), true);
    await d.page.locator('#logoutButton').click(); await d.page.locator('#authScreen').waitFor({ state: 'visible' });
    await d.auth.signIn('second@example.test'); await synced(d.page);
    assert.equal(await d.page.locator('#schoolAvatarButton').isDisabled(), false);
    await d.page.evaluate(async () => { window.__releaseAvatarDecode(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(await capture(d.page), second, 'An old avatar decode must not change the next account’s avatar or cache');
    assert.deepEqual(store.rows.get(OTHER_ID).payload, second);
    assert.deepEqual(store.rows.get(USER_ID).payload, privateLegacy);
    assert.deepEqual(d.errors, []);
    console.log('PASS: interrupted first-account preparation stays private and recoverable; late avatar decoding cannot cross logout.');
  } finally { d.auth.cloud.releaseReads(); await d.context.close(); }
}

async function browserTests(browser, origin) {
  // Separate browser contexts share only the mocked server, never localStorage or sessions.
  const store = createCloudStore();
  const a = await device(browser, origin, store);
  const b = await device(browser, origin, store);
  try {
    await a.auth.signIn(); await synced(a.page);
    await a.page.locator('.nav-btn[data-page="classes"]').click();
    await a.page.locator('.class-link[data-id="c10a1"]').click();
    await a.page.locator('[data-action="edit-student"]').first().click();
    await a.page.locator('#f-fullName').fill('Nguyễn Đồng Bộ');
    await a.page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
    await edit(a.page, () => {
      data.classes.find(record => record.id === 'c10a1').room = 'Phòng đồng bộ';
      data.assignments.push({ id: 'sync-assignment', classId: 'c10a1', name: 'Cô Đồng Bộ', subject: 'Toán', phone: '0900000000' });
      data.schedule.push({ id: 'sync-lesson', classId: 'c10a1', day: 2, period: 5, subject: 'Toán', teacher: 'Cô Đồng Bộ' });
      data.honors.push({ id: 'sync-honor', classId: 'c10a1', student: 'Nguyễn Đồng Bộ', subject: 'Toán', exam: 'Kiểm tra đồng bộ', score: 9.5, maxScore: 10, rank: 'Học sinh giỏi' });
      upsertGlobalTeacher({ name: 'Cô Đồng Bộ', phone: '0900000000', subject: 'Toán' }, 'Đang giảng dạy', 'teacher@example.test');
      schoolYears['2025-2026'] = normalizeAcademicYearData(data, '2025-2026');
    });
    await rename(a.page, 'THPT Đồng Bộ Hai Thiết Bị');
    const avatar = await a.page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#087f5b'; ctx.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png'); });
    await a.page.locator('#schoolAvatarInput').setInputFiles({ name: 'school.png', mimeType: 'image/png', buffer: Buffer.from(avatar.split(',')[1], 'base64') });
    await a.page.waitForFunction(() => !document.querySelector('#schoolAvatarButton').disabled);
    await synced(a.page);
    const expected = await capture(a.page), revision = store.rows.get(USER_ID).revision;
    await b.auth.signIn(); await synced(b.page);
    assert.deepEqual(await capture(b.page), expected, 'A fresh device must pull every school year, record type and branding');
    assert.equal(store.rows.get(USER_ID).revision, revision, 'Fresh demo data must never overwrite the existing account workspace');
    assert.equal(await b.page.locator('#schoolNameButton').textContent(), expected.school.name);
    assert.equal(await b.page.locator('#schoolAvatarImage').getAttribute('src'), expected.school.avatar);
    console.log('PASS: independent devices share students, classes, teachers, schedules, honors, all years, school name and avatar.');

    // The cloud acknowledgement controls the status; an in-flight save is never reported as saved.
    a.auth.cloud.holdWrites = true;
    const writes = a.auth.cloud.writes, oldName = store.rows.get(USER_ID).payload.school.name;
    await rename(a.page, 'Tên đang chờ máy chủ');
    await until(() => a.auth.cloud.writes > writes, 'held cloud write');
    assert.equal(store.rows.get(USER_ID).payload.school.name, oldName);
    assert.doesNotMatch(await a.page.locator('#syncStatus').textContent(), /Đã đồng bộ/);
    a.auth.cloud.releaseWrites(); await synced(a.page);
    assert.equal(store.rows.get(USER_ID).payload.school.name, 'Tên đang chờ máy chủ');

    // Offline edits are durable before the RPC, survive reload, and retry after connectivity returns.
    a.auth.cloud.offline = true;
    await edit(a.page, () => { data.classes.find(record => record.id === 'c10a1').room = 'Thay đổi ngoại tuyến'; });
    await a.page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).pending === true, CACHE_KEY);
    const pending = await a.page.evaluate(key => JSON.parse(localStorage.getItem(key)), CACHE_KEY);
    await a.page.reload();
    await a.page.waitForFunction(() => document.querySelector('#loginError').textContent.trim());
    assert.equal(await a.page.locator('#appRoot').isVisible(), false);
    assert.deepEqual(await a.page.evaluate(key => JSON.parse(localStorage.getItem(key)).snapshot, CACHE_KEY), pending.snapshot);
    a.auth.cloud.offline = false;
    await a.auth.signIn(); await synced(a.page);
    assert.equal(store.rows.get(USER_ID).payload.years[YEAR].classes.find(record => record.id === 'c10a1').room, 'Thay đổi ngoại tuyến');
    assert.equal(await a.page.evaluate(key => JSON.parse(localStorage.getItem(key)).pending, CACHE_KEY), false);
    console.log('PASS: sync confirmation waits for RPC; offline queue survives reload and replays after verified login.');

    await pull(b.page); await synced(b.page);
    // Keep both devices offline long enough to create genuinely concurrent changes from one base.
    a.auth.cloud.offline = b.auth.cloud.offline = true;
    await edit(a.page, () => { data.classes.find(record => record.id === 'c10a1').room = 'Phòng thiết bị A'; });
    await edit(b.page, () => { data.studentProfiles.find(record => record.classId === 'c10a1').fullName = 'Học sinh thiết bị B'; });
    a.auth.cloud.offline = false; await retry(a.page); await synced(a.page);
    b.auth.cloud.offline = false; await retry(b.page); await synced(b.page);
    await pull(a.page);
    const merged = await capture(a.page);
    assert.equal(merged.years[YEAR].classes.find(record => record.id === 'c10a1').room, 'Phòng thiết bị A');
    assert.equal(merged.years[YEAR].studentProfiles.find(record => record.classId === 'c10a1').fullName, 'Học sinh thiết bị B');
    assert.equal(await b.page.locator('#syncDecision').isVisible(), false, 'Disjoint records should merge without interrupting the user');

    a.auth.cloud.offline = b.auth.cloud.offline = true;
    await edit(a.page, () => { data.classes.find(record => record.id === 'c10a1').room = 'A thắng xung đột'; data.studentProfiles.find(record => record.classId === 'c10a1').cccd = '012345678901'; });
    await edit(b.page, () => { data.classes.find(record => record.id === 'c10a1').room = 'B thắng xung đột'; globalTeachers.find(record => record.name === 'Cô Đồng Bộ').email = 'new-teacher@example.test'; });
    a.auth.cloud.offline = false; await retry(a.page); await synced(a.page);
    b.auth.cloud.offline = false;
    await b.page.evaluate(() => { window.__retry = window.schoolDataSync.retry().catch(error => { window.__retryError = error.message; }); });
    await b.page.locator('#syncDecision').waitFor({ state: 'visible' });
    await b.page.locator('#syncDecision [data-sync-choice="local"]').click(); await synced(b.page);
    await pull(a.page);
    const resolved = await capture(a.page);
    assert.equal(resolved.years[YEAR].classes.find(record => record.id === 'c10a1').room, 'B thắng xung đột');
    assert.equal(resolved.years[YEAR].studentProfiles.find(record => record.classId === 'c10a1').cccd, '012345678901');
    assert.equal(resolved.teachers.find(record => record.name === 'Cô Đồng Bộ').email, 'new-teacher@example.test');
    console.log('PASS: concurrent disjoint edits merge; a same-field decision preserves both devices’ other edits.');

    // A remote update must wait until a local editing form closes.
    await b.page.locator('.nav-btn[data-page="classes"]').click();
    await b.page.locator('[data-action="edit-class"][data-id="c10a1"]').click();
    await b.page.locator('#f-name').fill('Bản nháp chưa lưu');
    await edit(a.page, () => { data.classes.find(record => record.id === 'c10a1').room = 'Cập nhật trong lúc mở biểu mẫu'; });
    await synced(a.page); await pull(b.page);
    assert.equal(await b.page.locator('#f-name').inputValue(), 'Bản nháp chưa lưu');
    assert.notEqual((await capture(b.page)).years[YEAR].classes.find(record => record.id === 'c10a1').room, 'Cập nhật trong lúc mở biểu mẫu');
    await b.page.locator('.modal-foot [data-action="close-modal"]').click();
    await retry(b.page);
    assert.equal((await capture(b.page)).years[YEAR].classes.find(record => record.id === 'c10a1').room, 'Cập nhật trong lúc mở biểu mẫu');
    console.log('PASS: incoming data waits for open forms without replacing the draft.');
    assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  } finally { a.auth.cloud.releaseWrites(); a.auth.cloud.releaseReads(); b.auth.cloud.releaseWrites(); b.auth.cloud.releaseReads(); await a.context.close(); await b.context.close(); }

  // A pre-sync browser explicitly chooses between its legacy data and the account copy.
  const migration = await device(browser, origin, store);
  try {
    await migration.page.evaluate(() => { data.classes.find(record => record.id === 'c10a1').room = 'Dữ liệu cũ cần giữ'; save(); });
    const legacy = await capture(migration.page);
    await migration.page.reload();
    await migration.page.locator('#loginEmail').fill(EMAIL); await migration.page.locator('#loginPassword').fill(PASSWORD); await migration.page.locator('#loginSubmit').click();
    await migration.page.locator('#syncDecision').waitFor({ state: 'visible' });
    assert.equal(await migration.page.locator('#appRoot').isVisible(), false, 'Migration decisions must precede dashboard access');
    await migration.page.locator('#syncDecision [data-sync-choice="remote"]').click();
    await migration.page.locator('#appRoot').waitFor({ state: 'visible' }); await synced(migration.page);
    const backup = await migration.page.evaluate(key => localStorage.getItem(key), BACKUP_KEY);
    assert.deepEqual(JSON.parse(backup).snapshot, legacy);
    assert.deepEqual(await capture(migration.page), store.rows.get(USER_ID).payload);
    await rename(migration.page, 'Tên sau chuyển đổi'); await synced(migration.page);
    assert.equal(await migration.page.evaluate(key => localStorage.getItem(key), BACKUP_KEY), backup, 'Legacy backup must be immutable');
    console.log('PASS: first migration prompts before unlock and preserves an immutable local backup.');
  } finally { await migration.context.close(); }

  const account = await device(browser, origin, store, { accounts: [{ id: OTHER_ID, email: 'second@example.test', password: PASSWORD }] });
  try {
    await account.auth.signIn(); await synced(account.page);
    const first = await capture(account.page);
    const oldReads = account.auth.cloud.reads;
    account.auth.cloud.holdReads = true;
    await account.page.evaluate(() => { window.__oldPull = window.schoolDataSync.pull().catch(() => {}); });
    await until(() => account.auth.cloud.reads > oldReads, 'first account held read');
    // Leave the first request held, but let subsequent user reads proceed.
    account.auth.cloud.holdReads = false;
    await account.page.locator('#logoutButton').click();
    await account.page.locator('#authScreen').waitFor({ state: 'visible' });
    await account.auth.signIn('second@example.test'); await synced(account.page);
    assert.notEqual((await capture(account.page)).school.name, first.school.name, 'Another account must not inherit or upload the previous owner’s branding');
    assert.equal(store.rows.get(OTHER_ID).payload.school.avatar, null);
    assert.equal(await account.page.evaluate(key => localStorage.getItem(key), `thpt-school-sync-legacy-backup-v1:${OTHER_ID}`), null, 'A previous owner’s legacy data must not be backed up under another account');
    const second = await capture(account.page);
    account.auth.cloud.releaseReads();
    await account.page.evaluate(() => window.__oldPull);
    assert.deepEqual(await capture(account.page), second, 'A pending old-user read must never apply after logout');
    assert.deepEqual(store.rows.get(USER_ID).payload, first);
    assert.deepEqual(account.errors, []);
    console.log('PASS: account ownership isolates cached/legacy data and rejects late reads after logout.');
  } finally { account.auth.cloud.releaseReads(); await account.context.close(); }
}

// Deterministic async controller tests exercise edits arriving at each network/decision boundary.
function harness() {
  const initial = { version: 1, current: YEAR, years: { [YEAR]: { classes: [{ id: 'class', room: 'initial' }], studentProfiles: [] } }, teachers: [], school: { name: 'Initial school', avatar: '' } };
  const localStorage = new Map(), statuses = [], rows = new Map();
  let visible = clone(initial), user = USER_ID, holdRead = null, holdWrite = null, holdChoose = null;
  const state = { initial, statuses, rows, writes: 0, reads: 0, conflicts: 0, decisions: 0, captures: 0, applied: [], clientUser(id) { user = id; }, holdRead(gate) { holdRead = gate; }, holdWrite(gate) { holdWrite = gate; }, holdChoose(gate) { holdChoose = gate; }, visible: () => clone(visible) };
  const context = { window: { addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }, localStorage: { getItem: key => localStorage.has(key) ? localStorage.get(key) : null, setItem: (key, value) => localStorage.set(key, value) }, navigator: { onLine: true }, AbortController, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'cloud-sync.js'), 'utf8'), context);
  const query = run => { const result = { select() { return this; }, eq(_key, id) { this.id = id; return this; }, maybeSingle() { return this; }, abortSignal() { return this; }, then(resolve, reject) { return Promise.resolve().then(() => run(this.id)).then(resolve, reject); } }; return result; };
  const client = { from() { const gate = holdRead; holdRead = null; return query(async id => { state.reads++; if (gate) await gate.promise; return { data: clone(rows.get(id) || null), error: null }; }); }, rpc(_name, body) { const gate = holdWrite, owner = user; holdWrite = null; return query(async () => { state.writes++; if (gate) await gate.promise; const previous = rows.get(owner); if ((previous ? previous.revision : 0) !== body.p_expected_revision) { state.conflicts++; return { data: null, error: { code: 'P0001', message: 'sync_conflict' } }; } const next = { revision: body.p_expected_revision + 1, payload: clone(body.p_payload), updated_at: new Date().toISOString() }; rows.set(owner, next); return { data: [clone(next)], error: null }; }); } };
  const adapter = { normalize: clone, capture: () => { state.captures++; return clone(visible); }, defaultSnapshot: () => clone(initial), isMeaningfulLegacy: () => false, canApply: () => true, apply(snapshot) { visible = clone(snapshot); state.applied.push(clone(snapshot)); }, async choose() { state.decisions++; const gate = holdChoose; holdChoose = null; return gate ? gate.promise : 'remote'; } };
  state.sync = context.window.SchoolCloudSync.create({ client, adapter, onStatus: value => statuses.push(clone(value)) });
  state.merge = context.window.SchoolCloudSync.mergeStates;
  state.cache = id => JSON.parse(localStorage.get(`thpt-school-sync-cache-v1:${id || USER_ID}`));
  state.change = mutate => { const next = state.cache().snapshot; mutate(next); state.sync.queue(next); return next; };
  return state;
}

async function controllerTests() {
  const h = harness();
  try {
    await h.sync.connect({ id: USER_ID });
    const read = deferred(); h.holdRead(read);
    const remote = clone(h.rows.get(USER_ID)); remote.revision++; remote.payload.school.name = 'Remote school'; h.rows.set(USER_ID, remote);
    const reading = h.sync.pull(); await until(() => h.reads === 2, 'controller read');
    h.change(snapshot => { snapshot.years[YEAR].classes[0].room = 'Edit during read'; });
    read.resolve(); await reading;
    await until(() => h.rows.get(USER_ID).payload.years[YEAR].classes[0].room === 'Edit during read', 'edit made during read');
    assert.equal(h.rows.get(USER_ID).payload.school.name, 'Remote school');

    const write = deferred(); h.holdWrite(write); const writes = h.writes;
    h.change(snapshot => { snapshot.school.name = 'First pending edit'; });
    const writing = h.sync.retry(); await until(() => h.writes > writes, 'controller write');
    h.change(snapshot => { snapshot.school.name = 'Latest edit during RPC'; });
    write.resolve(); await writing;
    await until(() => h.rows.get(USER_ID).payload.school.name === 'Latest edit during RPC', 'edit made during RPC');
    assert.equal(h.cache().pending, false);

    const cas = deferred(); h.holdWrite(cas); const previousWrites = h.writes;
    h.change(snapshot => { snapshot.years[YEAR].classes[0].room = 'Local optimistic edit'; });
    const concurrent = h.sync.retry(); await until(() => h.writes > previousWrites, 'optimistic write');
    const newer = clone(h.rows.get(USER_ID)); newer.revision++; newer.payload.school.name = 'Concurrent server edit'; h.rows.set(USER_ID, newer);
    cas.resolve(); await concurrent;
    assert.equal(h.conflicts, 1, 'A stale expected revision must be rejected by the server');
    assert.equal(h.rows.get(USER_ID).payload.school.name, 'Concurrent server edit');
    assert.equal(h.rows.get(USER_ID).payload.years[YEAR].classes[0].room, 'Local optimistic edit');

    const decision = deferred(); h.holdChoose(decision);
    const changed = clone(h.rows.get(USER_ID)); changed.revision++; changed.payload.school.name = 'Remote conflict winner'; h.rows.set(USER_ID, changed);
    h.change(snapshot => { snapshot.school.name = 'Local conflict contender'; });
    const choosing = h.sync.retry(); await until(() => h.decisions === 1, 'controller decision');
    h.change(snapshot => { snapshot.teachers.push({ name: 'Edit during decision' }); });
    decision.resolve('remote'); await choosing;
    await until(() => h.rows.get(USER_ID).payload.teachers.length === 1 && h.rows.get(USER_ID).payload.school.name === 'Remote conflict winner', 'edit made during conflict decision');
    assert.equal(h.cache().pending, false);

    const late = deferred(); h.holdRead(late); const reads = h.reads;
    const stale = h.sync.pull().catch(() => {}); await until(() => h.reads > reads, 'old session request');
    h.sync.disconnect(); h.clientUser(OTHER_ID);
    const previousCaptures = h.captures;
    await h.sync.connect({ id: OTHER_ID });
    assert.equal(h.captures, previousCaptures, 'Another account must not parse or import the previous owner’s legacy data');
    const lastStatus = clone(h.statuses.at(-1)), lastVisible = h.visible();
    late.reject(new Error('Failed to fetch from old session')); await stale;
    assert.deepEqual(h.statuses.at(-1), lastStatus, 'Old request errors must not replace a new user’s confirmed status');
    assert.deepEqual(h.visible(), lastVisible);

    const base = clone(h.initial); base.years['2027-2028'] = clone(base.years[YEAR]); base.years['2028-2029'] = clone(base.years[YEAR]);
    const local = clone(base), other = clone(base); local.current = '2027-2028'; other.current = '2028-2029';
    const result = h.merge(base, local, other);
    assert.equal(result.conflicts.length, 0, 'Different selected years are view preferences, not conflicting record edits');
    assert.equal(result.snapshot.current, local.current);
    console.log('PASS: in-flight edits remain queued, stale revisions retry with a merge, old failures cannot cross users, and selected years do not conflict.');
  } finally { h.sync.disconnect(); }
}

async function run() {
  await controllerTests();
  await runSemanticMergeTests();
  const server = await startTestServer(); let browser;
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] }); await browserTests(browser, server.origin); await privacyRaceTests(browser, server.origin); }
  finally { if (browser) await browser.close(); await server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
