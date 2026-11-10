const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer, installAuthMocks, PROJECT_URL, EMAIL, PASSWORD, USER_ID } = require('./auth-fixture.cjs');

const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = '2026-2027';
const OLD_YEAR = '2025-2026';
const clone = value => structuredClone(value);
async function until(condition, message, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function teacherSnapshot(name = 'Võ Thành Long', year = YEAR) {
  const older = year === OLD_YEAR;
  const classId = older ? 'old-math' : 'math-10a1';
  return {
    school: { name: 'THPT Cổng Giáo Viên', avatar: null },
    teacher: { name, email: 'teacher@example.test', phone: '0900123456', status: 'Đang giảng dạy', subjects: ['Toán'] },
    years: [OLD_YEAR, YEAR], current: year,
    classes: [{ id: classId, name: older ? '12A3' : '10A1', grade: older ? 'Khối 12' : 'Khối 10', students: 2, teacher: name, room: 'A.101', status: 'Đang hoạt động', isHomeroom: true }],
    assignments: [{ id: 'assignment-math', classId, name, subject: 'Toán' }],
    schedule: [{ id: 'math-slot', classId, day: 1, period: 1, subject: 'Toán', teacher: name, room: 'A.101' }],
    studentProfiles: [{ id: 's-math-1', classId, fullName: older ? 'Học sinh năm trước' : 'Nguyễn Minh An', birthDate: '2010-02-03', isSample: true }, { id: 's-math-2', classId, fullName: 'Trần Khánh Bình', birthDate: '2010-08-09' }],
    revision: 7, updated_at: '2026-11-10T00:00:00Z',
  };
}
async function mockTeacherRPC(page, auth, options = {}) {
  const state = { calls: [], schools: true, error: null, held: null, grants: [], snapshots: new Map([[USER_ID, teacherSnapshot()], [OTHER_ID, teacherSnapshot('Giáo viên thứ hai')]]), ...options };
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
  await page.route(`${PROJECT_URL}/rest/v1/rpc/**`, async route => {
    const request = route.request(), name = new URL(request.url()).pathname.split('/').pop();
    if (!['list_teacher_schools', 'get_teacher_portal', 'list_school_teacher_access', 'manage_teacher_access'].includes(name)) return route.fallback();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const token = (request.headers().authorization || '').replace(/^Bearer\s+/i, '');
    const json = (status, value) => route.fulfill({ status, headers, body: JSON.stringify(value) });
    if (!auth.accessTokens.has(token)) return json(401, { code: 'PGRST301', message: 'Invalid JWT' });
    const user = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    const args = request.postDataJSON() || {};
    state.calls.push({ name, userId: user.sub, args });
    const hold = state.held;
    if (hold && hold.name === name && (!hold.userId || hold.userId === user.sub)) await hold.gate.promise;
    if (state.error) return json(400, state.error);
    if (name === 'list_teacher_schools') return json(200, state.schools ? [{ owner_id: OWNER_ID, school: { name: 'THPT Cổng Giáo Viên', avatar: null }, teacher_name: state.snapshots.get(user.sub)?.teacher.name }] : []);
    if (name === 'get_teacher_portal') {
      if (!state.schools || args.p_owner_id !== OWNER_ID) return json(400, { code: '42501', message: 'teacher_access_denied' });
      const snapshot = clone(state.snapshots.get(user.sub));
      if (args.p_year === OLD_YEAR) Object.assign(snapshot, teacherSnapshot(snapshot.teacher.name, OLD_YEAR));
      return json(200, snapshot);
    }
    if (name === 'list_school_teacher_access') return json(200, clone(state.grants));
    if (name === 'manage_teacher_access') {
      if (!args.p_teacher_name || (args.p_enabled && !args.p_email)) return json(400, { code: '22023', message: 'teacher_access_invalid' });
      state.grants = state.grants.filter(item => item.teacher_name !== args.p_teacher_name);
      const result = { teacher_name: args.p_teacher_name, email: args.p_email, enabled: Boolean(args.p_enabled) };
      if (result.enabled) state.grants.push(result);
      return json(200, result);
    }
  });
  return state;
}
async function device(browser, origin, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'supabase', { configurable: true, set(sdk) {
      Object.defineProperty(window, 'supabase', { configurable: true, writable: true, value: new Proxy(sdk, { get(target, property) {
        const value = Reflect.get(target, property);
        return property === 'createClient' ? (...args) => { window.__testAuthClient = value(...args); return window.__testAuthClient; } : value;
      } }) });
    } });
  });
  const auth = await installAuthMocks(page, { accounts: [{ id: OTHER_ID, email: 'second@example.test', password: PASSWORD }], ...options.auth });
  const rpc = await mockTeacherRPC(page, auth, options.rpc);
  await page.goto(origin + (options.admin ? '/' : '/teacher.html'));
  return { context, page, auth, rpc, errors };
}

async function run() {
  const server = await startTestServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const d = await device(browser, server.origin, { viewport });
      try {
        assert.equal(await d.page.locator('#appRoot').isVisible(), false);
        await d.auth.signIn();
        await d.page.getByText('Võ Thành Long', { exact: false }).first().waitFor();
        assert.ok(d.auth.counts.user > 0, 'Teacher login must be verified by Auth before showing records');
        assert.match(await d.page.locator('#schoolName').textContent(), /THPT Cổng Giáo Viên/);
        assert.match(await d.page.locator('#teacherPage').textContent(), /Toán/);
        assert.equal(d.auth.cloud.reads, 0, 'The teacher page must never fetch a full owner workspace');
        assert.equal(d.auth.cloud.writes, 0, 'The teacher page must never create or write an admin workspace');
        assert.equal(await d.page.locator('[data-action="edit-student"], [data-action="edit-assignment"], [data-action="edit-slot"]').count(), 0);
        assert.equal(await d.page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('thpt-school-sync-'))), false, 'Teacher school records must not be persisted as admin caches');
        assert.equal(await d.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Teacher dashboard must fit the viewport');
        fs.mkdirSync('/workspace/artifacts', { recursive: true });
        await d.page.screenshot({ path: `/workspace/artifacts/teacher-portal-${viewport.width < 500 ? 'mobile' : 'desktop'}.png`, fullPage: true });
        await d.page.locator('#teacherYear').selectOption(OLD_YEAR);
        await until(() => d.rpc.calls.some(call => call.name === 'get_teacher_portal' && call.args.p_year === OLD_YEAR), 'selected academic year RPC');
        await d.page.waitForFunction(() => document.querySelector('#teacherPage').textContent.includes('12A3'));
        await d.page.locator('#teacherYear').selectOption(YEAR);
        await d.page.waitForFunction(() => document.querySelector('#teacherPage').textContent.includes('10A1'));
        if (viewport.width < 500) await d.page.locator('#teacherMenu').click();
        await d.page.locator('[data-teacher-view="classes"]').click();
        await d.page.locator('[data-teacher-roster="math-10a1"]').click();
        await d.page.locator('#teacherRosterDialog').waitFor({ state: 'visible' });
        assert.match(await d.page.locator('#teacherRosterDialog').textContent(), /Nguyễn Minh An/);
        assert.match(await d.page.locator('#teacherRosterDialog').textContent(), /Trần Khánh Bình/);
        assert.doesNotMatch(await d.page.locator('#teacherRosterDialog').textContent(), /CCCD/);
        await d.page.locator('#teacherStudentSearch').fill('Minh An');
        await d.page.waitForFunction(() => !document.querySelector('#teacherRosterDialog').textContent.includes('Trần Khánh Bình'));
        await d.page.locator('#teacherRosterClose').click();
        assert.equal(await d.page.locator('#teacherRosterDialog').count(), 0);
        if (viewport.width < 500) await d.page.locator('#teacherMenu').click();
        await d.page.locator('[data-teacher-view="profile"]').click();
        assert.match(await d.page.locator('#teacherPage').textContent(), /0900123456/);
        assert.match(await d.page.locator('#teacherPage').textContent(), /teacher@example.test/);
        if (viewport.width < 500) await d.page.locator('#teacherMenu').click();
        await d.page.locator('#logoutButton').click();
        await d.page.locator('#authScreen').waitFor({ state: 'visible' });
        assert.equal(await d.page.locator('#teacherPage').textContent(), '');
        assert.equal(await d.page.locator('#teacherRosterRoot').textContent(), '');
        assert.deepEqual(d.errors, []);
        console.log(`PASS ${viewport.width}px: verified teacher login, filtered timetable, academic years, read-only rosters/profile and private logout.`);
      } finally { await d.context.close(); }
    }

    const noAccess = await device(browser, server.origin, { rpc: { schools: false } });
    try {
      await noAccess.auth.signIn();
      assert.match(await noAccess.page.locator('#teacherPage').textContent(), /chưa|chưa được/i);
      assert.equal(await noAccess.page.locator('[data-teacher-roster]').count(), 0);
      assert.equal(noAccess.rpc.calls.some(call => call.name === 'get_teacher_portal'), false);
      noAccess.rpc.schools = true;
      await noAccess.page.locator('#teacherRefresh').click();
      await noAccess.page.waitForFunction(() => document.querySelector('#teacherPage').textContent.includes('Toán'));
      noAccess.rpc.schools = false;
      await noAccess.page.locator('#teacherRefresh').click();
      await noAccess.page.waitForFunction(() => !document.querySelector('#teacherPage').textContent.includes('Toán'));
      assert.equal(await noAccess.page.locator('[data-teacher-roster]').count(), 0, 'Revocation clears the previous teacher records');
      assert.deepEqual(noAccess.errors, []);
      console.log('PASS: an account with no grant has a usable empty state; refreshing reflects grant and revocation.');
    } finally { await noAccess.context.close(); }

    const failure = await device(browser, server.origin, { rpc: { error: { code: 'PGRST202', message: 'Could not find the function public.list_teacher_schools' } } });
    try {
      await failure.page.locator('#loginEmail').fill(EMAIL);
      await failure.page.locator('#loginPassword').fill(PASSWORD);
      await failure.page.locator('#loginSubmit').click();
      await failure.page.waitForFunction(() => document.querySelector('#loginError').textContent.trim());
      assert.equal(await failure.page.locator('#appRoot').isVisible(), false, 'An unavailable portal backend must not reveal partial school data');
      assert.deepEqual(failure.errors, []);
      console.log('PASS: missing teacher backend stays behind the login gate with a recoverable error.');
    } finally { await failure.context.close(); }

    const focus = await device(browser, server.origin);
    const focusGate = deferred();
    focus.rpc.held = { name: 'get_teacher_portal', userId: USER_ID, gate: focusGate };
    try {
      await focus.page.locator('#loginEmail').fill(EMAIL); await focus.page.locator('#loginPassword').fill(PASSWORD); await focus.page.locator('#loginSubmit').click();
      await until(() => focus.rpc.calls.some(call => call.name === 'get_teacher_portal'), 'initial teacher read before focus');
      await focus.page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      focusGate.resolve();
      await focus.page.locator('#appRoot').waitFor({ state: 'visible' });
      assert.match(await focus.page.locator('#teacherPage').textContent(), /Võ Thành Long/);
      assert.equal(await focus.page.locator('#loginError').textContent(), '');
      assert.deepEqual(focus.errors, []);
      console.log('PASS: focus and visibility refresh events cannot cancel an in-progress initial teacher login.');
    } finally { focusGate.resolve(); await focus.context.close(); }

    const race = await device(browser, server.origin);
    const gate = deferred();
    race.rpc.held = { name: 'get_teacher_portal', userId: USER_ID, gate };
    try {
      await race.page.locator('#loginEmail').fill(EMAIL); await race.page.locator('#loginPassword').fill(PASSWORD); await race.page.locator('#loginSubmit').click();
      await until(() => race.rpc.calls.some(call => call.name === 'get_teacher_portal' && call.userId === USER_ID), 'held first-teacher portal request');
      await race.page.evaluate(async password => {
        const result = await window.__testAuthClient.auth.signInWithPassword({ email: 'second@example.test', password });
        if (result.error) throw result.error;
      }, PASSWORD);
      await race.page.locator('#appRoot').waitFor({ state: 'visible' });
      assert.equal(await race.page.locator('#currentAccountName').textContent(), 'second@example.test');
      assert.match(await race.page.locator('#teacherPage').textContent(), /Giáo viên thứ hai/);
      gate.resolve();
      await race.page.waitForTimeout(100);
      assert.doesNotMatch(await race.page.locator('#teacherPage').textContent(), /Võ Thành Long/);
      assert.match(await race.page.locator('#teacherPage').textContent(), /Giáo viên thứ hai/);
      assert.deepEqual(race.errors, []);
      console.log('PASS: a late prior-account portal response cannot replace a different teacher’s data.');
    } finally { gate.resolve(); await race.context.close(); }

    const admin = await device(browser, server.origin, { admin: true });
    try {
      await admin.auth.signIn();
      await admin.page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'synced');
      await admin.page.locator('.nav-btn[data-page="teachers"]').click();
      await admin.page.locator('[data-teacher-access-open]').click();
      await admin.page.locator('#accessTeacher').selectOption('Võ Thành Long');
      await admin.page.locator('#accessEmail').fill('math-teacher@example.test');
      await admin.page.locator('#teacherAccessForm [data-access-mutate]').click();
      await admin.page.locator('[data-access-revoke="Võ Thành Long"]').waitFor({ state: 'visible' });
      const grant = admin.rpc.calls.find(call => call.name === 'manage_teacher_access');
      assert.deepEqual(grant.args, { p_teacher_name: 'Võ Thành Long', p_email: 'math-teacher@example.test', p_enabled: true });
      assert.match(await admin.page.locator('#teacherAccessMessage').textContent(), /Đã liên kết/);
      await admin.page.locator('[data-access-revoke="Võ Thành Long"]').click();
      await admin.page.waitForFunction(() => document.querySelector('#teacherAccessMessage').textContent.includes('Đã thu hồi'));
      assert.equal(await admin.page.locator('[data-access-revoke]').count(), 0);
      assert.equal(admin.rpc.calls.filter(call => call.name === 'manage_teacher_access').at(-1).args.p_enabled, false);
      assert.deepEqual(admin.errors, []);
      console.log('PASS: owner links an existing teacher account after syncing the profile and can revoke it.');

      await admin.page.locator('[data-action="close-modal"]').first().click();
      admin.rpc.error = { code: 'PGRST202', message: 'Could not find the function public.list_school_teacher_access' };
      await admin.page.locator('[data-teacher-access-open]').click();
      await admin.page.locator('[data-access-copy-sql]').waitFor({ state: 'visible' });
      assert.match(await admin.page.locator('#teacherAccessContent').textContent(), /Cài đặt quyền truy cập giáo viên/);
      await admin.page.locator('[data-access-copy-sql]').click();
      await admin.page.waitForFunction(() => document.querySelector('#teacherAccessSQL').value.includes('create'));
      assert.ok(await admin.page.locator('#teacherAccessSQL').inputValue());
      assert.deepEqual(admin.errors, []);
      console.log('PASS: missing backend has visible SQL setup, download/copy fallback and retry controls.');
    } finally { await admin.context.close(); }

    const shared = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const ownerPage = await shared.newPage();
      const ownerAuth = await installAuthMocks(ownerPage);
      await mockTeacherRPC(ownerPage, ownerAuth);
      await ownerPage.goto(server.origin); await ownerAuth.signIn();
      const teacherPage = await shared.newPage();
      const teacherAuth = await installAuthMocks(teacherPage, { userId: OTHER_ID, email: 'teacher@example.test' });
      await mockTeacherRPC(teacherPage, teacherAuth);
      await teacherPage.goto(server.origin + '/teacher.html');
      assert.equal(await teacherPage.locator('#appRoot').isVisible(), false, 'The teacher page must not restore the separate admin session');
      await teacherAuth.signIn('teacher@example.test');
      assert.equal(await ownerPage.locator('#appRoot').isVisible(), true);
      assert.equal(await ownerPage.locator('#currentAccountName').textContent(), EMAIL, 'Teacher sign-in must not switch the open admin account');
      await teacherPage.locator('#logoutButton').click();
      await teacherPage.locator('#authScreen').waitFor({ state: 'visible' });
      assert.equal(await ownerPage.locator('#appRoot').isVisible(), true);
      assert.equal(await ownerPage.locator('#currentAccountName').textContent(), EMAIL, 'Teacher logout must not end the open admin session');
      console.log('PASS: owner and teacher tabs keep separate auth sessions in the same browser.');
    } finally { await shared.close(); }

    const adminRace = await device(browser, server.origin, { admin: true });
    const adminGate = deferred();
    try {
      await adminRace.auth.signIn();
      await adminRace.page.locator('.nav-btn[data-page="teachers"]').click();
      adminRace.rpc.held = { name: 'list_school_teacher_access', userId: USER_ID, gate: adminGate };
      await adminRace.page.locator('[data-teacher-access-open]').click();
      await until(() => adminRace.rpc.calls.some(call => call.name === 'list_school_teacher_access'), 'held admin access list');
      await adminRace.page.locator('[data-action="close-modal"]').first().click();
      await adminRace.page.locator('#logoutButton').click();
      await adminRace.page.locator('#authScreen').waitFor({ state: 'visible' });
      await adminRace.auth.signIn('second@example.test');
      adminGate.resolve();
      await adminRace.page.waitForTimeout(100);
      assert.equal(await adminRace.page.locator('#currentAccountName').textContent(), 'second@example.test');
      assert.equal(await adminRace.page.locator('#teacherAccessContent').count(), 0, 'Old admin responses cannot recreate a closed private modal');
      assert.deepEqual(adminRace.errors, []);
      console.log('PASS: late owner access-list replies stay cancelled after logout/account change.');
    } finally { adminGate.resolve(); await adminRace.context.close(); }
  } finally { await browser.close(); await server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
