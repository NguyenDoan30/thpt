/* Connect the existing school UI to an account-scoped cloud workspace. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let controller = null, preparedUser = null, preparing = null, decisionCancel = null;

  function normalize(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.years || Array.isArray(snapshot.years) || typeof snapshot.years !== 'object' || !Array.isArray(snapshot.teachers) || !snapshot.school) throw new Error('Bản dữ liệu trường học không hợp lệ. Dữ liệu hiện tại vẫn được giữ lại.');
    const entries = Object.entries(snapshot.years);
    if (!entries.length || entries.some(([year, record]) => !/^\d{4}-\d{4}$/.test(year) || !validAcademicYearData(record))) throw new Error('Bản dữ liệu năm học không hợp lệ.');
    const records = Object.fromEntries(entries), admissions = inferAdmissionYears(records);
    const years = Object.fromEntries(entries.map(([year, record]) => [year, normalizeAcademicYearData(record, year, admissions)]));
    const name = normalizeSchoolName(snapshot.school.name);
    const avatar = snapshot.school.avatar || null;
    if (!name || name.length > 100) throw new Error('Tên trường trong bản đồng bộ không hợp lệ.');
    if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 1048576 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(avatar) || (avatar.length - 22) % 4)) throw new Error('Ảnh đại diện trong bản đồng bộ không hợp lệ.');
    const current = Object.prototype.hasOwnProperty.call(years, snapshot.current) ? snapshot.current : Object.keys(years).sort().slice(-1)[0];
    const result = {version: 1, current, years, teachers: normalizeGlobalTeachers(snapshot.teachers, years), school: {name, avatar}};
    if (new TextEncoder().encode(JSON.stringify(result)).length > 8388608) throw new Error('Dữ liệu vượt quá dung lượng đồng bộ 8 MB. Hãy tải bản sao trước khi thu gọn dữ liệu.');
    return result;
  }
  function capture() {
    const years = clone(schoolYears); years[currentSchoolYear] = clone(data);
    return {version: 1, current: currentSchoolYear, years, teachers: clone(globalTeachers), school: {...schoolBrand}};
  }
  function defaultSnapshot() {
    const years = {[DEFAULT_YEAR]: normalizeAcademicYearData(demo, DEFAULT_YEAR)};
    return {version: 1, current: DEFAULT_YEAR, years, teachers: normalizeGlobalTeachers([], years), school: {name: 'THPT AN BÌNH', avatar: null}};
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function meaningful(snapshot) {
    const local = clone(snapshot), fresh = normalize(defaultSnapshot());
    delete local.current; delete fresh.current;
    return stable(local) !== stable(fresh);
  }
  function persistCompatibility(snapshot) {
    try { localStorage.setItem(YEARS_KEY, JSON.stringify({current: snapshot.current, years: snapshot.years, teachers: snapshot.teachers})); } catch (_) {}
    try { localStorage.setItem(KEY, JSON.stringify(snapshot.years[snapshot.current])); } catch (_) {}
    try { localStorage.setItem(SCHOOL_NAME_KEY, snapshot.school.name); } catch (_) {}
    try { if (snapshot.school.avatar) localStorage.setItem(AVATAR_KEY, snapshot.school.avatar); else localStorage.removeItem(AVATAR_KEY); } catch (_) {}
  }
  function apply(snapshot, {initial = false} = {}) {
    const next = normalize(snapshot), previousYear = currentSchoolYear;
    if (!initial && next.years[previousYear]) next.current = previousYear;
    schoolYears = clone(next.years); currentSchoolYear = next.current;
    data = normalizeAcademicYearData(schoolYears[currentSchoolYear], currentSchoolYear);
    globalTeachers = clone(next.teachers);
    displaySchoolName(next.school.name); displaySchoolAvatar(next.school.avatar);
    persistCompatibility({...next, current: currentSchoolYear});
    if (!$('#appRoot').hidden) render();
  }
  function canApply() {
    return !$('#modalRoot').children.length && !document.activeElement?.matches('#appRoot input, #appRoot select, #appRoot textarea, [contenteditable="true"]');
  }
  function download(snapshot, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function summary(snapshot) {
    const record = snapshot.years[snapshot.current] || Object.values(snapshot.years)[0];
    return '<strong>' + esc(snapshot.school.name) + '</strong><span>' + Object.keys(snapshot.years).length + ' năm học</span><span>' + esc(formatAcademicYear(snapshot.current)) + ' · ' + record.classes.length + ' lớp · ' + (record.studentProfiles || []).length + ' hồ sơ học sinh</span>';
  }
  function conflictLabel(path) {
    if (path === 'school.name') return 'Tên trường';
    if (path === 'school.avatar') return 'Ảnh đại diện';
    if (/studentProfiles/.test(path)) return 'Hồ sơ học sinh';
    if (/assignments|teachers|teacherStatuses|teacherEmails/.test(path)) return 'Giáo viên và phân công';
    if (/schedule/.test(path)) return 'Thời khóa biểu';
    if (/honors/.test(path)) return 'Thành tích học sinh';
    if (/subjects/.test(path)) return 'Danh mục môn học';
    return 'Lớp và năm học';
  }
  function choose({kind, local, remote, conflicts, signal}) {
    if (decisionCancel) decisionCancel();
    return new Promise(resolve => {
      const root = $('#syncDecisionRoot'), migration = kind === 'migration';
      const fields = [...new Set((conflicts || []).map(item => conflictLabel(item.path)))];
      root.innerHTML = '<div class="modal-backdrop sync-decision-backdrop"><section class="modal wide" id="syncDecision" role="dialog" aria-modal="true" aria-labelledby="syncDecisionTitle"><div class="modal-head"><div><h2 id="syncDecisionTitle">' + (migration ? 'Chọn dữ liệu để đồng bộ' : 'Có thay đổi từ hai thiết bị') + '</h2><p>' + (migration ? 'Thiết bị này và tài khoản đang có hai bản dữ liệu khác nhau.' : 'Cùng một thông tin đã được chỉnh sửa ở hai nơi.') + '</p></div></div><div class="modal-form"><p class="sync-decision-copy">' + (migration ? 'Chọn bản muốn dùng cho tài khoản. Bạn có thể tải cả hai bản về trước khi tiếp tục.' : ((conflicts || []).some(item => item.kind === 'class-bundle') ? 'Phần liên quan đến lớp bị xung đột sẽ dùng theo bản bạn chọn. Các thay đổi ở phần khác vẫn được gộp lại.' : 'Chỉ lựa chọn cho phần bị trùng; các thay đổi riêng của hai thiết bị vẫn được gộp lại.')) + '</p>' + (fields.length ? '<p class="sync-decision-copy">Cần xem lại: ' + fields.map(esc).join(', ') + '.</p>' : '') + '<div class="sync-choices"><div><div class="panel-sub">Trên thiết bị này</div>' + summary(local) + '<button class="btn btn-secondary btn-small" type="button" data-sync-download="local">Tải bản này</button></div><div><div class="panel-sub">Đã đồng bộ</div>' + summary(remote) + '<button class="btn btn-secondary btn-small" type="button" data-sync-download="remote">Tải bản này</button></div></div><div class="modal-foot sync-choice-actions"><button class="btn btn-secondary" type="button" data-sync-choice="cancel">Để sau</button><button class="btn btn-secondary" type="button" data-sync-choice="remote">' + (migration ? 'Dùng bản đã đồng bộ' : 'Giữ thay đổi đã đồng bộ') + '</button><button class="btn btn-primary" type="button" data-sync-choice="local">' + (migration ? 'Dùng bản trên thiết bị này' : 'Giữ thay đổi trên thiết bị') + '</button></div></div></section></div>';
      const previousFocus = document.activeElement;
      let finished = false;
      const finish = answer => {
        if (finished) return; finished = true;
        root.removeEventListener('click', click); document.removeEventListener('keydown', keydown); signal?.removeEventListener('abort', abort);
        root.replaceChildren(); decisionCancel = null;
        if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus({preventScroll: true});
        resolve(answer);
      };
      const click = event => {
        const choice = event.target.closest('[data-sync-choice]'); if (choice) finish(choice.dataset.syncChoice);
        const file = event.target.closest('[data-sync-download]'); if (file) download(file.dataset.syncDownload === 'local' ? local : remote, 'du-lieu-truong-' + file.dataset.syncDownload + '.json');
      };
      const keydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); finish('cancel'); }
        if (event.key === 'Tab') {
          const buttons = [...root.querySelectorAll('button')], first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      };
      const abort = () => finish('cancel'); decisionCancel = abort;
      root.addEventListener('click', click); document.addEventListener('keydown', keydown); signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) finish('cancel'); else root.querySelector('[data-sync-choice="cancel"]').focus();
    });
  }
  function setStatus(value) {
    const element = $('#syncStatus'), retry = $('#syncRetry');
    const labels = {loading: 'Đang tải dữ liệu…', synced: 'Đã đồng bộ', saving: 'Đang đồng bộ…', offline: 'Chờ có mạng để đồng bộ', conflict: 'Cần xem lại dữ liệu', error: 'Chưa đồng bộ được'};
    element.textContent = labels[value.state] || value.message || 'Đang kết nối đồng bộ…';
    element.title = value.message || element.textContent;
    element.dataset.state = value.state;
    retry.hidden = !['offline', 'conflict', 'error'].includes(value.state);
    const backup = $('#syncBackup');
    backup.hidden = !preparedUser || localStorage.getItem(window.SchoolCloudSync.BACKUP_KEY + ':' + preparedUser) === null;
  }
  const adapter = {capture, normalize, apply, defaultSnapshot, isMeaningfulLegacy: meaningful, canApply, choose};
  window.schoolWorkspaceAdapter = adapter;
  window.schoolWorkspaceSync = {
    async prepare(user, client) {
      if (preparedUser === user.id && controller) return preparing;
      this.disconnect();
      if (!window.SchoolCloudSync) throw new Error('Không tải được phần đồng bộ. Vui lòng tải lại trang.');
      preparedUser = user.id;
      controller = window.SchoolCloudSync.create({client, adapter, onStatus: setStatus});
      window.schoolDataSync = controller;
      const activeController = controller;
      preparing = controller.connect(user);
      try { await preparing; } catch (error) { if (controller === activeController) this.disconnect(); throw error; }
    },
    disconnect() {
      if (decisionCancel) decisionCancel();
      if (controller) controller.disconnect();
      controller = null; preparedUser = null; preparing = null; window.schoolDataSync = null;
    },
  };
  $('#syncRetry').addEventListener('click', () => { controller?.retry().catch(() => {}); });
  $('#syncBackup').addEventListener('click', () => {
    if (!preparedUser) return;
    try {
      const backup = JSON.parse(localStorage.getItem(window.SchoolCloudSync.BACKUP_KEY + ':' + preparedUser) || 'null');
      if (backup?.userId === preparedUser && backup.snapshot) download(backup.snapshot, 'ban-sao-du-lieu-truoc-dong-bo.json');
    } catch (_) {}
  });
})();
