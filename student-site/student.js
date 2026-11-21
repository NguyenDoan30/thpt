(function(){
  'use strict';
  const $ = selector => document.querySelector(selector);
  const weekdays = ['Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'];
  let client = null, session = null, schools = [], ownerId = '', portal = null;
  let selectedYear = '', activeView = 'home', demoMode = false, requestNo = 0;

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function notify(message, isError){
    const node = $('#portalNotice');
    node.textContent = message;
    node.classList.toggle('error', Boolean(isError));
    node.hidden = false;
  }
  function hideNotice(){const node=$('#portalNotice');node.hidden=true;node.textContent='';node.classList.remove('error')}
  function yearLabel(value){
    const parts=String(value||'').split('-');
    return parts.length===2 ? 'Năm học '+parts[0]+' – '+parts[1] : String(value||'');
  }
  function dateLabel(value){
    const parts=String(value||'').split('-');
    return parts.length===3 ? parts[2]+'/'+parts[1]+'/'+parts[0] : 'Chưa có hạn nộp';
  }
  function sizeLabel(value){
    const n=Number(value)||0;
    if(n<1024)return n+' B';
    if(n<1048576)return (n/1024).toFixed(n<10240?1:0)+' KB';
    return (n/1048576).toFixed(1)+' MB';
  }
  function safeHttpUrl(value){
    try{const url=new URL(String(value||''));return url.protocol==='https:'||url.protocol==='http:'?url.href:''}catch(error){return ''}
  }
  function currentSchool(){return schools.find(item=>item.owner_id===ownerId)||null}
  function showLogin(message){
    demoMode=false;portal=null;session=null;
    $('#portalApp').hidden=true;$('#loginScreen').hidden=false;
    $('#loginError').textContent=message||'';
  }
  function showWorkspace(){
    $('#loginScreen').hidden=true;$('#portalApp').hidden=false;
    $('#demoBanner').hidden=!demoMode;
  }
  function errorMessage(error){
    const code=String(error&&error.message||error&&error.code||'');
    if(code.includes('student_profile_missing_or_ambiguous'))return 'Email này đang gắn với nhiều hồ sơ hoặc hồ sơ chưa đầy đủ. Nhà trường cần kiểm tra email và lớp của bạn.';
    if(code.includes('student_year_access_denied'))return 'Bạn chưa có hồ sơ học tập trong năm học này.';
    if(code.includes('student_access_denied')||code.includes('student_profile')||code.includes('student_class'))return 'Email đăng nhập chưa được gắn với hồ sơ học sinh. Hãy liên hệ nhà trường để cập nhật email trong hồ sơ.';
    if(code.includes('confirmed_student_account_required'))return 'Tài khoản cần được xác nhận email trước khi sử dụng cổng học sinh.';
    if(code.includes('Failed to fetch')||code.includes('Network'))return 'Không kết nối được máy chủ. Kiểm tra Internet rồi thử lại.';
    return 'Chưa tải được dữ liệu. Hãy làm mới trang hoặc liên hệ nhà trường.';
  }
  async function rpc(name,args){
    if(!client||!session)throw new Error('authentication_required');
    const result=await client.rpc(name,args);
    if(result.error)throw result.error;
    return result.data;
  }
  async function loadSchools(preferredOwner){
    if(demoMode||!session)return;
    const ticket=++requestNo;
    showWorkspace();hideNotice();
    $('#studentWorkspace').hidden=true;
    $('#viewContent').innerHTML='<div class="loading">Đang tìm hồ sơ học sinh…</div>';
    try{
      const rows=await rpc('list_student_schools',{});
      if(ticket!==requestNo)return;
      schools=Array.isArray(rows)?rows.filter(row=>row&&typeof row.owner_id==='string'&&Array.isArray(row.years)): [];
      if(!schools.length){
        ownerId='';portal=null;
        $('#schoolPickerWrap').hidden=true;
        $('#schoolName').textContent='Cổng học sinh';
        notify('Tài khoản này chưa được gắn với hồ sơ học sinh. Nhà trường cần tạo tài khoản, nhập đúng email vào hồ sơ học sinh và chạy SQL cổng học sinh.',true);
        $('#viewContent').innerHTML='';
        return;
      }
      ownerId=schools.some(row=>row.owner_id===preferredOwner)?preferredOwner:schools[0].owner_id;
      const selected=currentSchool();
      selectedYear=selected.current&&selected.years.includes(selected.current)?selected.current:(selected.years[0]||'');
      $('#schoolPickerWrap').hidden=schools.length<2;
      $('#schoolSelect').innerHTML=schools.map(row=>'<option value="'+esc(row.owner_id)+'">'+esc(row.school&&row.school.name||'Trường học')+'</option>').join('');
      $('#schoolSelect').value=ownerId;
      $('#yearSelect').innerHTML=(selected.years||[]).map(year=>'<option value="'+esc(year)+'">'+esc(yearLabel(year))+'</option>').join('');
      $('#yearSelect').value=selectedYear;
      $('#schoolName').textContent=selected.school&&selected.school.name||'Cổng học sinh';
      await loadPortal(ownerId,selectedYear,ticket);
    }catch(error){
      if(ticket!==requestNo)return;
      notify(errorMessage(error),true);
      $('#viewContent').innerHTML='';
    }
  }
  async function loadPortal(owner,year,parentTicket){
    if(demoMode)return;
    const ticket=parentTicket||++requestNo;
    ownerId=owner;selectedYear=year;
    $('#studentWorkspace').hidden=true;
    $('#viewContent').innerHTML='<div class="loading">Đang tải lịch học và bài tập…</div>';
    hideNotice();
    try{
      const data=await rpc('get_student_portal',{p_owner_id:ownerId,p_year:selectedYear||null});
      if(ticket!==requestNo)return;
      if(!data||!data.student||!data.class)throw new Error('invalid_student_portal');
      portal=data;
      renderPortal();
    }catch(error){
      if(ticket!==requestNo)return;
      portal=null;
      $('#viewContent').innerHTML='';
      notify(errorMessage(error),true);
    }
  }
  function renderPortal(){
    if(!portal)return;
    showWorkspace();hideNotice();
    $('#studentWorkspace').hidden=false;
    $('#schoolName').textContent=portal.school&&portal.school.name||'Cổng học sinh';
    $('#studentName').textContent=portal.student.fullName||'bạn';
    $('#studentClass').textContent=(portal.class.name||'Lớp chưa rõ')+(portal.class.grade?' · '+portal.class.grade:'');
    $('#welcomeYear').textContent=yearLabel(portal.current||selectedYear);
    $('#yearSelect').innerHTML=(portal.years||[]).map(year=>'<option value="'+esc(year)+'">'+esc(yearLabel(year))+'</option>').join('');
    $('#yearSelect').value=portal.current||selectedYear;
    document.querySelectorAll('.nav-tab').forEach(button=>button.classList.toggle('active',button.dataset.view===activeView));
    $('#viewContent').innerHTML=renderView();
  }
  function heading(title,copy,tag){
    return '<div class="view-heading"><div><h2>'+esc(title)+'</h2><p>'+esc(copy)+'</p></div>'+(tag?'<span class="pill">'+esc(tag)+'</span>':'')+'</div>';
  }
  function lessonCount(){return Array.isArray(portal.schedule)?portal.schedule.length:0}
  function homeworkItems(type){
    return (Array.isArray(portal.homework)?portal.homework:[]).filter(item=>!type||item.type===type);
  }
  function statCard(label,value,note){
    return '<article class="stat-card"><div class="stat-label">'+esc(label)+'</div><div class="stat-value">'+esc(value)+'</div><div class="stat-note">'+esc(note)+'</div></article>';
  }
  function scheduleTable(){
    const lessons=Array.isArray(portal.schedule)?portal.schedule:[];
    let out='<div class="schedule-wrap"><table class="schedule-table"><thead><tr><th>Tiết</th>'+weekdays.map(day=>'<th>'+esc(day)+'</th>').join('')+'</tr></thead><tbody>';
    for(let period=1;period<=5;period++){
      out+='<tr><td>Tiết '+period+'</td>';
      for(let day=1;day<=6;day++){
        const item=lessons.find(entry=>Number(entry.day)===day&&Number(entry.period)===period);
        out+=item?'<td class="schedule-cell filled"><strong>'+esc(item.subject||'Tiết học')+'</strong><span>'+esc(item.teacher||'')+(item.room?' · '+esc(item.room):'')+'</span></td>':'<td class="empty-cell">—</td>';
      }
      out+='</tr>';
    }
    return out+'</tbody></table></div>';
  }
  function schedulePanel(compact){
    return '<section class="surface"><div class="surface-head"><h3>Thời khóa biểu trong tuần</h3><span class="pill">'+lessonCount()+' tiết</span></div>'+scheduleTable()+'</section>';
  }
  function attachmentMarkup(item){
    const files=Array.isArray(item.attachments)?item.attachments:[];
    if(!files.length)return '<p class="homework-meta">Chưa có tệp đính kèm.</p>';
    return '<div class="file-list">'+files.map(file=>'<button class="file-link" type="button" data-action="download" data-path="'+esc(file.path)+'" data-name="'+esc(file.name||'Tệp đính kèm')+'">↧ '+esc(file.name||'Tệp đính kèm')+' <span class="file-size">'+esc(sizeLabel(file.size))+'</span></button>').join('')+'</div>';
  }
  function homeworkCard(item){
    const isTest=item.type==='online_test',url=safeHttpUrl(item.resourceUrl);
    return '<article class="homework-card"><div class="homework-top"><div><span class="tag '+(isTest?'test':'')+'">'+(isTest?'BÀI KIỂM TRA ONLINE':'BÀI TẬP')+'</span><h3>'+esc(item.title||'Bài học')+'</h3><div class="homework-meta">'+esc(item.subject||'')+' · Hạn nộp: '+esc(dateLabel(item.dueDate))+'</div></div></div>'+(item.instructions?'<p class="homework-body">'+esc(item.instructions)+'</p>':'')+attachmentMarkup(item)+(url?'<div class="homework-actions"><a class="resource-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+(isTest?'Mở bài kiểm tra online':'Mở tài liệu/link')+' ↗</a></div>':'')+'</article>';
  }
  function homeworkPanel(items,emptyTitle,emptyCopy){
    if(!items.length)return '<div class="empty-state"><strong>'+esc(emptyTitle)+'</strong>'+esc(emptyCopy)+'</div>';
    return '<div class="homework-list">'+items.map(homeworkCard).join('')+'</div>';
  }
  function gradesPanel(){
    const grades=Array.isArray(portal.grades)?portal.grades:[];
    if(!grades.length)return '<div class="empty-state"><strong>Chưa có điểm được công bố</strong>Điểm sẽ xuất hiện tại đây khi giáo viên nhập và lưu sổ điểm.</div>';
    const rows=grades.map(item=>'<tr><td>'+esc(item.subject||'')+'</td><td>'+esc(item.title||'Đánh giá')+'</td><td class="grade-score">'+(item.score==null?'Chưa nhập':esc(Number(item.score).toLocaleString('vi-VN',{maximumFractionDigits:1})))+'</td><td>'+esc(dateLabel(String(item.updatedAt||'').slice(0,10)))+'</td></tr>').join('');
    return '<section class="surface"><div class="schedule-wrap"><table class="grade-table"><thead><tr><th>Môn học</th><th>Bài đánh giá</th><th>Điểm</th><th>Cập nhật</th></tr></thead><tbody>'+rows+'</tbody></table></div></section>';
  }
  function renderView(){
    const work=homeworkItems();
    if(activeView==='schedule')return heading('Thời khóa biểu của tôi','Lịch học của lớp '+(portal.class.name||'')+' trong năm học '+yearLabel(selectedYear)+'.')+schedulePanel(false);
    if(activeView==='homework'){
      const workList=homeworkItems('assignment'),tests=homeworkItems('online_test');
      return heading('Bài tập & kiểm tra','Nội dung và tài liệu giáo viên giao cho lớp '+(portal.class.name||''),work.length+' mục')+
        '<section class="surface"><div class="surface-head"><h3>Bài tập</h3><span class="pill">'+workList.length+'</span></div>'+homeworkPanel(workList,'Chưa có bài tập mới','Bài tập được giao sẽ hiện ở đây.')+'</section>'+
        '<section class="surface"><div class="surface-head"><h3>Bài kiểm tra online</h3><span class="pill">'+tests.length+'</span></div>'+homeworkPanel(tests,'Chưa có bài kiểm tra','Bài kiểm tra online được giáo viên giao sẽ hiện ở đây.')+'</section>';
    }
    if(activeView==='grades')return heading('Điểm của tôi','Điểm trong sổ đánh giá của lớp '+(portal.class.name||'')+'.',String((portal.grades||[]).length)+' lượt điểm')+gradesPanel();
    return heading('Tổng quan','Thông tin học tập của bạn trong '+yearLabel(selectedYear)+'.')+
      '<div class="card-grid">'+statCard('Lớp học',portal.class.name||'—',portal.class.grade||'')+statCard('Tiết học mỗi tuần',lessonCount(),'Theo thời khóa biểu hiện tại')+statCard('Bài tập & kiểm tra',work.length,'Được giáo viên giao')+'</div>'+
      schedulePanel(true)+
      '<section class="surface"><div class="surface-head"><h3>Bài tập và kiểm tra gần đây</h3><button class="button button-secondary" type="button" data-action="view-homework">Xem tất cả</button></div>'+homeworkPanel(work.slice(0,3),'Chưa có bài được giao','Khi giáo viên giao bài, nội dung sẽ xuất hiện ở đây.')+'</section>'+
      '<section class="surface"><div class="surface-head"><h3>Điểm gần đây</h3><button class="button button-secondary" type="button" data-action="view-grades">Xem điểm</button></div>'+gradesPanel()+'</section>';
  }
  function makeDemo(){
    const demoStudentId='demo-student-01';
    return {
      school:{name:'THPT Lê Quý Đôn'},
      student:{id:demoStudentId,fullName:'Nguyễn Minh An'},
      class:{id:'demo-10a1',name:'10A1',grade:'Khối 10',status:'Đang hoạt động',teacher:'Hoàng Ngọc Mai'},
      years:['2026-2027','2025-2026'],current:'2026-2027',
      schedule:[
        {day:1,period:1,subject:'Toán',teacher:'Võ Thành Long'},
        {day:1,period:2,subject:'Ngữ văn',teacher:'Nguyễn Thị Thu Hà'},
        {day:1,period:3,subject:'Tiếng Anh',teacher:'Bùi Thanh Vân'},
        {day:2,period:1,subject:'Vật lý',teacher:'Trần Minh Quang'},
        {day:2,period:2,subject:'Hóa học',teacher:'Lê Thị Thanh Tâm'},
        {day:3,period:1,subject:'Sinh học',teacher:'Hoàng Ngọc Mai'},
        {day:4,period:2,subject:'Tin học',teacher:'Đỗ Anh Tuấn'},
        {day:5,period:1,subject:'Lịch sử',teacher:'Phạm Quốc Bảo'}
      ],
      homework:[
        {id:'demo-homework-1',type:'assignment',subject:'Toán',title:'Ôn tập phương trình bậc nhất',instructions:'Hoàn thành bài 1 đến bài 5 trong vở bài tập.',dueDate:'2026-11-30',resourceUrl:'',attachments:[]},
        {id:'demo-test-1',type:'online_test',subject:'Tiếng Anh',title:'Kiểm tra từ vựng Unit 4',instructions:'Làm bài kiểm tra theo liên kết giáo viên gửi.',dueDate:'2026-12-02',resourceUrl:'https://example.com',attachments:[]}
      ],
      grades:[
        {id:'demo-grade-1',subject:'Toán',title:'Kiểm tra thường xuyên',score:8.5,updatedAt:'2026-11-18T08:00:00Z'},
        {id:'demo-grade-2',subject:'Ngữ văn',title:'Bài viết số 1',score:9,updatedAt:'2026-11-16T08:00:00Z'},
        {id:'demo-grade-3',subject:'Tiếng Anh',title:'Kiểm tra từ vựng',score:7.5,updatedAt:'2026-11-15T08:00:00Z'}
      ]
    };
  }
  async function downloadAttachment(button){
    if(demoMode){notify('Bản demo không có tệp thật để tải.',false);return}
    if(!client||!session||!button.dataset.path)return;
    const old=button.innerHTML;button.disabled=true;button.textContent='Đang mở tệp…';
    try{
      const result=await client.storage.from('teacher-homework-files').createSignedUrl(button.dataset.path,120);
      if(result.error)throw result.error;
      const url=result.data&&result.data.signedUrl;
      if(!url)throw new Error('signed_url_missing');
      window.open(url,'_blank','noopener,noreferrer');
    }catch(error){notify('Không mở được tệp. Hãy thử lại hoặc liên hệ giáo viên.',true)}
    finally{button.disabled=false;button.innerHTML=old}
  }
  document.addEventListener('click',event=>{
    const nav=event.target.closest('.nav-tab');
    if(nav){activeView=nav.dataset.view||'home';renderPortal();return}
    const button=event.target.closest('[data-action]');
    if(!button)return;
    if(button.dataset.action==='view-homework'){activeView='homework';renderPortal()}
    if(button.dataset.action==='view-grades'){activeView='grades';renderPortal()}
    if(button.dataset.action==='download')downloadAttachment(button);
  });
  $('#loginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const email=$('#loginEmail').value.trim(),password=$('#loginPassword').value;
    const errorNode=$('#loginError'),button=$('#loginButton');
    if(!client){errorNode.textContent='Chưa kết nối được dịch vụ đăng nhập. Tải lại trang hoặc liên hệ nhà trường.';return}
    errorNode.textContent='';button.disabled=true;button.textContent='Đang đăng nhập…';
    try{
      const result=await client.auth.signInWithPassword({email:email,password:password});
      if(result.error)throw result.error;
      session=result.data.session;
      await loadSchools('');
    }catch(error){errorNode.textContent='Email hoặc mật khẩu chưa đúng, hoặc tài khoản chưa được xác nhận.'}
    finally{button.disabled=false;button.textContent='Đăng nhập'}
  });
  $('#demoButton').addEventListener('click',()=>{
    demoMode=true;session=null;schools=[];ownerId='';portal=makeDemo();selectedYear=portal.current;activeView='home';
    $('#schoolPickerWrap').hidden=true;$('#schoolName').textContent=portal.school.name;
    $('#yearSelect').innerHTML=portal.years.map(year=>'<option value="'+esc(year)+'">'+esc(yearLabel(year))+'</option>').join('');
    $('#yearSelect').value=selectedYear;
    showWorkspace();$('#studentWorkspace').hidden=false;renderPortal();
  });
  $('#schoolSelect').addEventListener('change',()=>{
    const school=schools.find(item=>item.owner_id===$('#schoolSelect').value);
    if(!school)return;
    ownerId=school.owner_id;
    $('#schoolName').textContent=school.school&&school.school.name||'Cổng học sinh';
    $('#yearSelect').innerHTML=school.years.map(year=>'<option value="'+esc(year)+'">'+esc(yearLabel(year))+'</option>').join('');
    selectedYear=school.current&&school.years.includes(school.current)?school.current:(school.years[0]||'');
    $('#yearSelect').value=selectedYear;
    loadPortal(ownerId,selectedYear);
  });
  $('#yearSelect').addEventListener('change',()=>{
    selectedYear=$('#yearSelect').value;
    if(demoMode){portal.current=selectedYear;renderPortal();return}
    loadPortal(ownerId,selectedYear);
  });
  $('#refreshButton').addEventListener('click',()=>{
    if(demoMode){portal=makeDemo();renderPortal();return}
    if(session)loadSchools(ownerId);
  });
  $('#signOutButton').addEventListener('click',async()=>{
    if(demoMode){showLogin('');return}
    if(client)await client.auth.signOut();
    schools=[];ownerId='';portal=null;requestNo++;
    showLogin('');
  });
  function initialize(){
    const config=window.SCHOOL_AUTH_CONFIG||{};
    if(window.supabase&&typeof window.supabase.createClient==='function'&&config.supabaseUrl&&config.publishableKey){
      client=window.supabase.createClient(config.supabaseUrl,config.publishableKey,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
      });
      client.auth.onAuthStateChange((event,nextSession)=>{
        if(event==='SIGNED_OUT'){requestNo++;schools=[];ownerId='';portal=null;showLogin('')}
      });
      client.auth.getSession().then(result=>{
        if(result.data&&result.data.session){session=result.data.session;loadSchools('')}
        else showLogin('');
      }).catch(()=>showLogin('Không khôi phục được phiên. Đăng nhập lại để tiếp tục.'));
    }else{
      showLogin('Chưa cấu hình dịch vụ đăng nhập. Bạn vẫn có thể chọn “Xem bản demo”.');
    }
  }
  initialize();
})();
