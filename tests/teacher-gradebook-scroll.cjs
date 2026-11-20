const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

// Run with: node tests/teacher-gradebook-scroll.cjs
// CHROMIUM_PATH may select an installed browser. TEACHER_SITE_TEST_ROOT may
// select an exported historical teacher-site directory for regression checks.
const root = path.resolve(process.env.TEACHER_SITE_TEST_ROOT || path.join(__dirname, '..', 'teacher-site'));
const files = new Set(['index.html', 'auth-config.js', 'auth.js', 'teacher-portal.js', 'teacher-portal.css', 'teacher-homework.js', 'teacher-homework.css', 'teacher-attachments.js']);
const viewports = [
  { width: 778, height: 746 },
  { width: 520, height: 490 },
  { width: 390, height: 568 },
  { width: 844, height: 390 },
];
const lastScoreSelector = '[data-teacher-score="demo-student-20"]';

async function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!files.has(filename) || !fs.existsSync(path.join(root, filename))) {
      response.writeHead(404); response.end(); return;
    }
    const type = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
    response.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(path.join(root, filename)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function openGradebook(page) {
  await page.locator('#appRoot').waitFor({ state: 'visible' });
  if (await page.locator('#teacherMenu').isVisible()) await page.locator('#teacherMenu').click();
  await page.locator('[data-teacher-view="classes"]').click();
  await page.locator('[data-teacher-roster="demo-10a2"]').click();
  await page.locator('#teacherRosterDialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#teacherRosterRows tr').count(), 20, 'Demo class must contain all 20 students');
}

async function assertFullyVisible(page, selector, description) {
  const metrics = await page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (style.overflowX !== 'visible') { clip.left = Math.max(clip.left, box.left + parent.clientLeft); clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth); }
      if (style.overflowY !== 'visible') { clip.top = Math.max(clip.top, box.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight); }
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { rect: rect.toJSON(), clip, hit: !!hit && (hit === element || element.contains(hit)) };
  });
  const { rect, clip } = metrics;
  assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1 && metrics.hit,
    description + ' must be fully visible and unobstructed: ' + JSON.stringify(metrics));
}

async function bodyPoint(page) {
  return page.locator('#teacherRosterDialog').evaluate(dialog => {
    const box = dialog.getBoundingClientRect();
    const head = dialog.querySelector('.roster-head').getBoundingClientRect();
    const footer = dialog.querySelector('.roster-footer').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: (head.bottom + footer.top) / 2 };
  });
}

async function wheelToEnd(page) {
  const point = await bodyPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 20000);
  await page.waitForFunction(selector => {
    const input = document.querySelector(selector), rect = input.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === input;
  }, lastScoreSelector, { timeout: 3000 });
  await assertFullyVisible(page, lastScoreSelector, 'Last student score after mouse wheel');
  await assertFullyVisible(page, '#teacherGradeSave', 'Save button while viewing the last student');
}

async function verifyControlsWheel(page) {
  // Use an exposed label or padding point, never a select/input where wheel
  // could change the field. No scrollTop assignment or scrollIntoView is used.
  const point = await page.locator('.grade-controls').evaluate(controls => {
    const box = controls.getBoundingClientRect();
    for (let y = Math.max(1, Math.ceil(box.top + 2)); y < Math.min(innerHeight, box.bottom - 1); y += 5) {
      for (let x = Math.max(1, Math.ceil(box.left + 3)); x < Math.min(innerWidth, box.right - 1); x += 20) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest('.grade-controls') === controls && !hit.closest('input,select,button')) return { x, y };
      }
    }
    return null;
  });
  assert.ok(point, 'Assessment controls must expose a usable mouse wheel target');
  const before = await page.locator(lastScoreSelector).evaluate(input => input.getBoundingClientRect().top);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 260);
  try {
    await page.waitForFunction(({ selector, before }) => document.querySelector(selector).getBoundingClientRect().top < before - 20,
      { selector: lastScoreSelector, before }, { timeout: 2000 });
  } catch (error) {
    const after = await page.locator(lastScoreSelector).evaluate(input => input.getBoundingClientRect().top);
    assert.fail('Mouse wheel over assessment controls must move toward students; last student y before=' + before + ', after=' + after + '. The table must remain reachable in a short dialog.');
  }
}

async function runViewport(browser, origin, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Demo does not need Supabase or fonts; keep this regression deterministic
  // and independent of an Internet connection or a school account.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(origin + '/?demo=1');
    await openGradebook(page);
    await assertFullyVisible(page, '#teacherGradeSave', 'Save button on opening the gradebook');
    await page.locator('#teacherGradeTitle').fill('Kiểm tra cuộn ' + viewport.width + '×' + viewport.height);
    await verifyControlsWheel(page);
    await wheelToEnd(page);
    await page.locator(lastScoreSelector).fill('8.5');

    // Searching rerenders the rows. A score entered outside the filtered result
    // must survive that rerender and the subsequent save.
    await page.locator('#teacherStudentSearch').fill('Học sinh mẫu 01');
    assert.equal(await page.locator('#teacherRosterRows tr').count(), 1);
    await page.locator('[data-teacher-score="demo-student-01"]').fill('7.2');
    await page.locator('#teacherStudentSearch').fill('');
    assert.equal(await page.locator('#teacherRosterRows tr').count(), 20);
    await wheelToEnd(page);
    assert.equal(await page.locator(lastScoreSelector).inputValue(), '8.5', 'Filtering must retain the last student score');
    await page.locator('#teacherGradeSave').click();
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('thpt-teacher-demo-v1') || 'null');
      const book = saved?.gradebooks?.find(item => item.classId === 'demo-10a2');
      return book?.scores['demo-student-20'] === 8.5 && book?.scores['demo-student-01'] === 7.2;
    });
    assert.match(await page.locator('#teacherGradeMessage').textContent(), /Đã lưu điểm/, 'Saving must show an explicit success confirmation');
    assert.equal(await page.locator('#teacherGradeMessage').evaluate(message => !!message.closest('.roster-footer')), true, 'Save confirmation must be in the fixed footer');
    // Check the confirmation where saving leaves the user, without scrolling it into view.
    await assertFullyVisible(page, '#teacherGradeMessage', 'Save confirmation after saving');
    await assertFullyVisible(page, '#teacherGradeSave', 'Save button after saving');
    await page.locator(lastScoreSelector).fill('8.6');
    assert.equal((await page.locator('#teacherGradeMessage').textContent()).trim(), '', 'Editing a score must clear the previous save confirmation');
    await page.locator('#teacherRosterClose').click();
    assert.equal(await page.locator('#teacherRosterDialog').count(), 0);
    await page.reload();
    await openGradebook(page);
    assert.match(await page.locator('#teacherGradeAssessment option:checked').textContent(), /Kiểm tra cuộn/);
    await wheelToEnd(page);
    assert.equal(await page.locator(lastScoreSelector).inputValue(), '8.5', 'Last score must persist after a page reload and reopening the dialog');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Dialog must fit the viewport horizontally');
    assert.deepEqual(errors, [], 'Demo interactions must have no JavaScript exceptions');
    console.log('PASS ' + viewport.width + '×' + viewport.height + ': wheel over controls reaches all 20 students; last score editable; Save and confirmation visible; editing clears confirmation; filtering and reload retain scores.');
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
    for (const viewport of viewports) await runViewport(browser, server.origin, viewport);
  } finally { if (browser) await browser.close(); await server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
