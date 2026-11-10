const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer, prepareAuthenticatedPage } = require('./auth-fixture.cjs');

const YEARS_KEY = 'thpt-an-binh-school-years-v1';
const DATA_KEY = 'thpt-an-binh-data-v1';
const fixture = () => ({
  subjects: ['Toán'],
  classes: [
    { id: 'intake-2026', name: '10A1', grade: 'Khối 10', students: 30, teacher: 'Cô An' },
    { id: 'intake-2025', name: '11A1', grade: 'Khối 11', students: 20, teacher: 'Cô Bình' },
    { id: 'intake-2024', name: '12A1', grade: 'Khối 12', students: 10, teacher: 'Thầy Cường' },
  ],
  studentProfiles: [
    { id: 'student-2026', classId: 'intake-2026', fullName: 'Học sinh khóa 2026', birthDate: '2011-01-01', cccd: '' },
    { id: 'student-2025', classId: 'intake-2025', fullName: 'Học sinh khóa 2025', birthDate: '2010-01-01', cccd: '' },
    { id: 'student-2024', classId: 'intake-2024', fullName: 'Học sinh khóa 2024', birthDate: '2009-01-01', cccd: '' },
  ],
  assignments: [
    { id: 'teacher-2026', classId: 'intake-2026', name: 'Cô An', subject: 'Toán', phone: '' },
    { id: 'teacher-2025', classId: 'intake-2025', name: 'Cô Bình', subject: 'Toán', phone: '' },
    { id: 'teacher-2024', classId: 'intake-2024', name: 'Thầy Cường', subject: 'Toán', phone: '' },
  ],
  schedule: [{ id: 'lesson-2024', classId: 'intake-2024', day: 1, period: 1, subject: 'Toán', teacher: 'Thầy Cường' }],
  honors: [{ id: 'honor-2024', classId: 'intake-2024', student: 'Học sinh khóa 2024', subject: 'Toán', exam: 'Thi cuối kỳ', score: 9, maxScore: 10, rank: 'Học sinh giỏi' }],
});

async function run() {
  const server = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    const auth = await prepareAuthenticatedPage(page, server.origin);

    const seed = async (years, current = '2026-2027') => {
      await auth.resetWorkspace();
      await page.evaluate(({ yearsKey, dataKey, years, current }) => {
        localStorage.removeItem(yearsKey);
        localStorage.removeItem(dataKey);
        localStorage.setItem(yearsKey, JSON.stringify({ current, years, teachers: [] }));
        localStorage.setItem(dataKey, JSON.stringify(years[current]));
      }, { yearsKey: YEARS_KEY, dataKey: DATA_KEY, years, current });
      await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' });
    };
    const model = () => page.evaluate(() => ({ current: currentSchoolYear, data, years: schoolYears, teachers: globalTeachers }));
    const openYears = () => page.locator('#academicYearButton').click();
    const createYear = async (start, copy = true) => {
      await openYears();
      assert.equal(await page.locator('#f-startYear').inputValue(), '', 'Start year must be blank, not suggested');
      assert.equal(await page.locator('#f-endYear').inputValue(), '', 'End year must be blank, not suggested');
      await page.locator('#f-startYear').fill(String(start));
      await page.locator('#f-endYear').fill(String(start + 1));
      await page.locator('#copySchoolYear').setChecked(copy);
      await page.getByRole('button', { name: 'Tạo năm học', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0, `Creating school year ${start} should close the modal`);
      assert.equal((await model()).current, `${start}-${start + 1}`);
    };
    const switchYear = async year => {
      await openYears();
      await page.locator(`[data-action="select-school-year"][data-year="${year}"]`).click();
      assert.equal((await model()).current, year);
    };
    const overview = async (students, classes, byGrade) => {
      await page.locator('.nav-btn[data-page="overview"]').click();
      assert.equal(await page.locator('.stat-card').filter({ has: page.locator('.stat-label', { hasText: /^Học sinh$/ }) }).locator('.stat-value').textContent(), String(students));
      assert.equal(await page.locator('.stat-card').filter({ has: page.locator('.stat-label', { hasText: /^Tổng số lớp$/ }) }).locator('.stat-value').textContent(), String(classes));
      for (const [grade, count] of Object.entries(byGrade)) {
        const row = page.locator('.bar-row').filter({ has: page.locator('.bar-name', { hasText: `Khối ${grade}` }) });
        assert.equal(await row.locator('.bar-val').textContent(), String(count), `Wrong displayed count for grade ${grade}`);
      }
    };
    const classById = (state, id) => state.data.classes.find(record => record.id === id);

    await seed({ '2026-2027': fixture() });
    await overview(60, 3, { 10: 30, 11: 20, 12: 10 });
    const original = (await model()).data;
    assert.equal(classById(await model(), 'intake-2026').admissionYear, 2026);

    // Invalid and duplicate years must not mutate enrollment or saved snapshots.
    await openYears();
    assert.equal(await page.locator('[data-action="create-previous-year"], [data-action="create-next-year"]').count(), 0);
    const beforeDuplicate = await model();
    await page.locator('#f-startYear').fill('2026');
    await page.locator('#f-endYear').fill('2027');
    await page.getByRole('button', { name: 'Tạo năm học', exact: true }).click();
    assert.match(await page.locator('#formError').textContent(), /đã tồn tại/);
    assert.deepEqual(await model(), beforeDuplicate);
    await page.locator('#f-endYear').fill('2029');
    await page.getByRole('button', { name: 'Tạo năm học', exact: true }).click();
    assert.match(await page.locator('#formError').textContent(), /liền sau/);
    assert.deepEqual(await model(), beforeDuplicate);
    await page.locator('.modal-foot [data-action="close-modal"]').click();

    // First rollover: grade 12 graduates, grade 11 becomes 12, grade 10 becomes 11.
    await createYear(2027);
    let state = await model();
    assert.equal(classById(state, 'intake-2026').grade, 'Khối 11');
    assert.equal(classById(state, 'intake-2026').name, '11A1');
    assert.equal(classById(state, 'intake-2025').grade, 'Khối 12');
    assert.equal(classById(state, 'intake-2024').status, 'Đã tốt nghiệp');
    assert.deepEqual(state.data.studentProfiles, original.studentProfiles, 'Graduation archives profiles instead of deleting them');
    assert.ok(state.data.assignments.every(item => item.classId !== 'intake-2024'), 'Graduates must have no active copied teaching assignment');
    assert.equal(state.data.schedule.length, 0);
    assert.equal(state.data.honors.length, 0);
    await overview(50, 2, { 10: 0, 11: 30, 12: 20 });

    // New intake adds entered headcount; it must not reuse a graduated cohort's ID.
    await page.locator('.nav-btn[data-page="classes"]').click();
    await page.locator('[data-action="add-class"]').click();
    await page.locator('#f-grade').selectOption({ label: 'Khối 10' });
    await page.locator('#f-name').fill('10A1');
    await page.locator('#f-students').fill('40');
    await page.locator('#f-teacher').fill('Cô Dung');
    await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    state = await model();
    const newIntake = state.data.classes.find(record => record.name === '10A1' && record.status !== 'Đã tốt nghiệp');
    assert.ok(newIntake, 'A new grade 10 intake should be saved');
    assert.equal(newIntake.admissionYear, 2027);
    assert.notEqual(newIntake.id, 'intake-2026');
    await overview(90, 3, { 10: 40, 11: 30, 12: 20 });

    // Third year: original grade 10 cohort remains counted at grade 12.
    await createYear(2028);
    state = await model();
    assert.equal(classById(state, 'intake-2026').grade, 'Khối 12');
    assert.notEqual(classById(state, 'intake-2026').status, 'Đã tốt nghiệp');
    assert.equal(classById(state, 'intake-2025').status, 'Đã tốt nghiệp');
    assert.equal(state.data.classes.filter(record => record.name === '12A1').length, 3, '12A1 can recur in distinct active and archived cohorts');
    await overview(70, 2, { 10: 0, 11: 40, 12: 30 });

    // Fourth year: remove only from current enrollment, retain archive and profiles.
    await createYear(2029);
    state = await model();
    assert.equal(classById(state, 'intake-2026').status, 'Đã tốt nghiệp');
    assert.ok(state.data.studentProfiles.some(profile => profile.id === 'student-2026' && profile.classId === 'intake-2026'));
    assert.equal(classById(state, newIntake.id).grade, 'Khối 12');
    await overview(40, 1, { 10: 0, 11: 0, 12: 40 });

    // Alumni remain visible in their roster but cannot be scheduled or assigned teachers.
    await page.locator('.nav-btn[data-page="classes"]').click();
    await page.locator('.class-link[data-id="intake-2026"]').click();
    assert.match(await page.locator('.roster-summary').textContent(), /Đã tốt nghiệp/);
    const archivedStudent = page.locator('.student-name').filter({ hasText: 'Học sinh khóa 2026' });
    assert.equal(await archivedStudent.locator('.badge').textContent(), 'Đã tốt nghiệp');
    await page.locator('.nav-btn[data-page="schedule"]').click();
    assert.deepEqual(await page.locator('#scheduleClass option').evaluateAll(options => options.map(option => option.value)), [newIntake.id]);
    await page.locator('[data-action="add-slot-header"]').click();
    assert.deepEqual(await page.locator('#f-classId option').evaluateAll(options => options.map(option => option.value)), [newIntake.id]);
    await page.locator('.modal-foot [data-action="close-modal"]').click();
    await page.locator('.nav-btn[data-page="teachers"]').click();
    await page.locator('[data-action="add-assignment"]').click();
    await page.locator('#f-subject').fill('Toán');
    await page.locator('[data-autocomplete-option][data-value="Toán"]').click();
    assert.deepEqual(await page.locator('#f-classId option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), [newIntake.id]);
    await page.locator('.modal-foot [data-action="close-modal"]').click();

    // Updating archive metadata must not reset the intake or reactivate its students.
    await page.locator('.nav-btn[data-page="classes"]').click();
    await page.locator('[data-action="edit-class"][data-id="intake-2026"]').click();
    assert.equal(await page.locator('#f-grade').isDisabled(), true);
    await page.locator('#f-name').fill('12A2');
    await page.locator('#f-students').fill('31');
    await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    state = await model();
    assert.equal(classById(state, 'intake-2026').admissionYear, 2026);
    assert.equal(classById(state, 'intake-2026').status, 'Đã tốt nghiệp');
    assert.equal(classById(state, 'intake-2026').name, '12A2');
    assert.equal(classById(state, 'intake-2026').students, 31);
    await overview(40, 1, { 10: 0, 11: 0, 12: 40 });

    if (process.env.COHORT_TEST_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.COHORT_TEST_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.COHORT_TEST_ARTIFACT_DIR, 'cohort-fourth-year-desktop.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: path.join(process.env.COHORT_TEST_ARTIFACT_DIR, 'cohort-fourth-year-mobile.png'), animations: 'disabled', fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    const beforeReload = (await model()).data;
    await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' });
    assert.deepEqual((await model()).data, beforeReload, 'Reloading must not promote a cohort twice');
    await overview(40, 1, { 10: 0, 11: 0, 12: 40 });

    await switchYear('2026-2027');
    assert.deepEqual((await model()).data, original, 'Creating later years must preserve historical snapshots');
    await overview(60, 3, { 10: 30, 11: 20, 12: 10 });

    // Skipping school years uses the actual year delta, rather than a one-step promotion.
    await createYear(2031);
    state = await model();
    assert.ok(state.data.classes.every(record => record.status === 'Đã tốt nghiệp'));
    assert.deepEqual(state.data.studentProfiles, original.studentProfiles);
    await overview(0, 0, { 10: 0, 11: 0, 12: 0 });

    // Reusing a name from archived classes for a newly entered active cohort is valid.
    await page.locator('.nav-btn[data-page="classes"]').click();
    await page.locator('[data-action="add-class"]').click();
    await page.locator('#f-grade').selectOption({ label: 'Khối 12' });
    await page.locator('#f-name').fill('12A1');
    await page.locator('#f-students').fill('5');
    await page.locator('#f-teacher').fill('Cô Dung');
    await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'An archived name must not block a different active cohort');
    state = await model();
    const reusedName = state.data.classes.find(record => record.name === '12A1' && record.status !== 'Đã tốt nghiệp');
    assert.ok(reusedName);
    assert.equal(reusedName.admissionYear, 2029);
    assert.ok(state.data.classes.filter(record => record.name === '12A1' && record.status === 'Đã tốt nghiệp').length >= 1);
    await overview(5, 1, { 10: 0, 11: 0, 12: 5 });

    // Explicitly requesting an empty school year must not carry any cohort forward.
    await createYear(2032, false);
    state = await model();
    for (const key of ['classes', 'studentProfiles', 'assignments', 'schedule', 'honors']) assert.equal(state.data[key].length, 0);
    await overview(0, 0, { 10: 0, 11: 0, 12: 0 });

    // A cohort cannot appear in a year before it was admitted.
    await switchYear('2026-2027');
    await createYear(2023);
    state = await model();
    assert.equal(state.data.classes.length, 0);
    assert.equal(state.data.studentProfiles.length, 0);
    assert.equal(state.data.assignments.length, 0);
    await overview(0, 0, { 10: 0, 11: 0, 12: 0 });

    // Existing cloned snapshots must infer one intake date, not restart the clock.
    const cloned = fixture();
    await seed({ '2026-2027': cloned, '2027-2028': structuredClone(cloned) }, '2027-2028');
    state = await model();
    assert.equal(classById(state, 'intake-2026').admissionYear, 2026);
    assert.equal(classById(state, 'intake-2026').grade, 'Khối 11');
    assert.equal(classById(state, 'intake-2024').status, 'Đã tốt nghiệp');
    await overview(50, 2, { 10: 0, 11: 30, 12: 20 });

    // Legacy graduate schedules stay archived without reserving a teacher's time.
    assert.equal(state.data.schedule.length, 1, 'Migration preserves the historical lesson record');
    const graduatedAvailability = await page.evaluate(() => teacherWeeklyAvailability('Thầy Cường', 1, 1, ''));
    assert.deepEqual(graduatedAvailability.conflicts, [], 'An archived-only lesson must not block a current time slot');
    assert.ok(graduatedAvailability.free[0].periods.includes(1));
    const graduatedTeacherAssignments = await page.evaluate(() => teacherDirectory().find(person => person.name === 'Thầy Cường').assignments);
    assert.deepEqual(graduatedTeacherAssignments, [], 'A migrated graduate assignment must not remain current');

    // Editing an active class updates metadata without resetting its cohort clock.
    await page.locator('.nav-btn[data-page="classes"]').click();
    await page.locator('[data-action="edit-class"][data-id="intake-2026"]').click();
    assert.equal(await page.locator('#f-grade').isDisabled(), true);
    assert.equal(await page.locator('#f-grade').inputValue(), 'Khối 11');
    await page.locator('#f-name').fill('11A2');
    await page.locator('#f-students').fill('32');
    await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    state = await model();
    assert.equal(classById(state, 'intake-2026').name, '11A2');
    assert.equal(classById(state, 'intake-2026').students, 32);
    assert.equal(classById(state, 'intake-2026').grade, 'Khối 11');
    assert.equal(classById(state, 'intake-2026').admissionYear, 2026);
    assert.equal(classById(state, 'intake-2026').status, 'Đang hoạt động');
    await overview(52, 2, { 10: 0, 11: 32, 12: 20 });
    await switchYear('2026-2027');
    await overview(60, 3, { 10: 30, 11: 20, 12: 10 });
    const activeAvailability = await page.evaluate(() => teacherWeeklyAvailability('Thầy Cường', 1, 1, ''));
    assert.equal(activeAvailability.conflicts.length, 1, 'The same lesson must reserve time when its cohort is active in the historical year');

    assert.deepEqual(pageErrors, [], 'No JavaScript exceptions expected');
    console.log('PASS: cohort promotion, fourth-year graduation, new intake, archive retention, historical snapshots, skipped/backward years, reload, legacy migration, and manual-year validation.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
