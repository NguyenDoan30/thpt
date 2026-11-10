/* Teacher profile details. Login passwords remain managed by Supabase Auth. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let detailVersion = 0, accountRequest = 0;
  const yearNow = () => Number(new Intl.DateTimeFormat('en-US', {year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh'}).format(new Date()));
  const sameTeacher = (left, right) => teacherIdentityKey(left) === teacherIdentityKey(right);
  function current(root, version) {
    return version === detailVersion && root.isConnected && !$('#appRoot').hidden && root === $('#teacherDetails');
  }
  function birthYear(profile) {
    const value = Number(profile?.birthYear);
    return Number.isInteger(value) && value >= 1900 && value <= yearNow() ? value : null;
  }
  function classRows(name) {
    const classes = new Map(activeClasses().map(item => [item.id, item])), groups = new Map();
    activeAssignments().filter(item => sameTeacher(item.name, name)).forEach(item => {
      const record = classes.get(item.classId); if (!record) return;
      if (!groups.has(record.id)) groups.set(record.id, {record, subjects: []});
      const list = groups.get(record.id).subjects, subject = cleanSubject(item.subject);
      if (subject && !list.some(value => value.toLocaleLowerCase('vi') === subject.toLocaleLowerCase('vi'))) list.push(subject);
    });
    return [...groups.values()].sort((a, b) => a.record.name.localeCompare(b.record.name, 'vi')).map(({record, subjects}) => '<li><strong>' + esc(record.name) + '</strong><span>' + esc(subjects.join(', ') || 'Chưa có môn học') + '</span></li>').join('');
  }
  function accountButton(name, status) {
    return status === 'Đang giảng dạy' ? '<button class="btn btn-secondary btn-small" type="button" data-teacher-accounts-open-for="' + esc(name) + '">Liên kết / quản lý tài khoản</button>' : '';
  }
  async function loadAccount(root, name, version) {
    const request = ++accountRequest;
    const email = root.querySelector('#teacherLoginEmail'), error = root.querySelector('#teacherLoginError'), retry = root.querySelector('[data-teacher-account-retry]');
    email.textContent = 'Đang tải tài khoản…'; error.textContent = ''; retry.hidden = true;
    try {
      if (!window.schoolTeacherAccounts?.getForTeacher) throw new Error('account_unavailable');
      const grant = await window.schoolTeacherAccounts.getForTeacher(name);
      if (!current(root, version) || request !== accountRequest) return;
      if (grant && (!sameTeacher(grant.teacher_name, name) || typeof grant.email !== 'string' || !grant.email.trim())) throw new Error('invalid_account');
      email.textContent = grant && grant.enabled !== false ? grant.email : 'Chưa liên kết tài khoản';
    } catch (_) {
      if (!current(root, version) || request !== accountRequest) return;
      email.textContent = 'Chưa xác minh được tài khoản';
      error.textContent = 'Chưa tải được email đăng nhập. Kiểm tra kết nối hoặc phần thiết lập tài khoản giáo viên, rồi thử lại.';
      retry.hidden = false;
    }
  }
  function openDetails(name) {
    if ($('#appRoot').hidden) return;
    const person = teacherDirectory().find(item => sameTeacher(item.name, name));
    if (!person) { toast('Không tìm thấy hồ sơ giáo viên.'); return; }
    const version = ++detailVersion, profile = globalTeacherProfile(person.name), value = birthYear(profile);
    const contactEmail = teacherEmailOf(person), phone = teacherPhoneOf(person), status = teacherStatusOf(person);
    const assigned = classRows(person.name), homeroom = activeClasses().filter(item => sameTeacher(item.teacher, person.name)).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    const usersUrl = window.schoolTeacherAccounts?.usersUrl?.();
    const passwordLink = usersUrl && /^https:\/\/supabase\.com\//.test(usersUrl) ? '<a class="teacher-password-link" href="' + esc(usersUrl) + '" target="_blank" rel="noopener">Quản lý / đặt lại mật khẩu trong Supabase ↗</a>' : '';
    const body = '<div id="teacherDetails" class="teacher-details" data-teacher-name="' + esc(person.name) + '"><div class="teacher-details-identity"><span class="teacher-details-avatar">' + esc(initials(person.name)) + '</span><div><h3>' + esc(person.name) + '</h3><span class="badge">' + esc(status) + '</span></div></div><dl class="teacher-details-info"><div><dt>Năm sinh</dt><dd id="teacherBirthYearValue">' + (value === null ? 'Chưa cập nhật' : value) + '</dd></div><div><dt>Số điện thoại</dt><dd id="teacherContactPhone">' + esc(phone || 'Chưa cập nhật') + '</dd></div><div class="teacher-details-wide"><dt>Email liên hệ</dt><dd id="teacherContactEmail">' + esc(contactEmail || 'Chưa cập nhật') + '</dd></div></dl><form id="teacherBirthYearForm" class="teacher-birth-year-form"><div class="field"><label for="teacherBirthYear">Cập nhật năm sinh</label><input id="teacherBirthYear" name="birthYear" type="number" inputmode="numeric" min="1900" max="' + yearNow() + '" step="1" value="' + (value === null ? '' : value) + '" placeholder="Ví dụ: 1985" aria-describedby="teacherBirthYearHelp"></div><button class="btn btn-secondary" type="submit">Lưu năm sinh</button><small id="teacherBirthYearHelp">Nhập năm sinh thực tế; để trống nếu chưa có thông tin.</small><p id="teacherBirthYearStatus" role="status"></p></form><section class="teacher-details-section"><h3>Lớp được phân công</h3><p class="teacher-details-subtitle">Năm học ' + esc(formatAcademicYear(currentSchoolYear)) + '</p>' + (assigned ? '<ul id="teacherDetailsClasses" class="teacher-details-classes">' + assigned + '</ul>' : '<p id="teacherDetailsClasses" class="teacher-details-empty">Chưa được phân công lớp giảng dạy trong năm học này.</p>') + '</section><section class="teacher-details-section"><h3>Lớp chủ nhiệm</h3><div id="teacherDetailsHomeroom" class="teacher-details-homeroom">' + (homeroom.length ? homeroom.map(item => '<span class="badge gold">' + esc(item.name) + '</span>').join('') : '<span class="teacher-details-empty">Chưa được phân công chủ nhiệm trong năm học này.</span>') + '</div></section><section class="teacher-details-section teacher-details-account"><h3>Tài khoản đăng nhập giáo viên</h3><dl><div><dt>Email đăng nhập</dt><dd id="teacherLoginEmail" role="status">Đang tải tài khoản…</dd></div><div><dt>Mật khẩu</dt><dd id="teacherPasswordInfo">Không thể xem lại mật khẩu đã tạo trong Supabase. Khi cần, quản trị viên quản lý hoặc đặt lại mật khẩu tại Supabase.</dd></div></dl><p id="teacherLoginError" class="teacher-details-error" role="status"></p><div class="teacher-details-account-actions"><button class="btn btn-secondary btn-small" type="button" data-teacher-account-retry hidden>Thử tải tài khoản lại</button>' + accountButton(person.name, status) + '</div>' + passwordLink + '</section><div class="modal-foot"><button class="btn btn-secondary" type="button" data-action="close-modal">Đóng</button></div></div>';
    openModal('Hồ sơ giáo viên', 'Thông tin giáo viên, phân công và tài khoản liên kết.', body, true);
    const root = $('#teacherDetails');
    loadAccount(root, person.name, version);
  }
  function saveBirthYear(form) {
    const root = form.closest('#teacherDetails'); if (!root || !current(root, detailVersion)) return;
    const profile = globalTeacherProfile(root.dataset.teacherName), input = form.elements.birthYear, status = root.querySelector('#teacherBirthYearStatus');
    const raw = input.value.trim(), value = raw === '' ? null : Number(raw);
    if (raw !== '' && (!/^\d{4}$/.test(raw) || !Number.isInteger(value) || value < 1900 || value > yearNow())) {
      status.textContent = 'Vui lòng nhập năm sinh từ 1900 đến ' + yearNow() + '.'; status.dataset.state = 'error'; input.focus(); return;
    }
    if (!profile) { status.textContent = 'Hồ sơ giáo viên không còn tồn tại. Hãy đóng và mở lại danh sách.'; status.dataset.state = 'error'; return; }
    const hadValue = Object.prototype.hasOwnProperty.call(profile, 'birthYear'), previous = profile.birthYear;
    profile.birthYear = value;
    try { save(); }
    catch (_) {
      if (hadValue) profile.birthYear = previous; else delete profile.birthYear;
      status.textContent = 'Chưa lưu được năm sinh. Kiểm tra kết nối hoặc dung lượng lưu trữ rồi thử lại.'; status.dataset.state = 'error'; return;
    }
    root.querySelector('#teacherBirthYearValue').textContent = value === null ? 'Chưa cập nhật' : String(value);
    status.textContent = value === null ? 'Đã xóa năm sinh đã nhập.' : 'Đã lưu năm sinh.'; status.dataset.state = 'success';
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-teacher-detail]');
    if (trigger) { openDetails(trigger.dataset.teacherDetail); return; }
    const root = event.target.closest('#teacherDetails'); if (!root || !current(root, detailVersion)) return;
    if (event.target.closest('[data-teacher-account-retry]')) loadAccount(root, root.dataset.teacherName, detailVersion);
    const accounts = event.target.closest('[data-teacher-accounts-open-for]');
    if (accounts) window.schoolTeacherAccounts?.open?.(accounts.dataset.teacherAccountsOpenFor);
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'teacherBirthYearForm') return;
    event.preventDefault(); saveBirthYear(event.target);
  });
  document.addEventListener('keydown', event => {
    const root = $('#teacherDetails'); if (!root || !current(root, detailVersion)) return;
    if (event.key === 'Escape') { ++detailVersion; closeModal(); return; }
    if (event.key !== 'Tab') return;
    const modal = root.closest('.modal'), fields = [...modal.querySelectorAll('button,input,a[href],select')].filter(item => !item.disabled && !item.hidden);
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
})();
