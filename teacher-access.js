/* School-owner controls for linking existing login accounts to teacher profiles. */
(() => {
  'use strict';
  const hooks = window.schoolAppAuthHooks;
  if (!hooks) return;
  let client = null, userId = null, generation = 0, sessionAbort = new AbortController();
  let grants = [], busy = false, modalVersion = 0, selectedTeacher = '';
  const $ = selector => document.querySelector(selector);
  const current = token => token === generation && userId && !$('#appRoot').hidden;
  const assertCurrent = token => { if (!current(token)) throw new Error('teacher_access_cancelled'); };
  const schemaMissing = error => ['PGRST202', '42883', '42P01'].includes(error?.code);
  function message(error) {
    const value = String(error?.message || '');
    if (/teacher_account_not_found|teacher_account_unconfirmed/i.test(value)) return 'Chưa tìm thấy tài khoản đã xác nhận với email này. Hãy tạo tài khoản trong Supabase → Authentication → Users, rồi liên kết lại.';
    if (/teacher_(profile_)?not_found|teacher_not_active/i.test(value)) return 'Hồ sơ giáo viên chưa có trên máy chủ hoặc không còn giảng dạy. Kiểm tra hồ sơ và chờ “Đã đồng bộ” trước khi liên kết.';
    if (/same_account|self_grant|teacher_separate_account_required/i.test(value)) return 'Hãy dùng email tài khoản riêng của giáo viên, khác tài khoản quản lý đang đăng nhập.';
    if (/account_already_linked/i.test(value)) return 'Email này đã liên kết với giáo viên khác trong trường. Thu hồi liên kết cũ trước khi cấp cho hồ sơ này.';
    if (/email.*invalid|invalid.*email/i.test(value)) return 'Vui lòng nhập email tài khoản giáo viên hợp lệ.';
    if (/timeout/i.test(value)) return 'Kết nối quá lâu. Kiểm tra mạng rồi thử lại.';
    return 'Chưa cập nhật được quyền truy cập. Kiểm tra kết nối và tài khoản rồi thử lại.';
  }
  async function request(name, params, token) {
    assertCurrent(token);
    const activeClient = client, controller = new AbortController(), signal = sessionAbort.signal;
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, {once: true});
    let timer;
    try {
      const work = (async () => {
        const session = await activeClient.auth.getSession();
        assertCurrent(token);
        if (session.error || session.data.session?.user?.id !== userId || !session.data.session?.access_token) throw new Error('teacher_access_cancelled');
        return activeClient.rpc(name, params).setHeader('Authorization', 'Bearer ' + session.data.session.access_token).abortSignal(controller.signal);
      })();
      const result = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 20000); }), new Promise((_, reject) => { if (signal.aborted) reject(new Error('teacher_access_cancelled')); else signal.addEventListener('abort', () => reject(new Error('teacher_access_cancelled')), {once: true, signal: controller.signal}); })]);
      assertCurrent(token);
      if (result.error) throw result.error;
      return result.data;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort(); }
  }
  function projectLink(section) {
    const match = String(window.SCHOOL_AUTH_CONFIG?.supabaseUrl || '').match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i);
    return match ? 'https://supabase.com/dashboard/project/' + match[1] + '/' + section : 'https://supabase.com/dashboard';
  }
  function notice(text, success = false) {
    const node = $('#teacherAccessMessage'); if (!node) return;
    node.textContent = text; node.className = 'teacher-access-message ' + (success ? 'success' : 'error');
  }
  function setBusy(value) {
    busy = value;
    $('#teacherAccessContent')?.querySelectorAll('input,select,button[data-access-mutate]').forEach(node => { node.disabled = value; });
  }
  function profileOptions(selected) {
    return teacherDirectory().filter(person => person.status === 'Đang giảng dạy').map(person => '<option value="' + esc(person.name) + '" ' + (person.name === selected ? 'selected' : '') + '>' + esc(person.name) + '</option>').join('');
  }
  function renderContent(selected) {
    const root = $('#teacherAccessContent'); if (!root) return;
    const options = profileOptions(selected), people = teacherDirectory();
    const person = people.find(item => item.name === selected) || people.find(item => item.status === 'Đang giảng dạy');
    const grant = grants.find(item => teacherIdentityKey(item.teacher_name) === teacherIdentityKey(person?.name));
    const teacherUrl = window.schoolTeacherPortalUrl?.();
    const teacherLink = teacherUrl ? '<a href="' + esc(teacherUrl) + '" target="_blank" rel="noopener">Mở website giáo viên ↗</a>' : '<span>Chưa cấu hình địa chỉ website giáo viên.</span>';
    root.innerHTML = '<p class="teacher-access-copy">Tạo tài khoản riêng cho giáo viên trong Supabase trước, sau đó chọn đúng hồ sơ và email để cấp quyền xem lịch dạy, lớp phụ trách và danh sách học sinh. Thay đổi dữ liệu trong trang quản lý sẽ được cập nhật sang trang giáo viên.</p><div class="teacher-access-links">' + teacherLink + '<a href="' + projectLink('auth/users') + '" target="_blank" rel="noopener">Tạo tài khoản trong Supabase ↗</a></div>' + (options ? '<form id="teacherAccessForm" class="modal-form"><div class="form-grid"><div class="field"><label for="accessTeacher">Hồ sơ giáo viên</label><select id="accessTeacher" name="teacher" required>' + options + '</select></div><div class="field"><label for="accessEmail">Email đăng nhập của giáo viên</label><input id="accessEmail" name="email" type="email" maxlength="254" autocomplete="off" value="' + esc(grant?.email || person?.email || '') + '" placeholder="giaovien@truong.edu.vn" required></div></div><p class="teacher-access-help">Chỉ liên kết tài khoản của đúng giáo viên. Email này dùng để đăng nhập; thay email trong hồ sơ không tự thay quyền đã cấp.</p><div class="modal-foot"><button type="submit" class="btn btn-primary" data-access-mutate>Liên kết tài khoản</button></div></form>' : '<p class="teacher-access-message">Chưa có giáo viên đang giảng dạy. Thêm hồ sơ giáo viên trước khi cấp quyền.</p>') + '<p id="teacherAccessMessage" role="status" class="teacher-access-message"></p><h3 class="teacher-access-title">Tài khoản đã liên kết</h3><div class="teacher-access-list">' + (grants.length ? grants.map(item => '<div class="teacher-access-row"><div><strong>' + esc(item.teacher_name) + '</strong><span>' + esc(item.email) + '</span></div><button type="button" class="btn btn-danger btn-small" data-access-mutate data-access-revoke="' + esc(item.teacher_name) + '">Thu hồi quyền</button></div>').join('') : '<p class="teacher-access-copy">Chưa có tài khoản giáo viên được liên kết.</p>') + '</div>';
    setBusy(busy);
    if (!busy) root.querySelector('select,button')?.focus({preventScroll: true});
  }
  function setup() {
    const root = $('#teacherAccessContent'); if (!root) return;
    root.innerHTML = '<div class="teacher-access-setup"><h3>Cài đặt quyền truy cập giáo viên</h3><p>Cơ sở dữ liệu chưa có phần phân quyền giáo viên. Sao chép SQL cài đặt bên dưới, mở SQL Editor của dự án và bấm Run. Sau khi thấy Success, quay lại đây bấm “Kiểm tra lại”.</p><div class="teacher-access-actions"><button class="btn btn-primary" type="button" data-access-copy-sql>Sao chép SQL cài đặt</button><a class="btn btn-secondary" href="' + projectLink('sql/new') + '" target="_blank" rel="noopener">Mở SQL Editor ↗</a><button class="btn btn-secondary" type="button" data-access-reload>Kiểm tra lại</button></div><textarea id="teacherAccessSQL" aria-label="SQL cài đặt trang giáo viên" readonly hidden></textarea><p id="teacherAccessMessage" role="status" class="teacher-access-message"></p></div>';
    root.querySelector('button')?.focus({preventScroll: true});
  }
  async function load(version = modalVersion, selected = selectedTeacher) {
    const token = generation;
    const root = $('#teacherAccessContent'); if (!root) return;
    root.innerHTML = '<p class="teacher-access-loading" role="status">Đang tải tài khoản giáo viên…</p>';
    try {
      const rows = await request('list_school_teacher_access', {}, token);
      if (version !== modalVersion || !root.isConnected) return;
      if (!Array.isArray(rows)) throw new Error('Invalid teacher access response');
      grants = rows; busy = false; renderContent(selected);
    } catch (error) {
      if (!current(token) || version !== modalVersion || !root.isConnected) return;
      if (schemaMissing(error)) setup();
      else root.innerHTML = '<p class="teacher-access-message error" role="status">' + esc(message(error)) + '</p><button class="btn btn-secondary" type="button" data-access-reload>Thử lại</button>';
    }
  }
  async function mutate(name, email, enabled) {
    if (busy) return;
    const token = generation, version = modalVersion, root = $('#teacherAccessContent');
    setBusy(true); notice(enabled ? 'Đang đồng bộ hồ sơ và liên kết tài khoản…' : 'Đang thu hồi quyền truy cập…', true);
    try {
      if (enabled) {
        save(); await window.schoolDataSync.retry(); assertCurrent(token);
        if ($('#syncStatus').dataset.state !== 'synced') throw new Error('teacher_profile_not_found');
      }
      await request('manage_teacher_access', {p_teacher_name: name, p_email: email, p_enabled: enabled}, token);
      const rows = await request('list_school_teacher_access', {}, token);
      if (version !== modalVersion || !root.isConnected) return;
      if (!Array.isArray(rows)) throw new Error('Invalid teacher access response');
      grants = rows; setBusy(false); renderContent(name); notice(enabled ? 'Đã liên kết tài khoản. Giáo viên có thể đăng nhập tại trang giáo viên.' : 'Đã thu hồi quyền truy cập của tài khoản này.', true);
    } catch (error) {
      if (!current(token) || version !== modalVersion || !root.isConnected) return;
      setBusy(false); if (schemaMissing(error)) setup(); else notice(message(error));
    }
  }
  function openTeacherAccess(name) {
    if (!userId || $('#appRoot').hidden) return;
    if (name && !teacherDirectory().some(person => teacherIdentityKey(person.name) === teacherIdentityKey(name) && person.status === 'Đang giảng dạy')) { toast('Chỉ liên kết tài khoản với giáo viên đang giảng dạy.'); return; }
    ++modalVersion; busy = false; selectedTeacher = name || '';
    openModal('Tài khoản giáo viên', 'Quản lý đăng nhập riêng và quyền xem dữ liệu của từng giáo viên.', '<div id="teacherAccessContent" class="teacher-access-content"></div>', true);
    load(modalVersion, name);
  }
  window.schoolTeacherAccounts = {
    async getForTeacher(name) {
      const token = generation;
      const rows = await request('list_school_teacher_access', {}, token);
      if (!Array.isArray(rows)) throw new Error('Invalid teacher access response');
      return rows.find(item => teacherIdentityKey(item.teacher_name) === teacherIdentityKey(name)) || null;
    },
    usersUrl() { return projectLink('auth/users'); },
    open: openTeacherAccess,
  };
  document.addEventListener('click', event => {
    if (event.target.closest('[data-teacher-access-open]')) openTeacherAccess();
    if (event.target.closest('[data-access-reload]')) load();
    const revoke = event.target.closest('[data-access-revoke]');
    if (revoke) mutate(revoke.dataset.accessRevoke, '', false);
    if (event.target.closest('[data-access-copy-sql]')) {
      const token = generation, version = modalVersion;
      fetch('supabase/teacher-portal.sql', {cache: 'no-store'}).then(response => { if (!response.ok) throw new Error('download'); return response.text(); }).then(async sql => {
        if (!current(token) || version !== modalVersion || !$('#teacherAccessSQL')) return;
        const field = $('#teacherAccessSQL'); field.value = sql;
        try { await navigator.clipboard.writeText(sql); if (current(token) && field.isConnected) notice('Đã sao chép SQL. Mở SQL Editor, dán vào truy vấn mới và bấm Run.', true); }
        catch (_) { if (!current(token) || !field.isConnected) return; field.hidden = false; field.focus(); field.select(); notice('SQL đã được chọn bên dưới. Nhấn Ctrl+C hoặc chạm giữ để sao chép.', true); }
      }).catch(() => { if (current(token) && version === modalVersion) notice('Chưa tải được SQL cài đặt. Kiểm tra mạng rồi thử lại.'); });
    }
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'teacherAccessForm') return;
    event.preventDefault();
    const form = event.target; if (!form.reportValidity()) return;
    mutate(form.elements.teacher.value, form.elements.email.value.trim(), true);
  });
  document.addEventListener('change', event => {
    if (event.target.id !== 'accessTeacher') return;
    const name = event.target.value, grant = grants.find(item => teacherIdentityKey(item.teacher_name) === teacherIdentityKey(name));
    selectedTeacher = name;
    $('#accessEmail').value = grant?.email || globalTeacherProfile(name)?.email || '';
  });
  window.schoolAppAuthHooks = {
    async prepare(user, nextClient) {
      const token = ++generation; sessionAbort.abort(); sessionAbort = new AbortController();
      userId = user.id; client = nextClient;
      try { await hooks.prepare(user, nextClient); } catch (error) { if (token === generation) { userId = client = null; sessionAbort.abort(); } throw error; }
    },
    unlock(user) { hooks.unlock(user); },
    lock() { ++generation; ++modalVersion; sessionAbort.abort(); userId = client = null; grants = []; busy = false; selectedTeacher = ''; hooks.lock(); },
  };
})();
