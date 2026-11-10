const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer, prepareAuthenticatedPage } = require('./auth-fixture.cjs');

const CURRENT = '2027-2028';
const fixture = () => ({
  subjects: ['Toán', 'Ngữ văn', 'Vật lý'],
  classes: [
    ...['a', 'b', 'c'].map((letter, index) => ({ id: 'class-' + letter, name: '11A' + (index + 1), grade: 'Khối 11', admissionYear: 2026, students: 0, teacher: '' })),
    { id: 'archive', name: '12C1', grade: 'Khối 12', admissionYear: 2023, students: 0, teacher: '', status: 'Đã tốt nghiệp' },
  ],
  assignments: [
    { id: 'math-a', classId: 'class-a', name: 'Cô An', subject: 'Toán', phone: '' },
    { id: 'literature-b', classId: 'class-b', name: 'Cô Bình', subject: 'Ngữ văn', phone: '' },
    { id: 'math-c', classId: 'class-c', name: 'Cô Hưu', subject: '  Toán  ', phone: '', status: 'Đã nghỉ hưu' },
    { id: 'math-archive', classId: 'archive', name: 'Cô Cũ', subject: 'Toán', phone: '' },
  ],
  studentProfiles: [], schedule: [], honors: [],
  teacherStatuses: { 'cô hưu': 'Đã nghỉ hưu' }, teacherEmails: {},
});

async function run() {
  const server = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const auth = await prepareAuthenticatedPage(page, server.origin);
      await auth.resetWorkspace();
      const current = fixture(), prior = fixture();
      prior.classes = prior.classes.filter(item => item.id !== 'archive').map(item => ({ ...item, name: item.name.replace(/^11/, '10'), grade: 'Khối 10' }));
      prior.assignments = [{ id: 'old-math-b', classId: 'class-b', name: 'Thầy Năm Trước', subject: 'Toán' }];
      await page.evaluate(({ current, prior, year }) => {
        localStorage.setItem('thpt-an-binh-school-years-v1', JSON.stringify({ current: year, years: { [year]: current, '2026-2027': prior }, teachers: [] }));
        localStorage.setItem('thpt-an-binh-data-v1', JSON.stringify(current));
      }, { current, prior, year: CURRENT });
      await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' });
      if (viewport.width < 500) await page.locator('#mobileMenu').click();
      await page.locator('.nav-btn[data-page="teachers"]').click();
      const open = async id => {
        await page.locator(id ? '[data-action="edit-assignment"][data-id="' + id + '"]' : '[data-action="add-assignment"]').click();
        await page.locator('form[data-form="assignment"]').waitFor();
        if (!id) await page.locator('#f-phone').fill('0900000000');
      };
      const close = () => page.locator('.modal-close').click();
      const chooseSubject = async value => {
        await page.locator('#f-subject').fill(value);
        await page.locator('[data-autocomplete-option][data-value="' + value + '"]').click();
      };
      const classIds = () => page.locator('#f-classId option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
      const assignments = () => page.evaluate(() => JSON.parse(JSON.stringify(data.assignments)));

      // The chosen subject controls available classes, independently of the teacher name.
      await open();
      assert.equal(await page.locator('#f-classId').isDisabled(), true);
      assert.deepEqual(await classIds(), []);
      assert.match(await page.locator('#assignmentClassHelp').textContent(), /Chọn môn học/);
      await page.locator('#f-name').fill('Thầy Mới');
      await chooseSubject('Toán');
      assert.equal(await page.locator('#f-classId').isDisabled(), false);
      assert.deepEqual(await classIds(), ['class-b'], 'Both active and retired existing assignments reserve their class/subject; previous-year assignments do not');
      if (process.env.ASSIGNMENT_TEST_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.ASSIGNMENT_TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ASSIGNMENT_TEST_ARTIFACT_DIR, `assignment-availability-${viewport.width}.png`), fullPage: true });
      }
      await page.locator('#f-classId').selectOption('class-b');
      await chooseSubject('Ngữ văn');
      assert.deepEqual(await classIds(), ['class-a', 'class-c'], 'Different subjects can be assigned to the same class');
      assert.equal(await page.locator('#f-classId').inputValue(), '', 'A now-occupied selection is cleared after the subject changes');
      await page.locator('#f-subject').fill('Vật');
      assert.equal(await page.locator('#f-classId').isDisabled(), true, 'An unconfirmed subject must not retain a selectable class');
      assert.deepEqual(await classIds(), []);
      await close();

      // Editing excludes the current record, preserving a teacher's own valid class.
      await open('math-a');
      assert.deepEqual(await classIds(), ['class-a', 'class-b']);
      assert.equal(await page.locator('#f-classId').inputValue(), 'class-a');
      await page.locator('#f-name').fill('Cô Thay Thế');
      await page.locator('#f-phone').fill('0901234567');
      await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
      assert.equal(await page.locator('form[data-form="assignment"]').count(), 0);
      assert.equal((await assignments()).find(item => item.id === 'math-a').phone, '0901234567');
      assert.equal((await assignments()).find(item => item.id === 'math-a').name, 'Cô Thay Thế', 'Replacing the teacher of the existing assignment keeps that record and class');

      // Revalidation catches DOM tampering and normalized subject casing/spacing.
      await open(); await page.locator('#f-name').fill('Giáo viên khác'); await chooseSubject('Toán');
      const before = await assignments();
      await page.evaluate(() => {
        const select = document.querySelector('#f-classId');
        select.add(new Option('Lớp đã có giáo viên', 'class-a'));
        select.disabled = false; select.value = 'class-a';
        document.querySelector('#f-subject').value = '  tOÁn   ';
      });
      await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
      assert.equal(await page.locator('form[data-form="assignment"]').count(), 1);
      assert.equal(await page.locator('#formError').isVisible(), true);
      assert.match(await page.locator('#formError').textContent(), /đã|trùng/);
      assert.deepEqual(await assignments(), before, 'Rejected duplicate must not change the saved roster');
      await close();

      // Save the final free class, then offer an explanatory empty state.
      await open(); await page.locator('#f-name').fill('Thầy Mới'); await chooseSubject('Toán');
      await page.locator('#f-classId').selectOption('class-b');
      await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
      assert.equal(await page.locator('form[data-form="assignment"]').count(), 0);
      assert.equal((await assignments()).filter(item => item.classId === 'class-b' && item.subject === 'Toán').length, 1);
      await open(); await chooseSubject('Toán');
      assert.deepEqual(await classIds(), []);
      assert.equal(await page.locator('#f-classId').isDisabled(), true);
      assert.match(await page.locator('#assignmentClassHelp').textContent(), /đã.*phân công|không còn|Không còn/);
      await chooseSubject('Vật lý');
      assert.deepEqual(await classIds(), ['class-a', 'class-b', 'class-c'], 'Archived classes never appear, even for an unassigned subject');
      await close();

      // Removing an old assignment releases its class for the same subject.
      page.once('dialog', dialog => dialog.accept());
      await page.locator('[data-action="delete-assignment"][data-id="math-a"]').click();
      await open(); await chooseSubject('Toán');
      assert.deepEqual(await classIds(), ['class-a']);
      await close();
      assert.deepEqual(pageErrors, []);
      console.log(`PASS ${viewport.width}px: subject/class availability, existing edits, stale selections, normalized duplicate rejection, years/status/archive scope, empty state, and assignment removal.`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
