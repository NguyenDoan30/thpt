const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer, installAuthMocks, createCloudStore, PROJECT_URL, USER_ID, EMAIL, PASSWORD } = require('./auth-fixture.cjs');

const YEAR = '2026-2027', OLD_YEAR = '2025-2026';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const AN = 'Cô An', BINH = 'Cô Bình';
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
async function until(condition, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function snapshot(name = AN) {
  const classes = [
    {id:'a',name:'10A1',grade:'Khối 10',admissionYear:2026,students:0,teacher:''},
    {id:'b',name:'10A2',grade:'Khối 10',admissionYear:2026,students:0,teacher:BINH},
    {id:'c',name:'10A3',grade:'Khối 10',admissionYear:2026,students:0,teacher:name},
    {id:'grad',name:'12C1',grade:'Khối 12',admissionYear:2023,students:0,teacher:name,status:'Đã tốt nghiệp'},
  ];
  const record = {subjects:['Toán','Vật lý','Ngữ văn'],classes,studentProfiles:[],schedule:[],honors:[],teacherStatuses:{},teacherEmails:{[name.toLocaleLowerCase('vi')]:'an.contact@example.test'},assignments:[
    {id:'an-a-math',classId:'a',name,subject:'Toán',phone:'0901234567'},
    {id:'an-a-physics',classId:'a',name,subject:'Vật lý',phone:'0901234567'},
    {id:'an-b-math',classId:'b',name,subject:'Toán',phone:'0901234567'},
    {id:'binh-b-literature',classId:'b',name:BINH,subject:'Ngữ văn',phone:'0909876543'},
    {id:'an-graduated',classId:'grad',name,subject:'Toán'},
  ]};
  const old = clone(record);
  old.classes = [{id:'old-class',name:'12Z9',grade:'Khối 12',admissionYear:2023,students:0,teacher:name}];
  old.assignments = [{id:'old-assignment',classId:'old-class',name,subject:'Ngữ văn'}];
  return {version:1,current:YEAR,school:{name:'THPT Hồ Sơ Giáo Viên',avatar:null},years:{[YEAR]:record,[OLD_YEAR]:old},teachers:[
    {name,phone:'0901234567',email:'an.contact@example.test',birthYear:1984,status:'Đang giảng dạy',subjects:['Toán','Vật lý']},
    {name:BINH,phone:'0909876543',email:'binh.contact@example.test',birthYear:null,status:'Đang giảng dạy',subjects:['Ngữ văn']},
  ]};
}
function seed(store, userId = USER_ID, value = snapshot()) {
  store.rows.set(userId, {user_id:userId,payload:clone(value),revision:1,updated_at:new Date().toISOString()});
}
async function device(browser, origin, store, viewport = {width:1280,height:900}) {
  const context = await browser.newContext({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window,'supabase',{configurable:true,set(sdk){
      Object.defineProperty(window,'supabase',{configurable:true,writable:true,value:new Proxy(sdk,{get(target,key){
        const value=Reflect.get(target,key);
        return key==='createClient'?(...args)=>{window.__testAuthClient=value(...args);return window.__testAuthClient;}:value;
      }})});
    }});
  });
  const auth = await installAuthMocks(page,{cloudStore:store,accounts:[{id:OTHER_ID,email:'second@example.test',password:PASSWORD}]});
  const rpc = {calls:[],completed:0,error:null,held:null,grants:new Map([[USER_ID,[{teacher_name:AN,email:'an.login@example.test',enabled:true}]],[OTHER_ID,[{teacher_name:'Cô Tài Khoản B',email:'b.login@example.test',enabled:true}]]])};
  const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'POST,OPTIONS','content-type':'application/json'};
  await page.route(`${PROJECT_URL}/rest/v1/rpc/list_school_teacher_access`, async route => {
    const request=route.request();
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
    const token=(request.headers().authorization||'').replace(/^Bearer\s+/i,'');
    if(!auth.accessTokens.has(token))return route.fulfill({status:401,headers,body:JSON.stringify({code:'PGRST301',message:'Invalid JWT'})});
    const user=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
    rpc.calls.push({userId:user.sub});
    const error=clone(rpc.error), rows=clone(rpc.grants.get(user.sub)||[]), held=rpc.held;
    if(held&&(!held.userId||held.userId===user.sub))await held.gate.promise;
    try {await route.fulfill({status:error?400:200,headers,body:JSON.stringify(error||rows)});} catch (_) { /* Expected when a prior session cancels its request. */ }
    rpc.completed++;
  });
  await page.goto(origin);
  return {context,page,auth,rpc,errors};
}
async function teachers(d) {
  if(await d.page.locator('#mobileMenu').isVisible())await d.page.locator('#mobileMenu').click();
  await d.page.locator('.nav-btn[data-page="teachers"]').click();
}
async function open(d,name=AN,index=0) {
  await d.page.locator('[data-teacher-detail]').filter({hasText:name}).nth(index).click();
  await d.page.locator('#teacherDetails').waitFor();
}
const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus')?.dataset.state==='synced');
const close = d => d.page.locator('.modal-close').click();
const settledFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function run() {
  const server=await startTestServer();
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try {
    for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
      const store=createCloudStore();seed(store);
      const d=await device(browser,server.origin,store,viewport);
      try {
        await d.auth.signIn();await teachers(d);await open(d);
        await until(async()=> (await d.page.locator('#teacherLoginEmail').textContent()).includes('an.login@example.test'),'real linked email');
        assert.equal(await d.page.locator('[data-teacher-account-retry]').isVisible(),false,'Retry is hidden after a successful account read');
        assert.match(await d.page.locator('#teacherBirthYearValue').textContent(),/1984/);
        const teaching=await d.page.locator('#teacherDetailsClasses').textContent();
        assert.match(teaching,/10A1/);assert.match(teaching,/10A2/);assert.match(teaching,/Toán/);assert.match(teaching,/Vật lý/);
        assert.doesNotMatch(teaching,/12C1|12Z9|Ngữ văn/,'Teaching classes use only this teacher’s active assignments in the selected year');
        assert.equal((teaching.match(/10A1/g)||[]).length,1,'Multiple subjects in one class are grouped');
        assert.match(await d.page.locator('#teacherDetailsHomeroom').textContent(),/10A3/);
        assert.doesNotMatch(await d.page.locator('#teacherDetailsHomeroom').textContent(),/12C1/);
        assert.match(await d.page.locator('#teacherContactEmail').textContent(),/an.contact@example.test/);
        assert.match(await d.page.locator('#teacherContactPhone').textContent(),/0901234567/);
        assert.doesNotMatch(await d.page.locator('#teacherLoginEmail').textContent(),/an.contact@example.test/,'Login identity must come from the grant, not the contact profile');
        assert.match(await d.page.locator('#teacherPasswordInfo').textContent(),/không thể|không.*xem|bảo vệ/i);
        assert.equal(await d.page.locator('#teacherDetails input[type="password"],#teacherDetails input[name="password"]').count(),0);
        assert.match(await d.page.locator('.teacher-password-link').getAttribute('href'),/^https:\/\/supabase\.com\/dashboard\/project\/school-test\/auth\/users/);
        assert.equal(await d.page.locator('.teacher-password-link').getAttribute('target'),'_blank');
        assert.equal(d.auth.requests.some(item=>/recover|reset/i.test(item.path)),false,'Opening a profile must not send a password-reset message');
        assert.equal(await d.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        fs.mkdirSync('/workspace/artifacts',{recursive:true});
        await d.page.screenshot({path:`/workspace/artifacts/teacher-details-${viewport.width}.png`,fullPage:true,animations:'disabled'});

        await d.page.locator('#teacherBirthYear').fill('1899');
        await d.page.getByRole('button',{name:'Lưu năm sinh',exact:true}).click();
        assert.equal(await d.page.locator('#teacherBirthYear').evaluate(node=>node.validity.valid),false);
        assert.equal(store.rows.get(USER_ID).payload.teachers.find(person=>person.name===AN).birthYear,1984);
        await d.page.locator('#teacherBirthYear').fill('1986');
        await d.page.getByRole('button',{name:'Lưu năm sinh',exact:true}).click();
        await until(()=>store.rows.get(USER_ID).payload.teachers.find(person=>person.name===AN).birthYear===1986,'saved birth year');
        assert.match(await d.page.locator('#teacherBirthYearValue').textContent(),/1986/);
        await close(d);
        await d.page.locator('[data-action="edit-assignment"][data-id="an-a-math"]').click();
        await d.page.locator('#f-phone').fill('0901234567');
        await d.page.getByRole('button',{name:'Lưu thông tin',exact:true}).click();await synced(d.page);
        assert.equal(store.rows.get(USER_ID).payload.teachers.find(person=>person.name===AN).birthYear,1986,'Editing an assignment preserves the teacher’s birth year');
        await d.page.reload();await d.page.locator('#appRoot').waitFor({state:'visible'});await synced(d.page);await teachers(d);
        await open(d,AN,1);await until(async()=> (await d.page.locator('#teacherLoginEmail').textContent()).includes('an.login@example.test'),'reloaded linked email');
        assert.match(await d.page.locator('#teacherBirthYearValue').textContent(),/1986/,'All assignment rows open the same durable teacher profile');
        await close(d);await d.page.locator('#academicYearButton').click();
        await d.page.locator('[data-action="select-school-year"][data-year="'+OLD_YEAR+'"]').click();await teachers(d);await open(d);
        assert.match(await d.page.locator('#teacherBirthYearValue').textContent(),/1986/,'Birth year is a shared teacher profile field across academic years');
        assert.match(await d.page.locator('#teacherDetailsClasses').textContent(),/12Z9/);
        assert.doesNotMatch(await d.page.locator('#teacherDetailsClasses').textContent(),/10A1|10A2/,'Teaching classes follow the year being viewed');
        await close(d);await d.page.locator('#academicYearButton').click();
        await d.page.locator('[data-action="select-school-year"][data-year="'+YEAR+'"]').click();await teachers(d);await open(d);

        let second;
        if(viewport.width>500) {
          second=await device(browser,server.origin,store);
          await second.auth.signIn();await teachers(second);await open(second);
          assert.match(await second.page.locator('#teacherBirthYearValue').textContent(),/1986/,'Another independent browser receives the saved year');
          await close(second);
        }
        await d.page.locator('#teacherBirthYear').fill('');await d.page.getByRole('button',{name:'Lưu năm sinh',exact:true}).click();
        await until(()=>store.rows.get(USER_ID).payload.teachers.find(person=>person.name===AN).birthYear===null,'clear saved birth year');
        assert.doesNotMatch(await d.page.locator('#teacherBirthYearValue').textContent(),/1986/);
        if(second) {
          await second.page.evaluate(()=>window.schoolDataSync.pull());await open(second);
          assert.doesNotMatch(await second.page.locator('#teacherBirthYearValue').textContent(),/1986/,'Clearing propagates without resurrecting an old year');
          assert.deepEqual(second.errors,[]);await second.context.close();
        }
        await close(d);await open(d,BINH);
        await until(async()=> /chưa.*liên kết|chưa.*cấp|không.*liên kết/i.test(await d.page.locator('#teacherLoginEmail').textContent()),'unlinked account state');
        assert.match(await d.page.locator('#teacherBirthYearValue').textContent(),/chưa/i,'Missing birth years must not be fabricated');
        assert.equal(await d.page.locator('#teacherBirthYear').inputValue(),'');
        assert.equal(await d.page.evaluate(password=>Object.values(localStorage).some(value=>value.includes(password)),PASSWORD),false,'No plaintext login password is copied into workspace/cache storage');
        assert.deepEqual(d.errors,[]);
        console.log(`PASS ${viewport.width}px: aggregate current-year classes, real contact/login identities, protected password guidance, optional durable birth year and responsive details.`);
      } finally {await d.context.close();}
    }

    const store=createCloudStore();seed(store);seed(store,OTHER_ID,snapshot('Cô Tài Khoản B'));
    const d=await device(browser,server.origin,store);
    try {
      await d.auth.signIn();await teachers(d);
      d.rpc.error={code:'XX000',message:'Temporary failure'};
      await open(d);
      await until(async()=>Boolean((await d.page.locator('#teacherLoginError').textContent()).trim()),'account load error');
      assert.equal(await d.page.locator('[data-teacher-account-retry]').isVisible(),true,'Retry is visible only after an account read fails');
      assert.doesNotMatch(await d.page.locator('#teacherLoginEmail').textContent(),/chưa.*liên kết/i,'A failed request cannot claim the teacher has no account');
      d.rpc.error=null;await d.page.locator('[data-teacher-account-retry]').click();
      await until(async()=> (await d.page.locator('#teacherLoginEmail').textContent()).includes('an.login@example.test'),'account retry');
      assert.equal(await d.page.locator('[data-teacher-account-retry]').isVisible(),false,'A successful retry hides its action again');
      await close(d);

      // Opening account management from a specific profile must retain that
      // teacher after its initial list request fails and is retried.
      await open(d,BINH);
      await until(async()=> /chưa.*liên kết|chưa.*cấp|không.*liên kết/i.test(await d.page.locator('#teacherLoginEmail').textContent()),'second teacher profile before management');
      d.rpc.error={code:'XX000',message:'Temporary management failure'};
      await d.page.locator('[data-teacher-accounts-open-for="'+BINH+'"]').click();
      await d.page.locator('[data-access-reload]').waitFor({state:'visible'});
      d.rpc.error=null;await d.page.locator('[data-access-reload]').click();
      await d.page.locator('#teacherAccessForm').waitFor({state:'visible'});
      assert.equal(await d.page.locator('#accessTeacher').inputValue(),BINH,'Management retry preserves the specific profile instead of defaulting to the first teacher');
      assert.equal(await d.page.locator('#accessEmail').inputValue(),'binh.contact@example.test');
      await close(d);

      const gate=deferred();d.rpc.held={userId:USER_ID,gate};const before=d.rpc.calls.length;
      await open(d);await until(()=>d.rpc.calls.length>before,'held teacher A account read');
      await close(d);d.rpc.held=null;await open(d,BINH);
      await until(async()=> /chưa.*liên kết|chưa.*cấp|không.*liên kết/i.test(await d.page.locator('#teacherLoginEmail').textContent()),'teacher B empty account');
      gate.resolve();await settledFrames(d.page);
      assert.doesNotMatch(await d.page.locator('#teacherDetails').textContent(),/an.login@example.test/,'An earlier teacher request must not fill a different teacher dialog');
      await close(d);

      const logoutGate=deferred();d.rpc.held={userId:USER_ID,gate:logoutGate};const beforeLogout=d.rpc.calls.length;
      await open(d);await until(()=>d.rpc.calls.length>beforeLogout,'held account read before logout');
      await d.page.evaluate(()=>document.querySelector('#logoutButton').click());
      await d.page.locator('#authScreen').waitFor({state:'visible'});
      assert.equal(await d.page.locator('#teacherDetails').count(),0);
      d.rpc.held=null;await d.auth.signIn('second@example.test');await teachers(d);await open(d,'Cô Tài Khoản B');
      await until(async()=> (await d.page.locator('#teacherLoginEmail').textContent()).includes('b.login@example.test'),'second account linked email');
      logoutGate.resolve();await settledFrames(d.page);
      assert.doesNotMatch(await d.page.locator('#teacherDetails').textContent(),/an.login@example.test/,'A late old-account read cannot alter the replacement account');
      assert.deepEqual(d.errors,[]);
      console.log('PASS: account errors retry correctly; late teacher and account responses cannot cross dialogs or authenticated users.');
    } finally {d.rpc.held?.gate.resolve();await d.context.close();}
  } finally {await browser.close();await server.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
