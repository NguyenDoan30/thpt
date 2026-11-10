const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer, prepareAuthenticatedPage } = require('./auth-fixture.cjs');

const YEARS_KEY = 'thpt-an-binh-school-years-v1';
const DATA_KEY = 'thpt-an-binh-data-v1';
const DEFAULT_YEAR = '2026-2027';
const DEMO_COUNTS = { c12a1: 42, c12a2: 39, c11a1: 45, c11a2: 37, c10a1: 48, c10a2: 41 };
const customFixture = () => ({
  subjects: ['Toán'],
  classes: [
    { id: 'custom-intake', name: '10B1', grade: 'Khối 10', students: 3, teacher: '' },
    { id: 'zero-intake', name: '10B2', grade: 'Khối 10', students: 0, teacher: '' },
  ],
  assignments: [], schedule: [], honors: [], studentProfiles: [],
});

function assertSampleProfiles(record, expectedCounts) {
  assert.equal(record.studentProfiles.length, Object.values(expectedCounts).reduce((sum, count) => sum + count, 0));
  assert.equal(new Set(record.studentProfiles.map(profile => profile.id)).size, record.studentProfiles.length, 'Sample IDs must be unique');
  for (const [classId, count] of Object.entries(expectedCounts)) {
    const cohort = record.classes.find(item => item.id === classId);
    const profiles = record.studentProfiles.filter(profile => profile.classId === classId);
    assert.equal(profiles.length, count, `Roster must match the declared size of ${classId}`);
    profiles.forEach((profile, index) => {
      assert.equal(profile.id, `sample-${classId}-${index + 1}`, 'Sample IDs must be deterministic');
      assert.equal(profile.fullName, `Học sinh mẫu ${String(index + 1).padStart(2, '0')}`);
      assert.equal(profile.isSample, true, 'Synthetic records must be explicitly marked');
      assert.equal(profile.cccd, '', 'Synthetic records must not invent identity numbers');
      assert.match(profile.birthDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(`${profile.birthDate}T00:00:00Z`).toISOString().slice(0, 10), profile.birthDate, 'Sample birthdays must be valid calendar dates');
      assert.equal(Number(profile.birthDate.slice(0, 4)), cohort.admissionYear - 15, 'Birthday must follow the stable intake year');
    });
  }
}

async function run() {
  const server = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const auth = await prepareAuthenticatedPage(page, server.origin);

    const model = () => page.evaluate(() => ({ current: currentSchoolYear, data, years: schoolYears }));
    const storage = () => page.evaluate(({ yearsKey, dataKey }) => ({ years: localStorage.getItem(yearsKey), data: localStorage.getItem(dataKey) }), { yearsKey: YEARS_KEY, dataKey: DATA_KEY });
    const assertPersisted = async record => {
      const stored = await storage();
      assert.deepEqual(JSON.parse(stored.years).years[DEFAULT_YEAR], record, 'Normalized rosters must be persisted in the school-year schema');
      assert.deepEqual(JSON.parse(stored.data), record, 'Legacy storage copy must match the normalized active year');
    };
    const reload = async () => { await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' }); };
    const seed = async (record, schema = 'years') => {
      await auth.resetWorkspace();
      await page.evaluate(({ record, schema, yearsKey, dataKey, year }) => {
        localStorage.removeItem(yearsKey);
        localStorage.removeItem(dataKey);
        if (schema === 'years') localStorage.setItem(yearsKey, JSON.stringify({ current: year, years: { [year]: record }, teachers: [] }));
        else localStorage.setItem(dataKey, JSON.stringify(record));
      }, { record, schema, yearsKey: YEARS_KEY, dataKey: DATA_KEY, year: DEFAULT_YEAR });
      await reload();
    };
    const openRoster = async classId => {
      await page.locator('.nav-btn[data-page="classes"]').click();
      await page.locator(`.class-link[data-id="${classId}"]`).click();
      await page.locator('.student-table').waitFor({ state: 'visible' });
    };
    const createYear = async start => {
      await page.locator('#academicYearButton').click();
      await page.locator('#f-startYear').fill(String(start));
      await page.locator('#f-endYear').fill(String(start + 1));
      await page.locator('#copySchoolYear').check();
      await page.getByRole('button', { name: 'Tạo năm học', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal((await model()).current, `${start}-${start + 1}`);
    };

    // First visit populates every demo class; repeating normalization cannot duplicate it.
    const rawDemo = await page.evaluate(() => clone(demo));
    const fresh = (await model()).data;
    assertSampleProfiles(fresh, DEMO_COUNTS);
    await assertPersisted(fresh);
    await reload();
    assert.deepEqual((await model()).data, fresh, 'Fresh demo rosters must be stable across reloads');
    await page.locator('.nav-btn[data-page="classes"]').click();
    const demoLink = page.locator('.class-link[data-id="c12a1"]');
    assert.match(await demoLink.textContent(), /Xem học sinh\s*→/, 'Roster navigation must be explicit');
    assert.match(await page.locator('.class-row[data-id="c12a1"] .roster-count').textContent(), /Hồ sơ:\s*42\s*\/\s*42/, 'Class list must show the actual profile count');
    await demoLink.click();
    assert.equal(await page.locator('.student-name').count(), 42);
    assert.equal(await page.locator('.student-name .badge').filter({ hasText: /^Mẫu$/ }).count(), 42);
    assert.match(await page.locator('.roster-summary').textContent(), /42\s*\/\s*42/);
    assert.match(await page.locator('.sample-roster-note').textContent(), /hồ sơ mẫu/i, 'Roster must identify synthetic demonstration data');
    assert.match(await page.locator('.sample-roster-note').textContent(), /không phải.*(?:thật|thực)/i, 'Roster must not imply these are real student records');

    // Both earlier storage formats migrate empty demo rosters without duplicating them.
    for (const schema of ['legacy', 'years']) {
      const oldDemo = structuredClone(rawDemo);
      if (schema === 'years') oldDemo.studentProfiles = [];
      await seed(oldDemo, schema);
      assertSampleProfiles((await model()).data, DEMO_COUNTS);
      const migrated = (await model()).data;
      await assertPersisted(migrated);
      await reload();
      assert.deepEqual((await model()).data, migrated, `Reload must be idempotent after ${schema} migration`);
    }

    // A partially entered real roster is never topped up, and custom classes require an explicit request.
    const partial = structuredClone(rawDemo);
    const realProfile = { id: 'entered-student', classId: 'c10a1', fullName: 'Hồ sơ kiểm thử', birthDate: '2011-02-03', cccd: '' };
    partial.studentProfiles = [realProfile];
    partial.classes.push(...customFixture().classes);
    await seed(partial);
    let state = await model();
    assert.deepEqual(state.data.studentProfiles.filter(profile => profile.classId === 'c10a1'), [realProfile], 'Existing real profiles must remain unchanged');
    assert.equal(state.data.studentProfiles.filter(profile => profile.classId === 'custom-intake').length, 0, 'Custom classes must not be automatically populated');
    await reload();
    assert.deepEqual((await model()).data, state.data, 'Partial real rosters must stay unchanged on reload');
    await openRoster('c10a1');
    assert.equal(await page.locator('[data-action="seed-sample-students"]').count(), 0, 'Partial real rosters must not offer automatic filling');
    await page.locator('[data-action="delete-student"][data-id="entered-student"]').click();
    await page.locator('[data-action="confirm-delete-student"][data-id="entered-student"]').click();
    await reload();
    assert.equal((await model()).data.studentProfiles.filter(profile => profile.classId === 'c10a1').length, 0, 'Deleting an existing real profile must not trigger future sample migration');

    // Deleting every sample through the UI is intentional and must survive a zero-count reload.
    const smallDemo = { ...customFixture(), classes: [{ ...rawDemo.classes.find(item => item.id === 'c10a1'), students: 2 }] };
    await seed(smallDemo);
    assertSampleProfiles((await model()).data, { c10a1: 2 });
    await openRoster('c10a1');
    for (const sampleId of ['sample-c10a1-1', 'sample-c10a1-2']) {
      await page.locator(`[data-action="delete-student"][data-id="${sampleId}"]`).click();
      await page.locator(`[data-action="confirm-delete-student"][data-id="${sampleId}"]`).click();
    }
    assert.equal((await model()).data.studentProfiles.length, 0);
    await reload();
    assert.equal((await model()).data.studentProfiles.length, 0, 'Deleted demo samples must not reappear automatically');
    await openRoster('c10a1');
    assert.equal(await page.locator('.student-name').count(), 0);

    // A normal student can replace a deleted sample without inheriting its synthetic status.
    await page.locator('[data-action="add-student"]').click();
    await page.locator('#f-fullName').fill('Hồ sơ nhập thử');
    await page.locator('#f-birthDate').fill('03022011');
    await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    const entered = (await model()).data.studentProfiles;
    assert.equal(entered.length, 1);
    assert.equal(entered[0].fullName, 'Hồ sơ nhập thử');
    assert.equal(entered[0].birthDate, '2011-02-03');
    assert.equal(entered[0].cccd, '');
    assert.notEqual(entered[0].isSample, true);
    assert.equal(await page.locator('.student-name .badge').filter({ hasText: /^Mẫu$/ }).count(), 0);
    await reload();
    assert.deepEqual((await model()).data.studentProfiles, entered);

    // Manual sample creation is offered only for a truly empty class with a positive headcount.
    await seed(customFixture());
    await openRoster('zero-intake');
    assert.equal(await page.locator('[data-action="seed-sample-students"]').count(), 0);
    await openRoster('custom-intake');
    const seedButton = page.locator('[data-action="seed-sample-students"]');
    assert.equal(await seedButton.isVisible(), true);
    const beforeFailure = await model(), storedBeforeFailure = await storage();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreSampleStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('thpt-school-sync-cache-v1:')) throw new DOMException('Fixture quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await seedButton.click();
    assert.deepEqual(await model(), beforeFailure, 'Failed sample saves must roll back academic state');
    assert.deepEqual(await storage(), storedBeforeFailure, 'Failed sample saves must preserve persisted data');
    assert.equal(await seedButton.isVisible(), true);
    await page.evaluate(() => window.restoreSampleStorage());
    await seedButton.click();
    state = await model();
    assertSampleProfiles(state.data, { 'custom-intake': 3, 'zero-intake': 0 });
    assert.equal(await page.locator('.student-name').count(), 3);
    assert.equal(await page.locator('[data-action="seed-sample-students"]').count(), 0, 'Manual action must disappear after filling');
    await reload();
    assert.deepEqual((await model()).data, state.data, 'Manually generated samples must survive reload unchanged');

    // Sample students belong to their intake: promoting or graduating a class preserves every profile.
    await seed(rawDemo);
    const original = (await model()).data;
    await createYear(2027);
    state = await model();
    assert.deepEqual(state.data.studentProfiles, original.studentProfiles, 'Rollover must preserve sample IDs, birthdays, and flags');
    assert.equal(state.data.classes.find(item => item.id === 'c10a1').grade, 'Khối 11');
    assert.equal(state.data.classes.find(item => item.id === 'c12a1').status, 'Đã tốt nghiệp');
    await openRoster('c12a1');
    assert.equal(await page.locator('.student-name').count(), 42);
    assert.equal(await page.locator('.student-name .badge').filter({ hasText: /^Mẫu$/ }).count(), 42);
    assert.equal(await page.locator('.student-name .badge').filter({ hasText: /^Đã tốt nghiệp$/ }).count(), 42);
    await createYear(2029);
    state = await model();
    assert.ok(state.data.classes.every(item => item.status === 'Đã tốt nghiệp'));
    assert.deepEqual(state.data.studentProfiles, original.studentProfiles, 'Graduates must remain archived with the same sample identities');
    await reload();
    assert.deepEqual((await model()).data, state.data);
    await page.locator('#academicYearButton').click();
    await page.locator(`[data-action="select-school-year"][data-year="${DEFAULT_YEAR}"]`).click();
    assert.deepEqual((await model()).data, original, 'Rollover must preserve the original demo snapshot');

    assert.deepEqual(errors, [], 'No JavaScript exceptions expected');
    console.log('PASS: 252 labeled sample profiles, both legacy migrations, real/custom roster protection, deletion persistence, manual creation and quota rollback, normal student entry, cohort promotion and graduate archives.');
    await context.close();
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
