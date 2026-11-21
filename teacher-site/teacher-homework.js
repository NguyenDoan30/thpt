/* Homework uses server-scoped RPCs; demo homework stays in the existing demo store. */
'use strict';
window.createTeacherHomework = function ({ $, esc, icon, yearLabel, getContext, rpc, stillActive, saveDemoData, renderPage, onBusy }) {
  let scope = '', items = [], draft = {}, loading = false, saving = false, unavailable = false;
  let message = '', error = false, readVersion = 0;
  const fileManager = window.createTeacherAttachments({esc, getContext, onError: text => {message = text; error = true; renderPage();}});
  const contextKey = c => c.user && c.portal ? [c.user.id, c.selectedSchool, c.portal.current, c.demoMode].join('|') : '';
  const subjects = id => [...new Set((getContext().portal?.assignments || []).filter(a => a.classId === id).map(a => a.subject).filter(Boolean))];
  const classes = () => (getContext().portal?.classes || []).filter(c => subjects(c.id).length);
  const className = id => getContext().portal?.classes.find(c => c.id === id)?.name || id;
  function emptyDraft() {
    const classId = classes()[0]?.id || '';
    return { id: '', type: 'assignment', classId, subject: subjects(classId)[0] || '', title: '', instructions: '', dueDate: '', dueDateInput: '', resourceUrl: '', attachments: [] };
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function dateToInput(value) {
    return validDate(value) ? value.slice(8, 10) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4) : '';
  }
  function formatDateInput(value) {
    const digits = String(value || '').replace(/[^0-9]/g, '').slice(0, 8);
    if (digits.length < 2) return digits;
    if (digits.length === 2) return digits + '/';
    if (digits.length < 4) return digits.slice(0, 2) + '/' + digits.slice(2);
    if (digits.length === 4) return digits.slice(0, 2) + '/' + digits.slice(2) + '/';
    return digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4);
  }
  function dateInputCaret(value, digitCount) {
    let position = 0, digits = 0;
    while (position < value.length && digits < digitCount) {
      if (/[0-9]/.test(value[position])) digits++;
      position++;
    }
    if (digitCount === 2 && value[position] === '/') position++;
    if (digitCount === 4 && value[position] === '/') position++;
    return Math.min(position, value.length);
  }
  function dateInputToISO(value) {
    const match = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(String(value || '').trim());
    if (!match) return '';
    const iso = match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0');
    return validDate(iso) ? iso : '';
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
      id: item.id, type: item.type === 'online_test' ? 'online_test' : 'assignment', year: getContext().portal.current, classId: item.classId, subject: item.subject,
      title: String(item.title || ''), instructions: String(item.instructions || ''),
      dueDate: String(item.dueDate || ''), dueDateInput: dateToInput(String(item.dueDate || '')), resourceUrl: safeUrl(String(item.resourceUrl || '')) ? String(item.resourceUrl || '') : '',
      attachments: fileManager.normalize(item.attachments), createdAt: item.createdAt, updatedAt: item.updatedAt,
    }));
  }
  function ensureScope() {
    const c = getContext(), key = contextKey(c);
    if (key !== scope) {
      fileManager.reset();
      ++readVersion; scope = key; items = []; draft = emptyDraft(); loading = saving = unavailable = error = false; message = '';
      if (c.demoMode && c.portal) items = normalize((c.portal.homework || []).filter(item => item.year === c.portal.current));
    }
    if (classes().length && (!classes().some(item => item.id === draft.classId) || !subjects(draft.classId).includes(draft.subject))) draft = emptyDraft();
    items = items.filter(allowed);
  }
  function reset() {
    fileManager.reset();
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
    const heading = '<div class="section-head"><div><h2>Giao bài tập</h2><p>Soạn bài tập hoặc bài kiểm tra online, đính kèm tệp và gửi liên kết cho học sinh.</p></div></div>';
    if (!available.length) return heading + '<section class="surface empty"><strong>Chưa có lớp giảng dạy</strong><p>Nhà trường cần phân công lớp và môn học trước khi thầy cô giao bài tập.</p></section>';
    const options = (values, selected, getValue, getLabel) => values.map(value => '<option value="' + esc(getValue(value)) + '"' + (getValue(value) === selected ? ' selected' : '') + '>' + esc(getLabel(value)) + '</option>').join('');
    const list = items.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const content = loading ? '<p class="homework-empty">Đang tải bài tập…</p>' : list.length ? list.map(item => {
      const due = validDate(item.dueDate) ? item.dueDate.split('-').reverse().join('/') : 'Chưa có';
      return '<article class="homework-item"><div class="homework-item-meta"><span class="badge">' + (item.type === 'online_test' ? 'Bài kiểm tra online' : 'Bài tập') + ' · Lớp ' + esc(className(item.classId)) + ' · ' + esc(item.subject) + '</span><span>Hạn nộp: ' + esc(due) + '</span></div><h3>' + esc(item.title) + '</h3><p class="homework-instructions">' + esc(item.instructions) + '</p>' + (item.resourceUrl ? '<a class="homework-resource" href="' + esc(item.resourceUrl) + '" target="_blank" rel="noopener noreferrer">' + (item.type === 'online_test' ? 'Mở bài kiểm tra online' : 'Mở tài liệu bài tập') + '</a>' : '') + fileManager.render(item.attachments) + '<div class="homework-item-actions"><button class="btn btn-secondary" type="button" data-homework-edit="' + esc(item.id) + '">Chỉnh sửa</button><button class="btn btn-primary" type="button" data-homework-copy="' + esc(item.id) + '">Sao chép nội dung</button></div></article>';
    }).join('') : '<p class="homework-empty">Chưa có bài tập hoặc bài kiểm tra trong năm học này. Thầy cô có thể tạo bài đầu tiên bằng biểu mẫu bên cạnh.</p>';
    return heading + '<div class="homework-layout"><section class="surface homework-form-panel"><div class="homework-panel-head"><h3>' + (items.some(item => item.id === draft.id) ? 'Chỉnh sửa ' + (draft.type === 'online_test' ? 'bài kiểm tra online' : 'bài tập') : draft.type === 'online_test' ? 'Bài kiểm tra online mới' : 'Bài tập mới') + '</h3><button id="teacherHomeworkNew" class="btn btn-secondary" type="button"' + (saving ? ' disabled' : '') + '>Tạo bài mới</button></div><form id="teacherHomeworkForm"><fieldset' + (saving ? ' disabled' : '') + '><div class="homework-form-grid"><label for="teacherHomeworkClass">Lớp<select id="teacherHomeworkClass" name="classId" required>' + options(available, draft.classId, v => v.id, v => v.name) + '</select></label><label for="teacherHomeworkSubject">Môn học<select id="teacherHomeworkSubject" name="subject" required>' + options(subjects(draft.classId), draft.subject, v => v, v => v) + '</select></label><label class="homework-full-field" for="teacherHomeworkType">Loại bài<select id="teacherHomeworkType" name="type"><option value="assignment"' + (draft.type !== 'online_test' ? ' selected' : '') + '>Bài tập</option><option value="online_test"' + (draft.type === 'online_test' ? ' selected' : '') + '>Bài kiểm tra online</option></select></label></div><label for="teacherHomeworkTitle">' + (draft.type === 'online_test' ? 'Tên bài kiểm tra online' : 'Tên bài tập') + '<input id="teacherHomeworkTitle" name="title" required maxlength="150" placeholder="' + (draft.type === 'online_test' ? 'Ví dụ: Kiểm tra chương 1' : 'Ví dụ: Ôn tập phương trình bậc hai') + '" value="' + esc(draft.title) + '"></label><label for="teacherHomeworkInstructions">Nội dung và yêu cầu<textarea id="teacherHomeworkInstructions" name="instructions" required maxlength="10000" rows="6" placeholder="Bài cần làm, cách trình bày và yêu cầu nộp bài…">' + esc(draft.instructions) + '</textarea></label><label for="teacherHomeworkDue">Hạn nộp (ngày/tháng/năm)<input id="teacherHomeworkDue" name="dueDateInput" type="text" inputmode="numeric" autocomplete="off" maxlength="10" pattern="[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}" title="Nhập ngày/tháng/năm, ví dụ 31/03/2027" placeholder="dd/mm/yyyy" required value="' + esc(draft.dueDateInput ?? dateToInput(draft.dueDate)) + '"></label><label for="teacherHomeworkResource">' + (draft.type === 'online_test' ? 'Liên kết bài kiểm tra online (không bắt buộc)' : 'Liên kết tài liệu (không bắt buộc)') + '<input id="teacherHomeworkResource" name="resourceUrl" type="url" maxlength="2000" placeholder="' + (draft.type === 'online_test' ? 'Dán liên kết Google Forms hoặc bài kiểm tra…' : 'https://…') + '" value="' + esc(draft.resourceUrl) + '"></label><div class="homework-upload"><span class="homework-upload-label">' + (draft.type === 'online_test' ? 'Tệp và ảnh cho bài kiểm tra (không bắt buộc)' : 'Tệp và ảnh đính kèm (không bắt buộc)') + '</span><div class="homework-upload-actions"><button id="teacherHomeworkAddFiles" class="btn btn-secondary" type="button">Thêm tệp</button><button id="teacherHomeworkAddImages" class="btn btn-secondary" type="button">Thêm ảnh</button></div><input id="teacherHomeworkFiles" type="file" multiple hidden><input id="teacherHomeworkImages" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" hidden><p class="homework-file-help">' + (draft.type === 'online_test' ? 'Đính kèm đề, ảnh hoặc tài liệu tham khảo. ' : '') + 'Tối đa 5 tệp, mỗi tệp không quá 5 MB. Chọn được mọi định dạng tệp.</p><div id="teacherHomeworkAttachments" aria-live="polite">' + ((draft.attachments || []).length ? '<p class="homework-files-selected">Đã chọn ' + (draft.attachments || []).length + '/5 tệp</p>' : '<p class="homework-files-empty">Chưa có tệp nào. Tệp đã chọn sẽ hiện ở đây.</p>') + fileManager.render(draft.attachments, true) + '</div></div></fieldset><p id="teacherHomeworkMessage" class="homework-message" role="status" aria-live="polite" data-error="' + error + '">' + esc(message) + '</p><button id="teacherHomeworkSave" class="btn btn-primary" type="submit"' + (loading || saving || unavailable ? ' disabled' : '') + '>' + (saving ? 'Đang lưu…' : items.some(item => item.id === draft.id) ? 'Lưu thay đổi' : draft.type === 'online_test' ? 'Giao bài kiểm tra online' : 'Giao bài tập') + '</button><p class="homework-storage-note">' + (c.demoMode ? 'Bản demo: bài tập và bài kiểm tra chỉ lưu trên thiết bị này.' : 'Bài được lưu theo tài khoản, lớp và năm học ' + esc(yearLabel(c.portal.current)) + '.') + '</p></form></section><section class="surface homework-list-panel"><div class="homework-panel-head"><h3>Bài đã giao <span class="homework-count">' + list.length + '</span></h3><button id="teacherHomeworkReload" class="btn btn-secondary" type="button"' + (loading || saving ? ' disabled' : '') + '>Cập nhật</button></div><div id="teacherHomeworkList">' + content + '</div></section></div>';
  }
  function input(event) {
    if (!event.target.closest('#teacherHomeworkForm') || !event.target.name) return;
    if (event.target.name === 'dueDateInput') {
      const field = event.target, raw = field.value;
      const caret = Number.isInteger(field.selectionStart) ? field.selectionStart : raw.length;
      const digitsBeforeCaret = raw.slice(0, caret).replace(/[^0-9]/g, '').length;
      const formatted = formatDateInput(raw);
      field.value = formatted;
      const nextCaret = dateInputCaret(formatted, digitsBeforeCaret);
      field.setSelectionRange(nextCaret, nextCaret);
      draft.dueDateInput = formatted;
      draft.dueDate = dateInputToISO(formatted);
    } else draft[event.target.name] = event.target.value;
    if (message && !error) { message = ''; const node = $('#teacherHomeworkMessage'); if (node) node.textContent = ''; }
  }
  function change(event) {
    if (['teacherHomeworkFiles', 'teacherHomeworkImages'].includes(event.target.id)) {
      try {
        const homeworkId = draft.id || draft.uploadId || (draft.uploadId = crypto.randomUUID());
        draft.attachments = fileManager.select(event.target.files, draft.attachments || [], homeworkId, event.target.id === 'teacherHomeworkImages');
        message = ''; error = false;
      } catch (problem) { message = problem.message; error = true; }
      event.target.value = ''; renderPage(); return;
    }
    if (event.target.id === 'teacherHomeworkType') { draft.type = event.target.value === 'online_test' ? 'online_test' : 'assignment'; message = ''; error = false; renderPage(); }
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
    const item = { ...draft, type: draft.type === 'online_test' ? 'online_test' : 'assignment', id: draft.id || draft.uploadId || crypto.randomUUID(), dueDate: dateInputToISO(draft.dueDateInput || ''), attachments: fileManager.normalize(draft.attachments), year: c.portal.current, title: String(draft.title || '').trim(), instructions: String(draft.instructions || '').trim(), resourceUrl: String(draft.resourceUrl || '').trim() };
    if (!allowed(item) || !item.title || !item.instructions || !validDate(item.dueDate) || !safeUrl(item.resourceUrl)) {
      message = 'Kiểm tra lớp, môn học, nội dung, hạn nộp và liên kết tài liệu.'; error = true; renderPage(); return;
    }
    draft = { ...item }; saving = true; message = ''; error = false; onBusy(true); renderPage();
    try {
      let saved;
      const previousFiles = items.find(value => value.id === item.id)?.attachments || [];
      try { await fileManager.prepare(item.attachments); } catch (problem) { problem.homeworkFileError = true; throw problem; }
      if (c.demoMode) {
        const previous = c.portal.homework || [], now = new Date().toISOString();
        saved = { ...item, createdAt: previous.find(v => v.id === item.id)?.createdAt || now, updatedAt: now };
        c.portal.homework = [...previous.filter(v => v.id !== item.id), saved];
        if (!saveDemoData()) { c.portal.homework = previous; throw new Error('demo_storage'); }
      } else {
        saved = await rpc('save_teacher_homework', { p_owner_id: c.selectedSchool, p_year: c.portal.current, p_class_id: item.classId, p_subject: item.subject, p_homework_id: item.id, p_title: item.title, p_instructions: item.instructions, p_due_date: item.dueDate, p_resource_url: item.resourceUrl, p_attachments: item.attachments, p_type: item.type }, c.generation, c.operation);
      }
      if (!current(c, key)) return;
      const normalized = normalize([saved])[0];
      if (!normalized) throw new Error('invalid_homework_response');
      items = [...items.filter(v => v.id !== item.id), normalized]; draft = { ...normalized };
      await fileManager.commit(normalized.attachments, previousFiles);
      message = 'Đã lưu ' + (item.type === 'online_test' ? 'bài kiểm tra online' : 'bài tập') + ' cho lớp ' + className(item.classId) + '. Có thể sao chép nội dung để gửi cho học sinh.';
    } catch (problem) {
      if (!current(c, key)) return;
      error = true; message = problem.homeworkFileError && !c.demoMode ? problem.message : c.demoMode ? 'Trình duyệt chưa lưu được bài tập demo. Vui lòng thử lại.' : errorText(problem);
    } finally {
      if (key === scope && key === contextKey(getContext())) { saving = false; onBusy(false); renderPage(); $('#teacherHomeworkSave')?.focus({ preventScroll: true }); }
    }
  }
  async function copy(id) {
    const item = items.find(v => v.id === id); if (!item) return;
    const text = [item.title, 'Loại: ' + (item.type === 'online_test' ? 'Bài kiểm tra online' : 'Bài tập'), 'Lớp: ' + className(item.classId) + ' · Môn: ' + item.subject, 'Hạn nộp: ' + item.dueDate.split('-').reverse().join('/'), '', item.instructions, item.resourceUrl ? '\nTài liệu: ' + item.resourceUrl : '', (item.attachments || []).length ? '\nTệp đính kèm:\n' + item.attachments.map(file => '• ' + file.name).join('\n') : ''].filter((v, i) => v || i === 3).join('\n');
    const key = scope;
    try { await navigator.clipboard.writeText(text); if (key !== scope) return; message = 'Đã sao chép bài tập. Thầy cô có thể dán để gửi cho học sinh.'; error = false; }
    catch { if (key !== scope) return; message = 'Chưa sao chép được. Thầy cô có thể chọn và sao chép nội dung bài tập trong danh sách.'; error = true; }
    const node = $('#teacherHomeworkMessage'); if (node) { node.textContent = message; node.dataset.error = String(error); }
  }
  function click(event) {
    const edit = event.target.closest('[data-homework-edit]'), copyButton = event.target.closest('[data-homework-copy]');
    if (saving) return;
    if (event.target.closest('#teacherHomeworkAddFiles')) $('#teacherHomeworkFiles')?.click();
    if (event.target.closest('#teacherHomeworkAddImages')) $('#teacherHomeworkImages')?.click();
    const remove = event.target.closest('[data-homework-remove-file]');
    if (remove) {
      const file = (draft.attachments || []).find(value => value.id === remove.dataset.homeworkRemoveFile);
      draft.attachments = (draft.attachments || []).filter(value => value.id !== remove.dataset.homeworkRemoveFile);
      if (file) fileManager.forget(file);
      message = ''; error = false; renderPage();
    }
    const download = event.target.closest('[data-homework-download]');
    if (download) fileManager.download(download.dataset.homeworkDownload);
    if (event.target.closest('#teacherHomeworkNew')) { draft = emptyDraft(); message = ''; error = false; renderPage(); $('#teacherHomeworkTitle')?.focus(); }
    if (edit) { const item = items.find(v => v.id === edit.dataset.homeworkEdit); if (item) { draft = { ...item }; message = ''; error = false; renderPage(); $('#teacherHomeworkTitle')?.focus(); } }
    if (copyButton) copy(copyButton.dataset.homeworkCopy);
    if (event.target.closest('#teacherHomeworkReload')) { if (getContext().demoMode) { ensureScope(); renderPage(); } else activate(); }
  }
  return { render, activate, reset, input, change, click, save, hydrate: () => fileManager.hydrate($('#teacherPage')), busy: () => saving };
};
