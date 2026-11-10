const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const YEAR = '2026-2027', USER = 'semantic-test-user';
const copy = value => JSON.parse(JSON.stringify(value));
const groups = ['classes', 'studentProfiles', 'assignments', 'schedule'];
const fixture = () => ({
  version: 1, current: YEAR, teachers: [], school: { name: 'Original school', avatar: null },
  years: { [YEAR]: {
    classes: ['a', 'b', 'c'].map((id, index) => ({ id, name: `10${String.fromCharCode(65 + index)}1`, admissionYear: 2026, students: 3, room: 'Original room' })),
    studentProfiles: [], assignments: [], schedule: [],
    honors: [{ id: 'historic-award', classId: '', student: 'Archived student', className: 'Former class' }],
  } },
});
const record = state => state.years[YEAR];
const bundle = (state, classId) => Object.fromEntries(groups.map(group => [group, record(state)[group].filter(row => (group === 'classes' ? row.id : row.classId) === classId).sort((a, b) => a.id.localeCompare(b.id))]));

function runtime(storage = new Map()) {
  const context = {
    window: { addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    navigator: { onLine: true }, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'cloud-sync.js'), 'utf8'), context);
  return context.window.SchoolCloudSync;
}

async function resolveWithController(base, local, remote, choice, reason) {
  const storage = new Map([
    [`thpt-school-sync-cache-v1:${USER}`, JSON.stringify({ version: 1, base, snapshot: local, revision: 1, pending: true, updatedAt: null })],
    ['thpt-school-sync-owner-v1', USER],
  ]);
  const api = runtime(storage);
  let row = { revision: 2, payload: copy(remote), updated_at: '2026-01-01T00:00:00Z' }, applied, decisions = 0;
  const client = {
    from() { return { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: copy(row), error: null }); } }; },
    rpc(_name, body) {
      assert.equal(body.p_expected_revision, row.revision, 'A chosen merge must save against the freshly read revision');
      row = { revision: row.revision + 1, payload: copy(body.p_payload), updated_at: '2026-01-01T00:00:01Z' };
      return Promise.resolve({ data: [copy(row)], error: null });
    },
  };
  const adapter = {
    normalize: copy, capture: () => { throw new Error('An existing cache must not import legacy data'); }, defaultSnapshot: () => copy(base),
    isMeaningfulLegacy: () => false, canApply: () => true, apply: value => { applied = copy(value); },
    choose: async ({ conflicts }) => { decisions++; assert.ok(conflicts.some(item => item.kind === 'class-bundle' && item.reason === reason), `Expected ${reason} decision`); return choice; },
  };
  const controller = api.create({ client, adapter });
  try { await controller.connect({ id: USER }); assert.equal(decisions, 1); return applied; }
  finally { controller.disconnect(); }
}

async function runSemanticMergeTests() {
  const api = runtime();
  const scenarios = [
    { name: 'class deletion versus new linked records', reason: 'missing_class', edit(base, local, remote) {
      record(local).classes = record(local).classes.filter(row => row.id !== 'a');
      record(remote).studentProfiles.push({ id: 'new-student', classId: 'a', cccd: '' });
      record(remote).assignments.push({ id: 'new-assignment', classId: 'a', name: 'New teacher' });
      record(remote).schedule.push({ id: 'new-slot', classId: 'a', day: 1, period: 1 });
    }, preserved: ['studentProfiles', 'assignments', 'schedule'] },
    { name: 'reduced capacity versus added student', reason: 'roster_capacity', edit(base, local, remote) {
      for (const state of [base, local, remote]) record(state).studentProfiles.push({ id: 'existing-student', classId: 'a', cccd: '' });
      record(local).classes.find(row => row.id === 'a').students = 1;
      record(remote).studentProfiles.push({ id: 'added-student', classId: 'a', cccd: '' });
    } },
    { name: 'different slot IDs in one timetable cell', reason: 'schedule_cell', edit(base, local, remote) {
      record(local).schedule.push({ id: 'local-slot', classId: 'a', day: 1, period: 1, subject: 'Toán' });
      record(remote).schedule.push({ id: 'remote-slot', classId: 'a', day: 1, period: 1, subject: 'Văn' });
    } },
    { name: 'different teachers for one class and normalized subject', reason: 'assignment_subject', edit(base, local, remote) {
      record(local).assignments.push({ id: 'local-assignment', classId: 'a', name: 'Local teacher', subject: '  Giáo dục   thể chất ' });
      record(remote).assignments.push({ id: 'remote-assignment', classId: 'a', name: 'Remote teacher', subject: 'giáo dục thể chất' });
    } },
    { name: 'duplicate identity numbers across classes', reason: 'student_cccd', edit(base, local, remote) {
      record(local).studentProfiles.push({ id: 'local-student', classId: 'a', cccd: '012345678901' });
      record(remote).studentProfiles.push({ id: 'remote-student', classId: 'b', cccd: '012345678901' });
    } },
    { name: 'same class name and intake across IDs', reason: 'class_identity', edit(base, local, remote) {
      record(local).classes.push({ id: 'local-intake', name: '10X1', admissionYear: 2026, students: 3 });
      record(remote).classes.push({ id: 'remote-intake', name: '10x1', admissionYear: 2026, students: 3 });
    } },
  ];
  for (const scenario of scenarios) {
    const base = fixture(), local = copy(base), remote = copy(base);
    scenario.edit(base, local, remote);
    local.school.name = 'Independent school edit';
    record(remote).classes.find(row => row.id === 'c').room = 'Independent other-class edit';
    const proposal = copy(api.mergeStates(base, local, remote));
    const affected = proposal.conflicts.filter(item => item.kind === 'class-bundle');
    assert.ok(affected.some(item => item.reason === scenario.reason), `${scenario.name} must prompt before discarding records`);
    for (const group of scenario.preserved || []) assert.equal(record(proposal.snapshot)[group].length, 1, 'An unresolved class deletion must keep newly added children');
    for (const choice of ['local', 'remote']) {
      const resolved = await resolveWithController(base, local, remote, choice, scenario.reason), selected = choice === 'local' ? local : remote;
      for (const { classId } of affected) assert.deepEqual(bundle(resolved, classId), bundle(selected, classId), `${scenario.name}: ${choice} must restore the selected related class bundle`);
      assert.equal(resolved.school.name, local.school.name, 'Unrelated branding edits must remain merged');
      assert.equal(record(resolved).classes.find(row => row.id === 'c').room, record(remote).classes.find(row => row.id === 'c').room, 'Other class edits must remain merged');
      assert.deepEqual(record(resolved).honors, record(base).honors, 'Archived honors without a current class must remain intact');
      assert.equal(copy(api.mergeStates(resolved, resolved, resolved)).conflicts.length, 0, 'The explicitly chosen result must have no remaining semantic collisions');
    }
  }
  const ordinary = fixture(), local = copy(ordinary), remote = copy(ordinary);
  local.school.name = 'Local school'; record(remote).classes[2].room = 'Remote room';
  assert.equal(api.mergeStates(ordinary, local, remote).conflicts.length, 0, 'An archived honor with no current class must not create a false conflict');
  record(local).assignments.push({ id: 'local-math', classId: 'a', name: 'Math teacher', subject: 'Toán' });
  record(remote).assignments.push({ id: 'remote-physics', classId: 'a', name: 'Physics teacher', subject: 'Vật lý' }, { id: 'remote-other-class-math', classId: 'b', name: 'Other math teacher', subject: 'Toán' });
  const disjoint = copy(api.mergeStates(ordinary, local, remote));
  assert.equal(disjoint.conflicts.length, 0, 'Different subjects in one class and the same subject in different classes must still merge');
  assert.equal(record(disjoint.snapshot).assignments.length, 3);
  const legacy = fixture();
  record(legacy).assignments.push({ id: 'legacy-math-one', classId: 'a', name: 'First old teacher', subject: 'Toán' }, { id: 'legacy-math-two', classId: 'a', name: 'Second old teacher', subject: 'Toán' });
  const legacyLocal = copy(legacy), legacyRemote = copy(legacy);
  legacyLocal.school.name = 'Unrelated local edit'; record(legacyRemote).classes[2].room = 'Unrelated remote edit';
  const legacyResult = copy(api.mergeStates(legacy, legacyLocal, legacyRemote));
  assert.equal(legacyResult.conflicts.length, 0, 'Unchanged legacy assignment duplicates must not block unrelated edits');
  assert.deepEqual(record(legacyResult.snapshot).assignments, record(legacy).assignments, 'Legacy duplicates must not be rewritten or dropped');
  record(legacyRemote).assignments.push({ id: 'new-third-math', classId: 'a', name: 'New teacher', subject: 'toán' });
  assert.ok(api.mergeStates(legacy, legacyLocal, legacyRemote).conflicts.some(item => item.reason === 'assignment_subject'), 'A new assignment must not extend a legacy duplicate group silently');
  console.log('PASS: orphaned class records, roster capacity and timetable/assignment/student/class uniqueness require explicit valid bundle choices.');
}

module.exports = { runSemanticMergeTests };
if (require.main === module) runSemanticMergeTests().catch(error => { console.error(error); process.exitCode = 1; });
