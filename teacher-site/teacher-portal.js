/* Live school data stays in memory; demo changes are isolated to this browser. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const yearLabel = year => String(year || '').replace('-', ' – ');
  const identity = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
  const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLocaleLowerCase('vi');
  const initials = value => String(value || '').trim().split(/\s+/).filter(Boolean).slice(-2).map(part => part[0]).join('').toLocaleUpperCase('vi') || 'GV';
  const dayLabels = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  let client = null, user = null, schools = [], selectedSchool = '', portal = null;
  let generation = 0, operation = 0, view = 'schedule', loading = false, failure = '';
  let poll = null, rosterClass = '', rosterSearch = '', rosterPreviousFocus = null;
  let demoMode = false;
  const DEMO_STORAGE_KEY = 'thpt-teacher-demo-v1';
  const requests = new Set();

  function makeDemoData() {
    const classes = [
      {id:'demo-10a2',name:'10A2',grade:'Khối 10',room:'',isHomeroom:false},
      {id:'demo-12a2',name:'12A2',grade:'Khối 12',room:'',isHomeroom:false}
    ];
    const schedule = [
      {classId:'demo-12a2',day:1,period:1,subject:'Toán',room:''},
      {classId:'demo-10a2',day:2,period:2,subject:'Toán',room:''},
      {classId:'demo-12a2',day:2,period:4,subject:'Toán',room:''},
      {classId:'demo-10a2',day:3,period:3,subject:'Toán',room:''},
      {classId:'demo-12a2',day:4,period:2,subject:'Toán',room:''},
      {classId:'demo-10a2',day:5,period:1,subject:'Toán',room:''}
    ];
    const students = Array.from({length:39}, (_, index) => ({
      id:'demo-student-' + String(index + 1).padStart(2, '0'),
      classId:index < 20 ? 'demo-10a2' : 'demo-12a2',
      fullName:'Học sinh mẫu ' + String(index + 1).padStart(2, '0'),
      birthDate:(index < 20 ? '2010' : '2008') + '-' + String(index % 12 + 1).padStart(2, '0') + '-' + String(index % 27 + 1).padStart(2, '0'),
      isSample:true
    }));
    const teacher = {name:'Giáo viên mẫu',email:'giaovien.demo@example.test',phone:'0000 000 000',status:'Đang giảng dạy',subjects:['Toán']};
    const demo = {
      school:{name:'THPT Lê Quý Đôn',avatar:null}, teacher,
      years:['2026-2027','2025-2026','2024-2025'], current:'2026-2027',
      classes, schedule, studentProfiles:students,
      assignments:[...new Map(schedule.map(item => [item.classId + '|' + item.subject, {classId:item.classId,subject:item.subject,teacher:teacher.name,isHomeroom:false}])).values()]
    };
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) || 'null');
      if (saved && saved.teacher && typeof saved.teacher === 'object') Object.assign(demo.teacher, saved.teacher);
      if (Array.isArray(saved?.schedule)) demo.schedule = saved.schedule.filter(item => item && demo.classes.some(classItem => classItem.id === item.classId) && Number(item.day) >= 1 && Number(item.day) <= 6 && Number(item.period) >= 1 && Number(item.period) <= 15 && typeof item.subject === 'string').map(item => ({classId:item.classId,day:Number(item.day),period:Number(item.period),subject:item.subject,room:String(item.room || '')}));
      if (demo.years.includes(saved?.current)) demo.current = saved.current;
    } catch (error) {}
    demo.assignments = [...new Map(demo.schedule.map(item => [item.classId + '|' + item.subject, {classId:item.classId,subject:item.subject,teacher:demo.teacher.name,isHomeroom:false}])).values()];
    return demo;
  }
  function saveDemoData() {
    if (!demoMode || !portal) return false;
    try {
      localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({teacher:portal.teacher,schedule:portal.schedule,current:portal.current}));
      return true;
    } catch (error) { return false; }
  }

  function setStatus(message, error = false) {
    $('#teacherStatus').textContent = message;
    $('#teacherStatus').dataset.state = error ? 'error' : demoMode ? 'demo' : 'ready';
  }
  function cancelRequests() {
    for (const controller of requests) controller.abort();
    requests.clear();
  }
  function stillActive(at, sequence) {
    return !!user && at === generation && sequence === operation;
  }
  function stopped() { return new DOMException('Yêu cầu đã kết thúc.', 'AbortError'); }
  async function rpc(name, args, at, sequence) {
    const activeClient = client, expectedUser = user?.id;
    if (!activeClient || !expectedUser || !stillActive(at, sequence)) throw stopped();
    const session = await activeClient.auth.getSession();
    if (!stillActive(at, sequence)) throw stopped();
    if (session.error) throw session.error;
    if (session.data?.session?.user?.id !== expectedUser || !session.data.session.access_token) throw {status: 401};
    const controller = new AbortController(); requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await activeClient.rpc(name, args).setHeader('Authorization', 'Bearer ' + session.data.session.access_token).abortSignal(controller.signal);
      if (!stillActive(at, sequence)) throw stopped();
      if (result.error) throw result.error;
      return result.data;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  function messageFor(error) {
    const code = String(error?.code || '');
    if (code === 'PGRST202' || code === '42883') return 'Nhà trường chưa hoàn tất thiết lập trang giáo viên. Vui lòng liên hệ quản trị viên.';
    if (Number(error?.status) === 401 || code === 'PGRST301') return 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng xuất và đăng nhập lại.';
    if (code === '42501' || /teacher_access|not_authorized|access_denied/i.test(error?.message || '')) return 'Tài khoản chưa được cấp quyền xem trường này. Vui lòng liên hệ quản trị viên.';
    return 'Chưa tải được dữ liệu giáo viên. Kiểm tra kết nối mạng rồi thử cập nhật lại.';
  }
  function normalizePortal(value) {
    if (!value || !value.school || !value.teacher || !Array.isArray(value.years) || !Array.isArray(value.classes) || !Array.isArray(value.schedule) || !Array.isArray(value.assignments)) throw new Error('invalid_portal');
    return {...value, studentProfiles: Array.isArray(value.studentProfiles) ? value.studentProfiles : []};
  }
  function setLoading(value) {
    loading = value;
    $('#teacherRefresh').disabled = value;
    $('#teacherSchool').disabled = $('#teacherYear').disabled = value;
    $('#teacherPage').setAttribute('aria-busy', String(value));
  }
  function setBrand() {
    const name = portal?.school?.name || schools.find(school => school.owner_id === selectedSchool)?.school?.name || 'Cổng giáo viên';
    $('#schoolName').textContent = name;
    const avatar = portal?.school?.avatar || null;
    $('#schoolMark').innerHTML = avatar && /^data:image\/png;base64,/.test(avatar) ? '<img src="' + esc(avatar) + '" alt="">' : icon('school');
    const image = $('#schoolMark img');
    image?.addEventListener('error', () => { if (image.isConnected && $('#schoolMark img') === image) $('#schoolMark').innerHTML = icon('school'); }, {once:true});
    document.title = (portal?.teacher?.name ? portal.teacher.name + ' — ' : '') + name + ' | Cổng giáo viên';
    $('#teacherInitials').textContent = initials(portal?.teacher?.name);
    $('#currentAccountName').textContent = demoMode ? (portal?.teacher?.email || 'giaovien.demo@example.test') : (user?.email || '');
    $('#accountRole').textContent = demoMode ? 'Bản demo · chỉ lưu trên thiết bị' : 'Tài khoản giáo viên';
    $('#sideNoteTitle').textContent = demoMode ? 'Đang dùng dữ liệu mẫu' : 'Đồng hành cùng học sinh';
    $('#sideNoteCopy').textContent = demoMode ? 'Mọi chỉnh sửa chỉ lưu trong trình duyệt này; không gửi lên nhà trường.' : 'Lịch dạy và lớp học được cập nhật từ phân công của nhà trường.';
    $('#teacherDemoEdit').hidden = !demoMode;
    $('#teacherRefresh').title = demoMode ? 'Làm mới bản demo' : 'Cập nhật dữ liệu';
    $('#teacherRefresh').setAttribute('aria-label', demoMode ? 'Làm mới bản demo' : 'Cập nhật dữ liệu');
  }
  function updateSelectors() {
    const schoolSelect = $('#teacherSchool'), yearSelect = $('#teacherYear');
    schoolSelect.innerHTML = schools.map(school => '<option value="' + esc(school.owner_id) + '">' + esc(school.school?.name || 'Trường học') + '</option>').join('');
    schoolSelect.value = selectedSchool;
    schoolSelect.hidden = schools.length < 2;
    yearSelect.innerHTML = (portal?.years || []).map(year => '<option value="' + esc(year) + '">Năm học ' + esc(yearLabel(year)) + '</option>').join('');
    yearSelect.value = portal?.current || '';
    yearSelect.hidden = !portal;
  }
  function startPolling() {
    if (poll) clearInterval(poll);
    if (demoMode) return;
    poll = setInterval(() => { if (!document.hidden && user && !loading) refresh(); }, 30000);
  }
  async function refresh({owner = selectedSchool, year = portal?.current || null} = {}) {
    if (demoMode) { setStatus('BẢN DEMO · dữ liệu mẫu, chỉ lưu trên thiết bị này.'); return; }
    if (!user || !client || loading || $('#appRoot').hidden) return;
    const at = generation, sequence = ++operation;
    cancelRequests();
    setLoading(true); failure = '';
    setStatus('Đang cập nhật dữ liệu…');
    try {
      const rows = await rpc('list_teacher_schools', {}, at, sequence);
      if (!Array.isArray(rows)) throw new Error('invalid_schools');
      schools = rows.filter(school => typeof school.owner_id === 'string' && school.school);
      const nextOwner = schools.some(school => school.owner_id === owner) ? owner : schools[0]?.owner_id || '';
      if (nextOwner !== selectedSchool) { closeRoster(); year = null; }
      selectedSchool = nextOwner;
      if (!selectedSchool) { portal = null; closeRoster(); }
      else {
        const next = normalizePortal(await rpc('get_teacher_portal', {p_owner_id:selectedSchool, p_year:year}, at, sequence));
        if (portal?.current !== next.current) closeRoster();
        portal = next;
        if (rosterClass && !portal.classes.some(item => item.id === rosterClass)) closeRoster();
      }
      if (!stillActive(at, sequence)) return;
      updateSelectors(); setBrand(); render();
      if (rosterClass) renderRosterRows();
      setStatus(portal ? 'Đã cập nhật lúc ' + new Intl.DateTimeFormat('vi-VN', {hour:'2-digit',minute:'2-digit'}).format(new Date()) : 'Chưa có trường học được liên kết với tài khoản.');
    } catch (error) {
      if (!stillActive(at, sequence)) return;
      failure = messageFor(error); portal = null; closeRoster();
      updateSelectors(); setBrand(); render(); setStatus(failure, true);
    } finally { if (stillActive(at, sequence)) setLoading(false); }
  }
  const classById = id => portal?.classes.find(item => item.id === id);
  function classSubjects(id) { return [...new Set((portal?.assignments || []).filter(item => item.classId === id).map(item => item.subject).filter(Boolean))]; }
  function homeroom(item) { return item.isHomeroom === true || identity(item.teacher) === identity(portal?.teacher?.name); }
  const rosterFor = id => (portal?.studentProfiles || []).filter(student => student.classId === id);
  function empty(title, copy, action = '') {
    return '<section class="surface empty"><div class="empty-icon">' + icon('book') + '</div><strong>' + esc(title) + '</strong><p>' + esc(copy) + '</p>' + action + '</section>';
  }
  function stat(label, value, detail, symbol, tone = '') {
    return '<div class="stat-card"><div class="stat-top"><span class="stat-label">' + esc(label) + '</span><span class="stat-icon ' + tone + '">' + icon(symbol) + '</span></div><div class="stat-value">' + esc(value) + '</div><div class="stat-foot">' + esc(detail) + '</div></div>';
  }
  function render() {
    const labels = {schedule:'Lịch dạy',classes:'Lớp phụ trách',profile:'Hồ sơ của tôi'};
    $('#teacherBreadcrumb').textContent = labels[view];
    document.querySelectorAll('[data-teacher-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.teacherView === view);
      if (button.dataset.teacherView === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if (!portal) {
      $('#teacherPage').innerHTML = failure ? empty('Chưa tải được dữ liệu', failure, '<button class="btn btn-primary" type="button" data-teacher-retry>Thử lại</button>') : empty('Tài khoản chưa được liên kết', 'Vui lòng liên hệ quản trị viên nhà trường để liên kết email đăng nhập với hồ sơ giáo viên. Sau khi được cấp quyền, bấm cập nhật để xem lịch dạy và lớp phụ trách.', '<button class="btn btn-primary" type="button" data-teacher-retry>' + icon('refresh') + ' Cập nhật</button>');
      return;
    }
    const profile = portal.teacher;
    const days = new Intl.DateTimeFormat('vi-VN', {weekday:'long',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
    const date = new Intl.DateTimeFormat('vi-VN', {day:'2-digit',month:'long',year:'numeric',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
    const hero = '<section class="hero"><div><div class="eyebrow">Không gian dành cho thầy cô</div><h1>Xin chào, ' + esc(profile.name) + '</h1><p>Cùng theo dõi lịch dạy và đồng hành cùng học sinh mỗi ngày.</p></div><div class="hero-date">' + esc(days) + '<strong>' + esc(date) + '</strong></div></section>';
    const stats = '<div class="stats">' + stat('Lớp phụ trách', portal.classes.length, 'Theo phân công trong năm học', 'book') + stat('Hồ sơ học sinh', portal.studentProfiles.length, 'Trong các lớp được phân công', 'users', 'blue') + stat('Tiết dạy mỗi tuần', portal.schedule.length, 'Theo thời khóa biểu hiện tại', 'clock') + stat('Lớp chủ nhiệm', portal.classes.filter(homeroom).length, 'Được nhà trường phân công', 'user', 'gold') + '</div>';
    $('#teacherPage').innerHTML = hero + stats + (view === 'schedule' ? renderSchedule() : view === 'classes' ? renderClasses() : renderProfile());
  }
  function renderSchedule() {
    const head = '<div class="section-head"><div><h2>Thời khóa biểu của tôi</h2><p>Lịch của tất cả lớp được phân công trong năm học ' + esc(yearLabel(portal.current)) + '.</p></div></div>';
    const lessons = portal.schedule;
    if (!lessons.length) return head + empty('Chưa có tiết dạy', 'Nhà trường chưa xếp thời khóa biểu cho thầy cô trong năm học này.');
    const today = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(new Intl.DateTimeFormat('en-US', {weekday:'short',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date()));
    const maxPeriod = Math.max(5, ...lessons.map(item => Math.max(0, Math.min(15, Number(item.period) || 0))));
    const tones = new Map([...new Set(lessons.map(item => item.subject))].map((subject,index) => [subject, ['', 'tone-blue', 'tone-gold'][index % 3]]));
    let body = '';
    for (let period = 1; period <= maxPeriod; period++) {
      body += '<tr><th scope="row">Tiết ' + period + '</th>';
      for (let day = 1; day <= 6; day++) {
        const items = lessons.filter(item => Number(item.day) === day && Number(item.period) === period).sort((a,b) => String(classById(a.classId)?.name || '').localeCompare(String(classById(b.classId)?.name || ''), 'vi'));
        body += '<td>' + (items.length ? items.map(item => '<div class="lesson ' + tones.get(item.subject) + '"><strong>' + esc(item.subject) + '</strong><span>' + esc(classById(item.classId)?.name || 'Lớp học') + '</span>' + (item.room ? '<small>Phòng ' + esc(item.room) + '</small>' : '') + '</div>').join('') : '<div class="lesson-empty" aria-label="Không có tiết dạy">—</div>') + '</td>';
      }
      body += '</tr>';
    }
    return head + '<section class="surface"><div class="schedule-head"><strong>' + icon('calendar') + ' Lịch giảng dạy trong tuần</strong><span class="week-tag">' + lessons.length + ' tiết / tuần</span></div><div class="schedule-scroll"><table class="schedule-table" aria-label="Lịch dạy hằng tuần"><thead><tr><th scope="col">Buổi sáng</th>' + dayLabels.map((label,index) => '<th scope="col"' + (today === index + 1 ? ' class="today"' : '') + '>' + label + (today === index + 1 ? ' · Hôm nay' : '') + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div><div class="schedule-note">Lịch dạy được cập nhật từ thời khóa biểu của nhà trường. Nếu cần điều chỉnh, vui lòng liên hệ bộ phận phụ trách.</div></section>';
  }
  function renderClasses() {
    const head = '<div class="section-head"><div><h2>Lớp được phân công</h2><p>Các lớp giảng dạy và chủ nhiệm trong năm học ' + esc(yearLabel(portal.current)) + '.</p></div></div>';
    if (!portal.classes.length) return head + empty('Chưa có lớp phụ trách', 'Nhà trường chưa phân công lớp giảng dạy hoặc chủ nhiệm cho thầy cô trong năm học này.');
    return head + '<div class="class-grid">' + portal.classes.map(item => {
      const subjects = classSubjects(item.id), roster = rosterFor(item.id);
      return '<section class="surface class-card"><div class="class-card-top"><div class="class-mark">' + esc(item.name) + '</div><span class="badge ' + (homeroom(item) ? 'gold' : '') + '">' + (homeroom(item) ? 'Chủ nhiệm' : 'Giảng dạy') + '</span></div><div class="class-details"><p>' + esc(item.grade || '') + ' · <strong>' + roster.length + ' hồ sơ học sinh</strong></p><p>Môn dạy: <strong>' + esc(subjects.join(', ') || 'Chưa phân công môn') + '</strong></p>' + (item.room ? '<p>Phòng học: <strong>' + esc(item.room) + '</strong></p>' : '') + '</div><button class="btn btn-secondary" type="button" data-teacher-roster="' + esc(item.id) + '" aria-label="Xem học sinh lớp ' + esc(item.name) + '">Danh sách học sinh ' + icon('arrow') + '</button></section>';
    }).join('') + '</div>';
  }
  function renderProfile() {
    const profile = portal.teacher;
    return '<div class="section-head"><div><h2>Hồ sơ của tôi</h2><p>Thông tin do nhà trường quản lý và cập nhật.</p></div></div><section class="surface profile-panel"><div class="profile-heading"><div class="profile-avatar">' + esc(initials(profile.name)) + '</div><div><h3>' + esc(profile.name) + '</h3><span class="badge">' + esc(profile.status || 'Giáo viên') + '</span></div></div><dl class="profile-grid"><div><dt>Email hồ sơ</dt><dd>' + esc(profile.email || 'Chưa cập nhật') + '</dd></div><div><dt>Số điện thoại</dt><dd>' + esc(profile.phone || 'Chưa cập nhật') + '</dd></div><div><dt>Môn giảng dạy</dt><dd>' + esc((profile.subjects || []).join(', ') || 'Chưa cập nhật') + '</dd></div><div><dt>Lớp chủ nhiệm</dt><dd>' + esc(portal.classes.filter(homeroom).map(item => item.name).join(', ') || 'Chưa phân công') + '</dd></div><div><dt>Email đăng nhập</dt><dd>' + esc(user?.email || '') + '</dd></div><div><dt>Trường học</dt><dd>' + esc(portal.school.name) + '</dd></div></dl><div class="profile-note">Nếu thông tin cần thay đổi, vui lòng liên hệ quản trị viên nhà trường để cập nhật hồ sơ.</div></section>';
  }
  function demoLessonRow(item = {}) {
    const classOptions = portal.classes.map(classItem => '<option value="' + esc(classItem.id) + '"' + (item.classId === classItem.id ? ' selected' : '') + '>' + esc(classItem.name) + '</option>').join('');
    const dayOptions = dayLabels.map((label,index) => '<option value="' + (index + 1) + '"' + (Number(item.day) === index + 1 ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
    return '<div class="demo-lesson-row" data-demo-lesson><label><span>Lớp</span><select name="classId" required>' + classOptions + '</select></label><label><span>Ngày</span><select name="day" required>' + dayOptions + '</select></label><label><span>Tiết</span><input name="period" type="number" min="1" max="15" value="' + esc(item.period || 1) + '" required></label><label class="demo-subject-field"><span>Môn học</span><input name="subject" type="text" value="' + esc(item.subject || '') + '" maxlength="80" required></label><label class="demo-room-field"><span>Phòng</span><input name="room" type="text" value="' + esc(item.room || '') + '" maxlength="40" placeholder="Không bắt buộc"></label><button class="btn btn-secondary demo-remove-lesson" type="button" data-demo-remove-lesson aria-label="Xóa tiết demo">Xóa</button></div>';
  }
  function openDemoEditor() {
    if (!demoMode || !portal) return;
    closeRoster();
    rosterPreviousFocus = document.activeElement;
    $('#teacherRosterRoot').innerHTML = '<div class="roster-backdrop" id="teacherDemoBackdrop"><section id="teacherRosterDialog" class="roster-dialog demo-dialog" role="dialog" aria-modal="true" aria-labelledby="teacherDemoTitle"><form id="teacherDemoForm"><div class="roster-head"><div><h2 id="teacherDemoTitle">Chỉnh sửa dữ liệu demo</h2><p>Thay đổi chỉ lưu trong trình duyệt trên thiết bị này.</p></div><button class="icon-button" type="button" data-demo-cancel aria-label="Đóng chỉnh sửa">' + icon('close') + '</button></div><div class="demo-editor-scroll"><div class="demo-form-grid"><label><span>Họ và tên giáo viên</span><input name="teacherName" type="text" maxlength="100" value="' + esc(portal.teacher.name) + '" required></label><label><span>Email mẫu</span><input name="teacherEmail" type="email" maxlength="254" value="' + esc(portal.teacher.email || '') + '"></label><label><span>Số điện thoại mẫu</span><input name="teacherPhone" type="text" maxlength="30" value="' + esc(portal.teacher.phone || '') + '"></label><label><span>Môn giảng dạy</span><input name="teacherSubjects" type="text" maxlength="160" value="' + esc((portal.teacher.subjects || []).join(', ')) + '"><small>Ngăn cách nhiều môn bằng dấu phẩy.</small></label></div><div class="demo-lessons-heading"><div><h3>Thời khóa biểu mẫu</h3><p>Đổi lớp, ngày, tiết, môn hoặc thêm và xóa tiết.</p></div><button class="btn btn-secondary" type="button" data-demo-add-lesson>+ Thêm tiết</button></div><div id="demoLessonRows" class="demo-lesson-list">' + portal.schedule.map(item => demoLessonRow(item)).join('') + '</div></div><div class="demo-editor-actions"><button class="btn btn-secondary demo-reset-button" type="button" data-demo-reset>Khôi phục dữ liệu mẫu</button><div><button class="btn btn-secondary" type="button" data-demo-cancel>Hủy</button><button class="btn btn-primary" type="submit">Lưu demo</button></div></div></form></section></div>';
    $('#appRoot').setAttribute('inert', '');
    $('#teacherDemoForm [name="teacherName"]').focus();
  }
  function saveDemoEditor(form) {
    const values = new FormData(form);
    const teacherName = String(values.get('teacherName') || '').trim();
    if (!teacherName) { form.elements.teacherName.focus(); return; }
    const lessons = [...form.querySelectorAll('[data-demo-lesson]')].map(row => ({
      classId:String(row.querySelector('[name="classId"]').value),
      day:Number(row.querySelector('[name="day"]').value),
      period:Number(row.querySelector('[name="period"]').value),
      subject:String(row.querySelector('[name="subject"]').value).trim(),
      room:String(row.querySelector('[name="room"]').value).trim()
    })).filter(item => item.subject);
    portal.teacher = {...portal.teacher,name:teacherName,email:String(values.get('teacherEmail') || '').trim(),phone:String(values.get('teacherPhone') || '').trim(),subjects:String(values.get('teacherSubjects') || '').split(',').map(item => item.trim()).filter(Boolean)};
    portal.schedule = lessons;
    portal.assignments = [...new Map(lessons.map(item => [item.classId + '|' + item.subject,{classId:item.classId,subject:item.subject,teacher:teacherName,isHomeroom:false}])).values()];
    updateSelectors(); setBrand(); render();
    const saved = saveDemoData();
    closeRoster();
    setStatus(saved ? 'Đã lưu chỉnh sửa demo trên thiết bị này.' : 'Đã đổi dữ liệu trong phiên này; trình duyệt không cho phép lưu cục bộ.', !saved);
  }
  function resetDemoData() {
    if (!demoMode) return;
    try { localStorage.removeItem(DEMO_STORAGE_KEY); } catch (error) {}
    portal = makeDemoData();
    view = 'schedule';
    updateSelectors(); setBrand(); render(); closeRoster();
    setStatus('Đã khôi phục dữ liệu demo mẫu.');
  }
  function birthDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? match[3] + '/' + match[2] + '/' + match[1] : 'Chưa cập nhật';
  }
  function openRoster(id) {
    const item = classById(id); if (!item) return;
    rosterPreviousFocus = document.activeElement; rosterClass = id; rosterSearch = '';
    $('#teacherRosterRoot').innerHTML = '<div class="roster-backdrop"><section id="teacherRosterDialog" class="roster-dialog" role="dialog" aria-modal="true" aria-labelledby="teacherRosterTitle"><div class="roster-head"><div><h2 id="teacherRosterTitle">Học sinh lớp ' + esc(item.name) + '</h2><p>' + esc(yearLabel(portal.current)) + ' · ' + (homeroom(item) ? 'Lớp chủ nhiệm' : 'Lớp giảng dạy') + '</p></div><button class="icon-button" id="teacherRosterClose" type="button" aria-label="Đóng danh sách học sinh">' + icon('close') + '</button></div><div class="roster-toolbar"><label class="sr-only" for="teacherStudentSearch">Tìm học sinh theo họ tên</label><input id="teacherStudentSearch" type="search" placeholder="Tìm học sinh theo họ tên…" autocomplete="off"><span id="teacherRosterCount"></span></div><div class="roster-scroll"><table class="roster-table"><thead><tr><th scope="col">STT</th><th scope="col">Họ và tên</th><th scope="col">Ngày sinh</th></tr></thead><tbody id="teacherRosterRows"></tbody></table></div><div class="roster-footer">Danh sách được nhà trường cập nhật. Vui lòng liên hệ quản trị viên khi cần điều chỉnh.</div></section></div>';
    $('#appRoot').setAttribute('inert', '');
    renderRosterRows(); $('#teacherStudentSearch').focus();
  }
  function renderRosterRows() {
    if (!rosterClass || !$('#teacherRosterRows')) return;
    const all = rosterFor(rosterClass).slice().sort((a,b) => String(a.fullName).localeCompare(String(b.fullName), 'vi'));
    const students = all.filter(student => fold(student.fullName).includes(fold(rosterSearch)));
    $('#teacherRosterCount').textContent = students.length + ' / ' + all.length + ' học sinh';
    $('#teacherRosterRows').innerHTML = students.length ? students.map((student,index) => '<tr><td>' + (index + 1) + '</td><td>' + esc(student.fullName) + (student.isSample === true ? ' <span class="badge gold">Mẫu</span>' : '') + '</td><td>' + esc(birthDate(student.birthDate)) + '</td></tr>').join('') : '<tr><td colspan="3"><div class="empty">' + esc(rosterSearch ? 'Không tìm thấy học sinh phù hợp.' : 'Lớp chưa có hồ sơ học sinh.') + '</div></td></tr>';
  }
  function closeRoster() {
    const previous = rosterPreviousFocus;
    rosterClass = ''; rosterSearch = ''; rosterPreviousFocus = null;
    $('#teacherRosterRoot').replaceChildren();
    if (!$('#appRoot').hidden) $('#appRoot').removeAttribute('inert');
    if (previous?.isConnected && !$('#appRoot').hidden) previous.focus({preventScroll:true});
  }
  function setMenu(open) {
    $('#teacherSidebar').classList.toggle('open', open);
    $('#teacherBackdrop').hidden = !open;
    $('#teacherMenu').setAttribute('aria-expanded', String(open));
  }
  window.schoolAppAuthHooks = {
    authStorageKey: 'thpt-teacher-auth-v1',
    enterDemo() {
      cancelRequests(); ++generation; ++operation;
      demoMode = true; user = {id:'demo-user',email:'giaovien.demo@example.test'}; client = null;
      schools = [{owner_id:'demo-school',school:{name:'THPT Lê Quý Đôn'}}]; selectedSchool = 'demo-school';
      portal = makeDemoData(); failure = ''; view = 'schedule'; loading = false;
      if (poll) clearInterval(poll); poll = null;
      closeRoster(); setMenu(false);
      const screen = $('#authScreen'), app = $('#appRoot');
      screen.hidden = true; screen.setAttribute('inert', ''); screen.setAttribute('aria-hidden', 'true');
      app.hidden = false; app.removeAttribute('inert'); app.setAttribute('aria-hidden', 'false');
      updateSelectors(); setBrand(); setLoading(false); render();
      setStatus('BẢN DEMO · dữ liệu mẫu, chỉnh sửa chỉ lưu trên thiết bị này.');
    },
    async prepare(nextUser, nextClient) {
      cancelRequests(); ++generation; ++operation;
      demoMode = false; user = nextUser; client = nextClient; schools = []; selectedSchool = ''; portal = null; failure = ''; view = 'schedule';
      const at = generation, sequence = operation;
      try {
        const rows = await rpc('list_teacher_schools', {}, at, sequence);
        if (!Array.isArray(rows)) throw new Error('invalid_schools');
        schools = rows.filter(school => typeof school.owner_id === 'string' && school.school);
        selectedSchool = schools[0]?.owner_id || '';
        if (selectedSchool) portal = normalizePortal(await rpc('get_teacher_portal', {p_owner_id:selectedSchool,p_year:null}, at, sequence));
        if (!stillActive(at, sequence)) throw stopped();
      } catch (error) {
        if (!stillActive(at, sequence)) throw error;
        throw new Error(messageFor(error));
      }
    },
    unlock() {
      demoMode = false;
      updateSelectors(); setBrand(); setLoading(false); render(); startPolling();
      setStatus(portal ? 'Dữ liệu được cập nhật từ nhà trường.' : 'Chưa có trường học được liên kết với tài khoản.');
    },
    lock() {
      ++generation; ++operation; cancelRequests();
      if (poll) clearInterval(poll); poll = null;
      demoMode = false; user = null; client = null; schools = []; portal = null; selectedSchool = ''; failure = ''; loading = false;
      closeRoster(); setMenu(false); $('#teacherPage').replaceChildren();
      updateSelectors(); setBrand(); setStatus('Đang tải dữ liệu…');
    }
  };
  $('#teacherMenu').addEventListener('click', () => setMenu(!$('#teacherSidebar').classList.contains('open')));
  $('#teacherBackdrop').addEventListener('click', () => setMenu(false));
  $('#teacherRefresh').addEventListener('click', () => refresh());
  $('#teacherDemoEdit').addEventListener('click', openDemoEditor);
  $('#teacherSchool').addEventListener('change', event => { closeRoster(); refresh({owner:event.target.value,year:null}); });
  $('#teacherYear').addEventListener('change', event => {
    closeRoster();
    if (demoMode && portal) { portal.current = event.target.value; saveDemoData(); updateSelectors(); render(); setStatus('BẢN DEMO · đang xem năm học ' + yearLabel(portal.current) + '.'); return; }
    refresh({year:event.target.value});
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-demo-cancel]') || event.target.id === 'teacherDemoBackdrop') closeRoster();
    if (event.target.closest('[data-demo-add-lesson]') && demoMode) {
      const first = portal?.classes[0];
      $('#demoLessonRows')?.insertAdjacentHTML('beforeend', demoLessonRow({classId:first?.id,day:1,period:1,subject:'',room:''}));
      $('#demoLessonRows [data-demo-lesson]:last-child [name="subject"]')?.focus();
    }
    if (event.target.closest('[data-demo-remove-lesson]')) event.target.closest('[data-demo-lesson]')?.remove();
    if (event.target.closest('[data-demo-reset]')) resetDemoData();
    const navigation = event.target.closest('[data-teacher-view]');
    if (navigation && user) { view = navigation.dataset.teacherView; setMenu(false); render(); }
    const roster = event.target.closest('[data-teacher-roster]'); if (roster) openRoster(roster.dataset.teacherRoster);
    if (event.target.closest('#teacherRosterClose') || event.target.classList.contains('roster-backdrop')) closeRoster();
    if (event.target.closest('[data-teacher-retry]')) refresh();
  });
  document.addEventListener('submit', event => { if (event.target.id === 'teacherDemoForm') { event.preventDefault(); saveDemoEditor(event.target); } });
  document.addEventListener('input', event => { if (event.target.id === 'teacherStudentSearch') { rosterSearch = event.target.value; renderRosterRows(); } });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeRoster(); setMenu(false); }
    const dialog = $('#teacherRosterDialog');
    if (event.key === 'Tab' && dialog) {
      const fields = [...dialog.querySelectorAll('button,input,a[href],select')].filter(field => !field.disabled), first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('focus', () => { if (user && !loading && !document.hidden) refresh(); });
})();

