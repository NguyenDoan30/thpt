const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

// Run with: node tests/teacher-homework-attachments.cjs
// Uses synthetic files and isolated browser profiles; no school account or remote upload.
const root = path.resolve(process.env.TEACHER_SITE_TEST_ROOT || path.join(__dirname, '..', 'teacher-site'));
const files = new Set(['index.html', 'auth-config.js', 'auth.js', 'teacher-portal.js', 'teacher-portal.css', 'teacher-homework.js', 'teacher-homework.css', 'teacher-attachments.js']);
const storageKey = 'thpt-teacher-demo-v1';
const year = '2026-2027';
const maxBytes = 5 * 1024 * 1024;
const png = { name: 'Hình bài tập.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ8kAAAAASUVORK5CYII=', 'base64') };
const pdf = { name: 'Đề ôn tập.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Homework attachment regression fixture\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8') };
const schedule = [{ classId: 'demo-10a2', day: 1, period: 1, subject: 'Toán', room: '' }];

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

async function openHomework(page) {
  await page.locator('#appRoot').waitFor({ state: 'visible' });
  await page.locator('#teacherHome [data-teacher-view="homework"]').click();
  await page.locator('#teacherHomeworkForm').waitFor({ state: 'visible' });
}

async function fillHomework(page, title, classId = 'demo-10a2') {
  await page.locator('#teacherHomeworkClass').selectOption(classId);
  await page.locator('#teacherHomeworkSubject').selectOption('Toán');
  await page.locator('#teacherHomeworkTitle').fill(title);
  await page.locator('#teacherHomeworkInstructions').fill('Làm bài tập trong tài liệu và hình đính kèm.');
  await page.locator('#teacherHomeworkDue').fill('2026-11-30');
}

async function waitCount(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('#teacherHomeworkAttachments [data-homework-remove-file]').length === expected, count);
}

async function expectFileError(page, unchangedCount) {
  await page.waitForFunction(() => document.querySelector('#teacherHomeworkMessage')?.dataset.error === 'true');
  assert.ok((await page.locator('#teacherHomeworkMessage').textContent()).trim(), 'A rejected attachment explains the error');
  assert.equal(await page.locator('#teacherHomeworkAttachments [data-homework-remove-file]').count(), unchangedCount, 'A rejected file must not replace accepted attachments');
}

async function downloadedBytes(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  const stream = await download.createReadStream();
  assert.ok(stream, 'A saved attachment must provide a readable download');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(await download.failure(), null, 'The attachment download must complete');
  return { name: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

async function runDemo(browser, origin, viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.url()); });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(({ key, initial }) => {
    if (!sessionStorage.getItem('attachment-test-seeded')) {
      localStorage.setItem(key, JSON.stringify(initial));
      sessionStorage.setItem('attachment-test-seeded', '1');
    }
  }, { key: storageKey, initial: { current: year, schedule, gradebooks: [], homework: [] } });
  try {
    await page.goto(origin + '/?demo=1');
    await openHomework(page);
    assert.equal(await page.locator('#teacherHomeworkFiles').getAttribute('type'), 'file');
    assert.equal(await page.locator('#teacherHomeworkFiles').evaluate(input => input.multiple), true);
    assert.equal(await page.locator('#teacherHomeworkImages').getAttribute('type'), 'file');
    assert.equal(await page.locator('#teacherHomeworkImages').evaluate(input => input.multiple), true);
    assert.equal(await page.locator('#teacherHomeworkAddFiles').isVisible(), true, 'The teacher can choose a file from the form');
    assert.equal(await page.locator('#teacherHomeworkAddImages').isVisible(), true, 'The teacher can choose an image from the form');
    await fillHomework(page, 'Bài tập có tệp và ảnh');
    await page.locator('#teacherHomeworkImages').setInputFiles(png);
    await waitCount(page, 1);
    await page.locator('#teacherHomeworkFiles').setInputFiles(pdf);
    await waitCount(page, 2);
    assert.match(await page.locator('#teacherHomeworkAttachments').textContent(), /Hình bài tập\.png/);
    assert.match(await page.locator('#teacherHomeworkAttachments').textContent(), /Đề ôn tập\.pdf/);
    assert.equal(await page.locator('#teacherHomeworkAttachments img').count(), 1, 'An attached image has a visible preview');

    await page.locator('#teacherHomeworkFiles').setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.__attachmentXSS=1</script></svg>') });
    await expectFileError(page, 2);
    assert.equal(await page.locator('#teacherHomeworkAttachments img[src*="unsafe"], #teacherHomeworkAttachments script, #teacherHomeworkAttachments iframe, #teacherHomeworkAttachments object, #teacherHomeworkAttachments embed').count(), 0, 'Unsafe SVG must never become an image or executable document');
    assert.equal(await page.evaluate(() => window.__attachmentXSS), undefined);
    await page.locator('#teacherHomeworkFiles').setInputFiles({ name: 'too-large.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(maxBytes)]) });
    await expectFileError(page, 2);

    await page.locator('#teacherHomeworkFiles').setInputFiles([1, 2, 3].map(index => ({ ...pdf, name: 'Bài thêm ' + index + '.pdf' })));
    await waitCount(page, 5);
    await page.locator('#teacherHomeworkFiles').setInputFiles({ ...pdf, name: 'Tệp thứ sáu.pdf' });
    await expectFileError(page, 5);
    for (let count = 5; count > 2; --count) {
      await page.locator('#teacherHomeworkAttachments [data-homework-remove-file]').last().click();
      await waitCount(page, count - 1);
    }
    assert.doesNotMatch(await page.locator('#teacherHomeworkAttachments').textContent(), /Bài thêm|Tệp thứ sáu|unsafe|too-large/);
    await page.locator('#teacherHomeworkSave').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Attachment names and previews fit a narrow screen');
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelectorAll('#teacherHomeworkList [data-homework-download]').length === 2);
    const beforeReload = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    const saved = beforeReload.homework.find(item => item.title === 'Bài tập có tệp và ảnh');
    assert.ok(saved, 'The assignment is saved in the existing demo store');
    assert.deepEqual(saved.attachments.map(file => ({ name: file.name, size: file.size, type: file.type })).sort((a, b) => a.name.localeCompare(b.name)), [png, pdf].map(file => ({ name: file.name, size: file.buffer.length, type: file.mimeType })).sort((a, b) => a.name.localeCompare(b.name)));
    assert.ok(saved.attachments.every(file => file.id && file.path && !file.data && !file.dataUrl && !file.base64), 'Demo homework stores references instead of embedding file contents into localStorage');
    assert.deepEqual(beforeReload.schedule, schedule, 'Attachment saves preserve existing teaching assignments');

    await page.reload();
    await openHomework(page);
    const card = page.locator('#teacherHomeworkList .homework-item').filter({ hasText: 'Bài tập có tệp và ảnh' });
    assert.equal(await card.locator('[data-homework-download]').count(), 2, 'Saved files remain available after a reload');
    for (const file of [png, pdf]) {
      const button = card.getByRole('button', { name: 'Tải tệp ' + file.name, exact: true });
      assert.equal(await button.count(), 1, 'Each saved attachment offers a named download');
      const downloaded = await downloadedBytes(page, button);
      assert.equal(downloaded.name, file.name);
      assert.deepEqual(downloaded.bytes, file.buffer, 'The downloaded file retains its original bytes after reloading');
    }
    await card.locator('[data-homework-edit]').click();
    await waitCount(page, 2);
    await page.locator('#teacherHomeworkAttachments [data-homework-remove-file]').last().click();
    await waitCount(page, 1);
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelectorAll('#teacherHomeworkList [data-homework-download]').length === 1);
    await page.reload();
    await openHomework(page);
    assert.equal(await page.locator('#teacherHomeworkList [data-homework-download]').count(), 1, 'Removing a saved attachment persists after reloading');
    assert.deepEqual(writes, [], 'Demo attachments never upload to a remote school workspace');
    assert.deepEqual(errors, []);
    console.log('PASS demo attachments ' + viewport.width + '×' + viewport.height + ': file/image pickers, previews, type/size/count validation, removal, save, reload and original-byte downloads.');
  } finally { await context.close(); }
}

async function runLiveMock(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(), errors = [], uploaded = new Map();
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__recordAttachmentUpload', ({ objectPath, bytes, type }) => { uploaded.set(objectPath, { bytes: Buffer.from(bytes), type }); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.startsWith('/__attachment_download/')) {
      const objectPath = decodeURIComponent(url.pathname.slice('/__attachment_download/'.length));
      const file = uploaded.get(objectPath);
      assert.ok(file, 'Only objects uploaded through the mocked storage client are downloadable');
      await route.fulfill({ status: 200, contentType: file.type, body: file.bytes });
      return;
    }
    await (url.origin === origin ? route.continue() : route.abort());
  });
  try {
    await page.goto(origin + '/?demo=1');
    await page.locator('#appRoot').waitFor({ state: 'visible' });
    await page.evaluate(async ({ origin }) => {
      const user = { id: '11111111-1111-4111-8111-111111111111', email: 'teacher@example.test' };
      const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      window.__attachmentMock = { calls: [], rows: [], objects: {}, loseUploadResponse: true, failFirstVerification: true, deferDownload: false, downloadWaiting: false, storageBefore: JSON.stringify(localStorage) };
      const mock = window.__attachmentMock;
      const client = {
        auth: { getSession: async () => ({ data: { session: { user, access_token: 'test-session' } } }) },
        from(name) { throw new Error('Full workspace access is forbidden: ' + name); },
        storage: {
          from(bucket) {
            if (bucket !== 'teacher-homework-files') throw new Error('Unexpected bucket ' + bucket);
            return {
              async upload(objectPath, file, options) {
                mock.calls.push({ name: 'storage.upload', bucket, objectPath, fileName: file.name, type: file.type, size: file.size, options });
                if (mock.objects[objectPath]) return { data: null, error: { status: 409, statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } };
                const object = { objectPath, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), type: file.type };
                mock.objects[objectPath] = object;
                await window.__recordAttachmentUpload(object);
                if (mock.loseUploadResponse) {
                  mock.loseUploadResponse = false;
                  return { data: null, error: { status: 0, message: 'Network response lost after the object was stored' } };
                }
                return { data: { path: objectPath }, error: null };
              },
              async createSignedUrl(objectPath, expiresIn, options) {
                mock.calls.push({ name: 'storage.createSignedUrl', bucket, objectPath, expiresIn, options });
                return { data: { signedUrl: origin + '/__attachment_download/' + encodeURIComponent(objectPath) }, error: null };
              },
              async download(objectPath) {
                mock.calls.push({ name: 'storage.download', bucket, objectPath });
                const object = mock.objects[objectPath];
                if (!object) return { data: null, error: { status: 404, message: 'Object not found' } };
                if (mock.failFirstVerification) {
                  mock.failFirstVerification = false;
                  return { data: null, error: { status: 0, message: 'The network is still unavailable during initial verification' } };
                }
                if (mock.deferDownload) {
                  mock.downloadWaiting = true;
                  await new Promise(resolve => { window.__releaseAttachmentDownload = resolve; });
                  mock.downloadWaiting = false;
                }
                return { data: new Blob([new Uint8Array(object.bytes)], { type: object.type }), error: null };
              },
              async remove(paths) { mock.calls.push({ name: 'storage.remove', bucket, paths }); return { data: paths.map(name => ({ name })), error: null }; },
            };
          },
        },
        rpc(name, args) {
          const execute = async () => {
            mock.calls.push({ name, args: structuredClone(args) });
            if (name === 'list_teacher_schools') return { data: [{ owner_id: owner, school: { name: 'Trường kiểm thử' } }] };
            if (name === 'get_teacher_portal') return { data: { school: { name: 'Trường kiểm thử' }, teacher: { name: 'Giáo viên kiểm thử', subjects: ['Toán'] }, current: '2026-2027', years: ['2026-2027'], classes: [{ id: 'live-class', name: '10A1' }], assignments: [{ classId: 'live-class', subject: 'Toán' }], schedule: [], studentProfiles: [] } };
            if (name === 'list_teacher_homework') return { data: structuredClone(mock.rows) };
            if (name === 'save_teacher_homework') {
              const row = { id: args.p_homework_id, classId: args.p_class_id, subject: args.p_subject, title: args.p_title, instructions: args.p_instructions, dueDate: args.p_due_date, resourceUrl: args.p_resource_url, attachments: args.p_attachments || [] };
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
      window.__reconnectAttachmentMock = async () => {
        await window.schoolAppAuthHooks.prepare(user, client);
        window.schoolAppAuthHooks.unlock();
      };
      await window.schoolAppAuthHooks.prepare(user, client);
      window.schoolAppAuthHooks.unlock();
    }, { origin });
    await openHomework(page);
    await fillHomework(page, 'Bài tập có tệp trên máy chủ', 'live-class');
    await page.locator('#teacherHomeworkFiles').setInputFiles(pdf);
    await waitCount(page, 1);
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelector('#teacherHomeworkMessage')?.dataset.error === 'true' && !document.querySelector('#teacherHomeworkSave').disabled);
    const failed = await page.evaluate(() => window.__attachmentMock);
    assert.equal(failed.rows.length, 0, 'A lost upload response must not report the assignment saved');
    assert.equal(failed.calls.filter(call => call.name === 'save_teacher_homework').length, 0, 'Metadata cannot save until the attachment is confirmed');
    assert.equal(Object.keys(failed.objects).length, 1, 'The simulated network failure happens after storage accepted the object');
    assert.equal(await page.locator('#teacherHomeworkAttachments [data-homework-remove-file]').count(), 1, 'A failed upload preserves the selected file for retry');
    await page.locator('#teacherHomeworkSave').click();
    await page.waitForFunction(() => document.querySelectorAll('#teacherHomeworkList [data-homework-download]').length === 1);
    const beforeDownload = await page.evaluate(() => window.__attachmentMock);
    const save = beforeDownload.calls.find(call => call.name === 'save_teacher_homework');
    assert.ok(save, 'Live homework uses the scoped save RPC');
    const uploads = beforeDownload.calls.filter(call => call.name === 'storage.upload');
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].objectPath, uploads[1].objectPath, 'Retrying a lost upload response reuses the original UUID instead of leaving a duplicate object');
    assert.ok(uploads.every(upload => upload.options.upsert === false), 'Attachments cannot overwrite an existing cloud object');
    assert.ok(beforeDownload.calls.some(call => call.name === 'storage.download' && call.objectPath === uploads[0].objectPath), 'A 409 retry verifies the existing object before saving its metadata');
    assert.equal(beforeDownload.calls.filter(call => call.name === 'storage.remove').length, 0, 'Recovery must retain the verified object');
    assert.equal(save.args.p_attachments.length, 1);
    for (const file of save.args.p_attachments) {
      assert.deepEqual(Object.keys(file).sort(), ['id', 'name', 'path', 'size', 'type']);
      assert.match(file.id, /^[0-9a-f-]{36}$/i);
      assert.equal(file.path, '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' + save.args.p_homework_id + '/' + file.id + '.pdf');
      assert.equal(uploads.find(upload => upload.objectPath === file.path)?.size, file.size);
      assert.equal(uploads.find(upload => upload.objectPath === file.path)?.options.contentType, file.type);
      assert.ok(uploaded.has(file.path), 'Metadata references an object uploaded before the homework save');
    }
    assert.equal(beforeDownload.calls.filter(call => call.name === 'storage.createSignedUrl').length, 0, 'A PDF does not request a signed URL until the teacher downloads it');
    await page.evaluate(() => window.__reconnectAttachmentMock());
    await openHomework(page);
    await page.waitForFunction(() => document.querySelectorAll('#teacherHomeworkList [data-homework-download]').length === 1);
    const button = page.locator('#teacherHomeworkList').getByRole('button', { name: 'Tải tệp ' + pdf.name, exact: true });
    const downloaded = await downloadedBytes(page, button);
    assert.equal(downloaded.name, pdf.name);
    assert.deepEqual(downloaded.bytes, pdf.buffer, 'The authenticated storage download retains the original PDF bytes');
    const cloud = await page.evaluate(() => window.__attachmentMock);
    const signing = cloud.calls.filter(call => call.name === 'storage.createSignedUrl');
    assert.equal(signing.length, 1, 'Cloud access requests a temporary signed URL on download');
    assert.ok(signing.every(call => call.expiresIn > 0 && call.expiresIn <= 3600), 'Download URLs have a bounded lifetime');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage) === window.__attachmentMock.storageBefore), true, 'Live attachments are not stored in the demo localStorage');

    const lateDownloads = [];
    page.on('download', download => lateDownloads.push(download.suggestedFilename()));
    await page.evaluate(() => { window.__attachmentMock.deferDownload = true; });
    await button.click();
    await page.waitForFunction(() => window.__attachmentMock.downloadWaiting);
    await page.evaluate(() => {
      window.schoolAppAuthHooks.lock();
      window.schoolAppAuthHooks.enterDemo();
      window.__releaseAttachmentDownload();
    });
    await page.waitForFunction(() => !window.__attachmentMock.downloadWaiting);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.deepEqual(lateDownloads, [], 'An in-flight authenticated download must not deliver a file after logout and switching to demo');
    assert.equal(await page.locator('#teacherHome').isVisible(), true, 'A late download cannot replace the newly selected scope');
    assert.doesNotMatch(await page.locator('#teacherPage').textContent(), /Bài tập có tệp trên máy chủ|Đề ôn tập\.pdf/, 'The old account must not reappear after its download completes');
    assert.deepEqual(errors, []);
    console.log('PASS live attachments: private storage path/payload, lost-response + 409 verification/retry, on-demand PDF access, original-byte cloud download and no late download after logout.');
  } finally { await context.close(); }
}

async function run() {
  const server = await startServer();
  const artifactRoot = path.resolve(__dirname, '..', '.test-artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const downloadsPath = fs.mkdtempSync(path.join(artifactRoot, 'homework-attachments-'));
  let browser;
  try {
    const launch = { headless: true, downloadsPath };
    if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
    if (process.platform === 'linux') launch.args = ['--no-sandbox'];
    browser = await chromium.launch(launch);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 568 }]) await runDemo(browser, server.origin, viewport);
    await runLiveMock(browser, server.origin);
  } finally {
    if (browser) await browser.close();
    await server.close();
    if (downloadsPath.startsWith(artifactRoot + path.sep)) fs.rmSync(downloadsPath, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
