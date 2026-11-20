/* Homework uses server-scoped RPCs; demo homework stays in the existing demo store. */
'use strict';
window.createTeacherHomework = function ({ $, esc, icon, yearLabel, getContext, rpc, stillActive, saveDemoData, renderPage, onBusy }) {
  let scope = '', items = [], draft = {}, loading = false, saving = false, unavailable = false;
  let message = '', error = false, readVersion = 0;
  const contextKey = c => c.user && c.portal ? [c.user.id, c.selectedSchool, c.portal.current, c.demoMode].join('|') : '';
  const subjects = id => [...new Set((getContext().portal?.assignments || []).filter(a => a.classId === id).map(a => a.subject).filter(Boolean))];
  const classes = () => (getContext().portal?.classes || []).filter(c => subjects(c.id).length);
  const className = id => getContext().portal?.classes.find(c => c.id === id)?.name || id;
  function emptyDraft() {
    const classId = classes()[0]?.id || '';
    return { id: '', classId, subject: subjects(classId)[0] || '', title: '', instructions: '', dueDate: '', resourceUrl: '' };
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function safeUrl(value) {
    if (!value) return true;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }
  function allowed(item) {
    return item && typeof item.id === 'string' && classes().some(c => c.id === item.classId) && subjects(item.classId).includes(item.subject);
  }
  function normalize(rows) {
    if (!Array.isArray(rows)) throw new Error('invalid_homework_response');
    return rows.filter(allowed).map(item => ({
      id: item.id, year: getContext().portal.current, classId: item.classId, subject: item.subject,
      title: String(item.title || ''), instructions: String(item.instructions || ''),
      dueDate: String(item.dueDate || ''), resourceUrl: safeUrl(String(item.resourceUrl || '')) ? String(item.resourceUrl || '') : '',
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    }));
  }
  function ensureScope() {
    const c = getContext(), key = contextKey(c);
    if (key !== scope) {
      ++readVersion; scope = key; items = []; draft = emptyDraft(); loading = saving = unavailable = error = false; message = '';
      if (c.demoMode && c.portal) items = normalize((c.portal.homework || []).filter(item => item.year === c.portal.current));
    }
    if (classes().length && (!classes().some(item => item.id === draft.classId) || !subjects(draft.classId).includes(draft.subject))) draft = emptyDraft();
    items = items.filter(allowed);
  }
  function reset() {
    ++readVersion; scope = ''; items = []; draft = {}; loading = saving = unavailable = error = false; message = '';
  }
  function current(c, key) { return key === scope && key === contextKey(getContext()) && stillActive(c.generation, c.operation); }
  function errorText(problem) {
    const code = String(problem?.code || '');
    if (['PGRST202', '42883', '42P01'].includes(code)) { unavailable = true; return 'Nhà trường chưa bật chức năng lưu bài tập. Vui lòng liên hệ quản trị viên.'; }
    if (code === '42501') return 'Bạn không còn được phân công dạy lớp hoặc môn học này. Vui lòng cập nhật dữ liệu.';
    return 'Chưa lưu hoặc tải được bài tập. Kiểm tra kết nối rồi thử lại.';
  }
  async function activate() {
    ensureScope();
    const c = getContext(), key = scope;
    if (!key || saving || c.demoMode) return;
    const version = ++readVersion; loading = true; unavailable = false; renderPage();
    try {
      const rows = await rpc('list_teacher_homework', { p_owner_id: c.selectedSchool, p_year: c.portal.current }, c.generation, c.operation);
      if (!current(c, key) || version !== readVersion) return;
      items = normalize(rows); message = ''; error = false;
    } catch (problem) {
      if (!current(c, key) || version !== readVersion) return;
      items = []; message = errorText(problem); error = true;
    } finally {
      if (current(c, key) && version === readVersion) { loading = false; renderPage(); }
    }
  }
  function render() {
    ensureScope();
    const c = getContext(), available = classes();
    const heading = '<div class="section-head"><div><h2>Giao bài tập</h2><p>Soạn bài theo lớp, lưu để theo dõi và sao chép nội dung để gửi cho học sinh.</p></div></div>';
    if (!available.length) return heading + '<section class="surface empty"><strong>Chưa có lớp giảng dạy</strong><p>Nhà trường cần phân công lớp và môn học trước khi thầy cô giao bài tập.</p></section>';
    const options = (values, selected, getValue, getLabel) => values.map(value => '<option value="' + esc(getValue(value)) + '"' + (getValue(value) === selected ? ' selected' : '') + '>' + esc(getLabel(value)) + '</option>').join('');
    const list = items.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const content = loading ? '<p class="homework-empty">Đang tải bài tập…</p>' : list.length ? list.map(item => {
      const due = validDate(item.dueDate) ? item.dueDate.split('-').reverse().join('/') : 'Chưa có';
      return '<article class="homework-item"><div class="homework-item-meta"><span class="badge">Lớp ' + esc(className(item.classId)) + ' · ' + esc(item.subject) + '</span><span>Hạn nộp: ' + esc(due) + '</span></div><h3>' + esc(item.title) + '</h3><p class="homework-instructions">' + esc(item.instructions) + '</p>' + (item.resourceUrl ? '<a class="homework-resource" href="' + esc(item.resourceUrl) + '" target="_blank" rel="noopener noreferrer">Mở tài liệu bài tập</a>' : '') + '<div class="homework-item-actions"><button class="btn btn-secondary" type="button" data-homework-edit="' + esc(item.id) + '">Chỉnh sửa</button><button class="btn btn-primary" type="button" data-homework-copy="' + esc(item.id) + '">Sao chép nội dung</button></div></article>';
    }).join('') : '<p class="homework-empty">Chưa có bài tập trong năm học này. Thầy cô có thể giao bài đầu tiên bằng biểu mẫu bên cạnh.</p>';
    return heading + '<div class="homework-layout"><section class="surface homework-form-panel"><div class="homework-panel-head"><h3>' + (draft.id ? 'Chỉnh sửa bài tập' : 'Bài tập mới') + '</h3><button id="teacherHomeworkNew" class="btn btn-secondary" type="button"' + (saving ? ' disabled' : '') + '>Tạo bài mới</button></div><form id="teacherHomeworkForm"><fieldset' + (saving ? ' disabled' : '') + '><div class="homework-form-grid"><label for="teacherHomeworkClass">Lớp<select id="teacherHomeworkClass" name="classId" required>' + options(available, draft.classId, v => v.id, v => v.name) + '</select></label><label for="teacherHomeworkSubject">Môn học<select id="teacherHomeworkSubject" name="subject" required>' + options(subjects(draft.classId), draft.subject, v => v, v => v) + '</select></label></div><label for="teacherHomeworkTitle">Tên bài tập<input id="teacherHomeworkTitle" name="title" required maxlength="150" placeholder="Ví dụ: Ôn tập phương trình bậc hai" value="' + esc(draft.title) + '"></label><label for="teacherHomeworkInstructions">Nội dung và yêu cầu<textarea id="teacherHomeworkInstructions" name="instructions" required maxlength="10000" rows="6" placeholder="Bài cần làm, cách trình bày và yêu cầu nộp bài…">' + esc(draft.instructions) + '</textarea></label><label for="teacherHomeworkDue">Hạn nộp<input id="teacherHomeworkDue" name="dueDate" type="date" required value="' + esc(draft.dueDate) + '"></label><label for="teacherHomeworkResource">Liên kết tài liệu (không bắt buộc)<input id="teacherHomeworkResource" name="resourceUrl" type="url" maxlength="2000" placeholder="https://…" value="' + esc(draft.resourceUrl) + '"></label></fieldset><p id="teacherHomeworkMessage" class="homework-message" role="status" aria-live="polite" data-error="' + error + '">' + esc(message) + '</p><button id="teacherHomeworkSave" class="btn btn-primary" type="submit"' + (loading || saving || unavailable ? ' disabled' : '') + '>' + (saving ? 'Đang lưu…' : draft.id ? 'Lưu thay đổi' : 'Giao bài tập') + '</button><p class="homework-storage-note">' + (c.demoMode ? 'Bản demo: bài tập chỉ lưu trên thiết bị này.' : 'Bài tập được lưu theo tài khoản, lớp và năm học ' + esc(yearLabel(c.portal.current)) + '.') + '</p></form></section><section class="surface homework-list-panel"><div class="homework-panel-head"><h3>Bài tập đã giao <span class="homework-count">' + list.length + '</span></h3><button id="teacherHomeworkReload" class="btn btn-secondary" type="button"' + (loading || saving ? ' disabled' : '') + '>Cập nhật</button></div><div id="teacherHomeworkList">' + content + '</div></section></div>';
  }
  function input(event) {
    if (!event.target.closest('#teacherHomeworkForm') || !event.target.name) return;
    draft[event.target.name] = event.target.value;
    if (message && !error) { message = ''; const node = $('#teacherHomeworkMessage'); if (node) node.textContent = ''; }
  }
  function change(event) {
    if (event.target.id === 'teacherHomeworkClass') {
      draft.classId = event.target.value; draft.subject = subjects(draft.classId)[0] || ''; message = ''; error = false; renderPage();
    }
  }
  async function save() {
    ensureScope();
    if (saving || loading || unavailable || !scope) return;
    const form = $('#teacherHomeworkForm');
    if (!form?.reportValidity()) return;
    const c = getContext(), key = scope;
    const item = { ...draft, id: draft.id || crypto.randomUUID(), year: c.portal.current, title: String(draft.title || '').trim(), instructions: String(draft.instructions || '').trim(), resourceUrl: String(draft.resourceUrl || '').trim() };
    if (!allowed(item) || !item.title || !item.instructions || !validDate(item.dueDate) || !safeUrl(item.resourceUrl)) {
      message = 'Kiểm tra lớp, môn học, nội dung, hạn nộp và liên kết tài liệu.'; error = true; renderPage(); return;
    }
    draft = { ...item }; saving = true; message = ''; error = false; onBusy(true); renderPage();
    try {
      let saved;
      if (c.demoMode) {
        const previous = c.portal.homework || [], now = new Date().toISOString();
        saved = { ...item, createdAt: previous.find(v => v.id === item.id)?.createdAt || now, updatedAt: now };
        c.portal.homework = [...previous.filter(v => v.id !== item.id), saved];
        if (!saveDemoData()) { c.portal.homework = previous; throw new Error('demo_storage'); }
      } else {
        saved = await rpc('save_teacher_homework', { p_owner_id: c.selectedSchool, p_year: c.portal.current, p_class_id: item.classId, p_subject: item.subject, p_homework_id: item.id, p_title: item.title, p_instructions: item.instructions, p_due_date: item.dueDate, p_resource_url: item.resourceUrl }, c.generation, c.operation);
      }
      if (!current(c, key)) return;
      const normalized = normalize([saved])[0];
      if (!normalized) throw new Error('invalid_homework_response');
      items = [...items.filter(v => v.id !== item.id), normalized]; draft = { ...normalized };
      message = 'Đã lưu bài tập cho lớp ' + className(item.classId) + '. Có thể sao chép nội dung để gửi cho học sinh.';
    } catch (problem) {
      if (!current(c, key)) return;
      error = true; message = c.demoMode ? 'Trình duyệt chưa lưu được bài tập demo. Vui lòng thử lại.' : errorText(problem);
    } finally {
      if (key === scope && key === contextKey(getContext())) { saving = false; onBusy(false); renderPage(); $('#teacherHomeworkSave')?.focus({ preventScroll: true }); }
    }
  }
  async function copy(id) {
    const item = items.find(v => v.id === id); if (!item) return;
    const text = [item.title, 'Lớp: ' + className(item.classId) + ' · Môn: ' + item.subject, 'Hạn nộp: ' + item.dueDate.split('-').reverse().join('/'), '', item.instructions, item.resourceUrl ? '\nTài liệu: ' + item.resourceUrl : ''].filter((v, i) => v || i === 3).join('\n');
    const key = scope;
    try { await navigator.clipboard.writeText(text); if (key !== scope) return; message = 'Đã sao chép bài tập. Thầy cô có thể dán để gửi cho học sinh.'; error = false; }
    catch { if (key !== scope) return; message = 'Chưa sao chép được. Thầy cô có thể chọn và sao chép nội dung bài tập trong danh sách.'; error = true; }
    const node = $('#teacherHomeworkMessage'); if (node) { node.textContent = message; node.dataset.error = String(error); }
  }
  function click(event) {
    const edit = event.target.closest('[data-homework-edit]'), copyButton = event.target.closest('[data-homework-copy]');
    if (saving) return;
    if (event.target.closest('#teacherHomeworkNew')) { draft = emptyDraft(); message = ''; error = false; renderPage(); $('#teacherHomeworkTitle')?.focus(); }
    if (edit) { const item = items.find(v => v.id === edit.dataset.homeworkEdit); if (item) { draft = { ...item }; message = ''; error = false; renderPage(); $('#teacherHomeworkTitle')?.focus(); } }
    if (copyButton) copy(copyButton.dataset.homeworkCopy);
    if (event.target.closest('#teacherHomeworkReload')) { if (getContext().demoMode) { ensureScope(); renderPage(); } else activate(); }
  }
  return { render, activate, reset, input, change, click, save, busy: () => saving };
};
