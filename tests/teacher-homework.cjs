const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

// Run with: node tests/teacher-homework.cjs
// The demo and live RPC mock run without an Internet connection or school account.
const root = path.resolve(process.env.TEACHER_SITE_TEST_ROOT || path.join(__dirname, '..', 'teacher-site'));
const files = new Set(['index.html', 'auth-config.js', 'auth.js', 'teacher-portal.js', 'teacher-portal.css', 'teacher-homework.js', 'teacher-homework.css', 'teacher-attachments.js']);
const storageKey = 'thpt-teacher-demo-v1';
const year = '2026-2027';
const viewports = [{ width: 1280, height: 900 }, { width: 579, height: 532 }, { width: 390, height: 568 }, { width: 844, height: 390 }];
const gradebook = { id: 'existing-gradebook', classId: 'demo-10a2', subject: 'Toán', year, title: 'Điểm đã lưu', scores: { 'demo-student-01': 8.5 } };
const olderHomework = { id: 'old-homework', classId: 'demo-10a2', subject: 'Toán', year: '2025-2026', title: 'Bài tập năm trước', instructions: 'Ôn lại kiến thức.', dueDate: '2026-05-20', resourceUrl: '' };
const schedule = [
  { classId: 'demo-10a2', day: 1, period: 1, subject: 'Toán', room: '' },
  { classId: 'demo-10a2', day: 2, period: 1, subject: 'Ngữ văn', room: '' },
  { classId: 'demo-12a2', day: 3, period: 1, subject: 'Toán', room: '' },
];

async function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!files.has(filename) || !fs.existsSync(path.join(root, filename))) { response.writeHead(404); response.end(); return; }
    const type = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
    response.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(path.join(root, filename)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function navigate(page, view) {
  if (await page.locator('#teacherMenu').isVisible()) await page.locator('#teacherMenu').click();
  await page.locator('nav [data-teacher-view="' + view + '"]').click();
}

async function openFromHome(page) {
  await page.locator('#appRoot').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#teacherHome .stats .stat-label').allTextContents(), ['Lớp phụ trách', 'Tiết dạy mỗi tuần'], 'Only the two requested overview cards remain');
  const entry = page.locator('#teacherHome [data-teacher-view="homework"]');
  assert.equal(await entry.count(), 1, 'Home must provide a direct homework action');
  assert.match(await entry.textContent(), /Giao bài tập/);
  await entry.click();
  await page.locator('#teacherHomeworkForm').waitFor({ state: 'visible' });
}

async function fillHomework(page, values) {
  await page.locator('#teacherHomeworkClass').selectOption(values.classId || 'demo-10a2');
  await page.locator('#teacherHomeworkSubject').selectOption(values.subject || 'Ngữ văn');
  await page.locator('#teacherHomeworkTitle').fill(values.title);
  await page.locator('#teacherHomeworkInstructions').fill(values.instructions);
  await page.locator('#teacherHomeworkDue').fill(values.dueDate || '2026-11-30');
  await page.locator('#teacherHomeworkResource').fill(values.resourceUrl || '');
}

async function assertSaveReachable(page) {
  await page.locator('#teacherHomeworkSave').scrollIntoViewIfNeeded();
  const visible = await page.locator('#teacherHomeworkSave').evaluate(button => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.width > 0 && box.top >= 0 && box.bottom <= innerHeight + 1 && (hit === button || button.contains(hit));
  });
  assert.equal(visible, true, 'Homework save button must be reachable without an overlapping panel');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Homework form and list must fit the viewport horizontally');
}

async function runDemo(browser, origin, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.url()); });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(({ key, initial }) => {
    // Seed once: a reload must read what the application actually saved.
    if (!sessionStorage.getItem('homework-test-seeded')) {
      localStorage.setItem(key, JSON.stringify(initial));
      sessionStorage.setItem('homework-test-seeded', '1');
    }
  }, { key: storageKey, initial: { current: year, schedule, gradebooks: [gradebook], homework: [olderHomework] } });
  try {
    await page.goto(origin + '/?demo=1');
    await openFromHome(page);
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-edit]').count(), 0, 'Previous-year homework must be excluded');
    assert.equal(await page.locator('#teacherHomeworkForm').evaluate(form => form.checkValidity()), false, 'An empty assignment must fail form validation');
    await page.locator('#teacherHomeworkSave').click();
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-edit]').count(), 0, 'An empty form cannot create homework');
    assert.equal(await page.locator('#teacherHomeworkInstructions').evaluate(field => field.tagName), 'TEXTAREA');
    assert.equal(await page.locator('#teacherHomeworkDue').getAttribute('type'), 'date');
    assert.equal(await page.locator('#teacherHomeworkResource').getAttribute('type'), 'url');
    assert.equal(await page.locator('#teacherHomeworkResource').evaluate(field => field.required), false, 'A resource URL is optional');
    assert.deepEqual(await page.locator('#teacherHomeworkClass option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), ['demo-10a2', 'demo-12a2']);
    await page.locator('#teacherHomeworkClass').selectOption('demo-12a2');
    assert.deepEqual(await page.locator('#teacherHomeworkSubject option').allTextContents(), ['Toán'], 'Subject selection follows the assigned class');
    await page.locator('#teacherHomeworkClass').selectOption('demo-10a2');
    assert.deepEqual((await page.locator('#teacherHomeworkSubject option').allTextContents()).sort(), ['Ngữ văn', 'Toán']);

    const title = 'Ôn tập <img src=x onerror="window.__homeworkXSS=1"> & "Tuần 12"';
    const instructions = 'Làm câu 1–3.\n<script>window.__homeworkXSS=2</script>\nGiải thích bằng lời của em.';
    await fillHomework(page, { title, instructions });
    await assertSaveReachable(page);
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelector('#teacherHomeworkList [data-homework-edit]'));
    assert.match(await page.locator('#teacherHomeworkMessage').textContent(), /Đã (giao|lưu|cập nhật)/, 'Saving provides a visible success confirmation');
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-edit]').count(), 1);
    assert.ok((await page.locator('#teacherHomeworkList').textContent()).includes(title), 'Homework title is rendered as literal text');
    assert.ok((await page.locator('#teacherHomeworkList').textContent()).includes(instructions), 'Instructions are rendered as literal text');
    assert.equal(await page.locator('#teacherHomeworkList img, #teacherHomeworkList script').count(), 0, 'Homework text must not become executable markup');
    assert.equal(await page.evaluate(() => window.__homeworkXSS), undefined);
    const edit = page.locator('#teacherHomeworkList [data-homework-edit]');
    const id = await edit.getAttribute('data-homework-edit');
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-copy="' + id + '"]').count(), 1, 'A saved assignment offers a shareable-copy action');
    await edit.click();
    assert.equal(await page.locator('#teacherHomeworkTitle').inputValue(), title);
    assert.equal(await page.locator('#teacherHomeworkInstructions').inputValue(), instructions);
    assert.equal(await page.locator('#teacherHomeworkDue').inputValue(), '2026-11-30');
    assert.equal(await page.locator('#teacherHomeworkSubject').inputValue(), 'Ngữ văn');
    await page.locator('#teacherHomeworkTitle').fill('Bài tập đã chỉnh sửa');
    await page.locator('#teacherHomeworkResource').fill('https://example.test/bai-tap?lop=10A2&mon=van');
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelector('#teacherHomeworkList').textContent.includes('Bài tập đã chỉnh sửa'));
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-edit]').count(), 1, 'Editing updates the existing assignment without duplication');
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-edit]').getAttribute('data-homework-edit'), id);
    await page.locator('#teacherHomeworkNew').click();
    assert.equal(await page.locator('#teacherHomeworkTitle').inputValue(), '', 'New assignment clears the edit draft');

    await page.locator('#teacherYear').selectOption('2025-2026');
    assert.match(await page.locator('#teacherHomeworkList').textContent(), /Bài tập năm trước/);
    assert.doesNotMatch(await page.locator('#teacherHomeworkList').textContent(), /Bài tập đã chỉnh sửa/);
    await page.locator('#teacherYear').selectOption(year);
    await page.reload();
    await openFromHome(page);
    assert.match(await page.locator('#teacherHomeworkList').textContent(), /Bài tập đã chỉnh sửa/);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    const homework = saved.homework.find(item => item.id === id);
    assert.deepEqual({ classId: homework.classId, subject: homework.subject, year: homework.year, title: homework.title, instructions: homework.instructions, dueDate: homework.dueDate, resourceUrl: homework.resourceUrl }, { classId: 'demo-10a2', subject: 'Ngữ văn', year, title: 'Bài tập đã chỉnh sửa', instructions, dueDate: '2026-11-30', resourceUrl: 'https://example.test/bai-tap?lop=10A2&mon=van' });
    assert.deepEqual(saved.gradebooks, [gradebook], 'Homework saves must preserve the existing gradebook');
    assert.deepEqual(saved.schedule, schedule, 'Homework saves must preserve teaching assignments');
    await navigate(page, 'classes');
    await page.locator('[data-teacher-roster="demo-10a2"]').click();
    assert.equal(await page.locator('[data-teacher-score="demo-student-01"]').inputValue(), '8.5', 'The gradebook still opens with the previously saved score');
    await page.locator('#teacherRosterClose').click();
    assert.deepEqual(writes, [], 'Demo homework must never write to a remote school workspace');
    assert.deepEqual(errors, [], 'Homework interactions must not cause JavaScript errors');
    console.log('PASS ' + viewport.width + '×' + viewport.height + ': home cards, assignment subjects, create/edit, escaped text, optional resources, year isolation, reload and existing gradebook.');
  } finally { await context.close(); }
}

async function runLiveMock(browser, origin) {
  const context = await browser.newContext({ viewport: viewports[0] });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(origin + '/?demo=1');
    await page.locator('#appRoot').waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      const user = { id: '11111111-1111-4111-8111-111111111111', email: 'teacher@example.test' };
      const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      window.__homeworkMock = { calls: [], rows: [], failSave: false, storageBefore: JSON.stringify(localStorage) };
      const mock = window.__homeworkMock;
      const client = {
        auth: { getSession: async () => ({ data: { session: { user, access_token: 'test-session' } } }) },
        from(name) { mock.calls.push({ name: 'from:' + name }); throw new Error('Full workspace access is forbidden'); },
        rpc(name, args) {
          const execute = async () => {
            mock.calls.push({ name, args: structuredClone(args) });
            if (name === 'list_teacher_schools') return { data: [{ owner_id: owner, school: { name: 'Trường kiểm thử' } }] };
            if (name === 'get_teacher_portal') return { data: { school: { name: 'Trường kiểm thử' }, teacher: { name: 'Giáo viên kiểm thử', subjects: ['Toán'] }, current: '2026-2027', years: ['2026-2027'], classes: [{ id: 'live-class', name: '10A1' }], assignments: [{ classId: 'live-class', subject: 'Toán' }], schedule: [], studentProfiles: [] } };
            if (name === 'list_teacher_homework') return { data: structuredClone(mock.rows) };
            if (name === 'save_teacher_homework') {
              if (mock.failSave) return { error: { code: 'PGRST202', message: 'Function unavailable' } };
              const row = { id: args.p_homework_id, classId: args.p_class_id, subject: args.p_subject, title: args.p_title, instructions: args.p_instructions, dueDate: args.p_due_date, resourceUrl: args.p_resource_url };
              const index = mock.rows.findIndex(item => item.id === row.id);
              if (index < 0) mock.rows.push(row); else mock.rows[index] = row;
              return { data: structuredClone(row) };
            }
            throw new Error('Unexpected RPC ' + name);
          };
          const chain = { setHeader() { return chain; }, abortSignal() { return chain; }, then(resolve, reject) { return execute().then(resolve, reject); } };
          return chain;
        },
      };
      await window.schoolAppAuthHooks.prepare(user, client);
      window.schoolAppAuthHooks.unlock();
    });
    await openFromHome(page);
    await fillHomework(page, { classId: 'live-class', subject: 'Toán', title: 'Bài tập thật', instructions: 'Giải phương trình và nêu cách làm.' });
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelector('#teacherHomeworkList [data-homework-edit]'));
    const mock = await page.evaluate(() => window.__homeworkMock);
    const calls = mock.calls.filter(call => call.name === 'save_teacher_homework');
    assert.equal(calls.length, 1);
    const args = calls[0].args;
    assert.match(args.p_homework_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual({ ...args, p_homework_id: 'generated-id' }, { p_owner_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', p_year: year, p_class_id: 'live-class', p_subject: 'Toán', p_homework_id: 'generated-id', p_title: 'Bài tập thật', p_instructions: 'Giải phương trình và nêu cách làm.', p_due_date: '2026-11-30', p_resource_url: '', p_attachments: [] });
    await page.locator('#teacherHomeworkList [data-homework-edit]').click();
    await page.locator('#teacherHomeworkTitle').fill('Không được báo lưu thành công');
    await page.evaluate(() => { window.__homeworkMock.failSave = true; });
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelector('#teacherHomeworkMessage').dataset.error === 'true');
    assert.doesNotMatch(await page.locator('#teacherHomeworkList').textContent(), /Không được báo lưu thành công/, 'A rejected save must preserve the previously saved assignment');
    assert.equal(await page.locator('#teacherHomeworkTitle').inputValue(), 'Không được báo lưu thành công', 'A rejected save preserves the teacher draft');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage) === window.__homeworkMock.storageBefore), true, 'Live teacher homework must not be persisted in localStorage');
    const names = await page.evaluate(() => window.__homeworkMock.calls.map(call => call.name));
    assert.ok(names.every(name => ['list_teacher_schools', 'get_teacher_portal', 'list_teacher_homework', 'save_teacher_homework'].includes(name)), 'Live teacher homework must use scoped RPCs and never access an entire school workspace');
    assert.deepEqual(errors, []);
    console.log('PASS live RPC mock: scoped payload, generated UUID, no workspace access/local persistence, recoverable failed save with preserved draft.');
  } finally { await context.close(); }
}

async function run() {
  const server = await startServer();
  let browser;
  try {
    const launch = { headless: true };
    if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
    if (process.platform === 'linux') launch.args = ['--no-sandbox'];
    browser = await chromium.launch(launch);
    for (const viewport of viewports) await runDemo(browser, server.origin, viewport);
    await runLiveMock(browser, server.origin);
  } finally { if (browser) await browser.close(); await server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
