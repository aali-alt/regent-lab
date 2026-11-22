import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {FirestoreRepository} from '../firebase-repository.mjs';
import {createHandler} from '../http-handler.mjs';
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:/);
assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST||'',/^127\.0\.0\.1:/);
const require=createRequire(import.meta.url),dir=path.resolve('..'),app=initializeApp({projectId:'demo-regent-lab'},'ui-test'),db=getFirestore(app),auth=getAuth(app);
let browser,apiServer,siteServer;
try{
  await fetch('http://'+process.env.FIRESTORE_EMULATOR_HOST+'/emulator/v1/projects/demo-regent-lab/databases/(default)/documents',{method:'DELETE'});
  const source=await fs.readFile(path.join(dir,'index.html'),'utf8');
  const expression=source.match(/const DEFAULT_STATE = ([\s\S]+?);\n\n        function loadLocalState/)[1];
  const state=vm.runInNewContext('('+expression+')');
  const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/password|secret|credential/i.test(key)).map(([key,val])=>[key,clean(val)])):value;
  state.settings=clean(state.settings);delete state.settings.teachers;
  await db.doc('regent_v2_settings/main').set({...state.settings,version:1});
  for(const kind of ['inventory','cabinets','logs'])for(const row of state[kind])await db.doc('regent_v2_'+kind+'/'+row.id).set({...row,version:1,...(kind==='inventory'?{qty:10}:{})});
  await db.doc('regent_v2_logs/restore_test_prior').set({id:'restore_test_prior',type:'seeded_prior_audit',item:'Synthetic fixture',delta:'0',note:'Prior audit entry that must survive every restore',time:'2026-11-20T10:00:00.000Z',version:1});
  for(const account of [{uid:'ui_admin',name:'admin',role:'admin'},{uid:'ui_teacher',name:'Teacher One',role:'teacher'}]){
    const login=account.uid+'@demo.invalid';try{await auth.deleteUser(account.uid);}catch{}
    await auth.createUser({uid:account.uid,email:login,password:'Local-ui-fixture-only-2026'});await auth.setCustomUserClaims(account.uid,{sessionVersion:1});
    await db.doc('regent_v2_accounts/'+account.uid).set({...account,login,disabled:false,sessionVersion:1,validAfter:0});
    await db.doc('regent_v2_directory/'+account.uid).set({...account,login,disabled:false});
  }
  await build({entryPoints:[path.join(dir,'secure-client.mjs')],outfile:path.join(dir,'ui-client.bundle.js'),format:'iife',globalName:'RegentSecureReview',bundle:true,platform:'browser',plugins:[{name:'local-firebase-sdk',setup(builder){builder.onResolve({filter:/^https:\/\/www\.gstatic\.com\/firebasejs\/.*\/firebase-(app|auth|firestore)\.js$/},args=>({path:require.resolve('firebase/'+args.path.match(/firebase-(app|auth|firestore)\.js$/)[1])}));}}]});
  let html=source.replace('import {createSecureClient} from "./secure-client.mjs";','const {createSecureClient}=window.RegentSecureReview; window.__safeHTMLForTest=safeHTML;').replace('const SECURE_BACKEND_URL = "";','const SECURE_BACKEND_URL = "http://127.0.0.1:8787";').replace('testEmulators: false','testEmulators: true').replace(/regent-lab\.firebaseapp\.com/g,'demo-regent-lab.firebaseapp.com').replace('projectId: "regent-lab"','projectId: "demo-regent-lab"');
  html=html.replace('<script type="module">','<script src="/ui-client.bundle.js"></script><script type="module">');
  html=html.replace(/<script\b[^>]*src=["']https:\/\/cdn.tailwindcss.com["'][^>]*><\/script>/,()=>'<script>'+require('node:fs').readFileSync(path.join(dir,'tailwind.js'),'utf8')+'</script>').replace(/<script\b[^>]*src=["'][^"']*qrcode.min.js["'][^>]*><\/script>/,()=>'<script>'+require('node:fs').readFileSync(path.join(dir,'qrcode.js'),'utf8')+'</script>');
  html=html.replace('</head>','<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>');
  await fs.writeFile(path.join(dir,'ui-emulator-preview.html'),html);
  apiServer=createServer(createHandler({repo:new FirestoreRepository(db),auth,allowedOrigin:'http://127.0.0.1:4173',allowLocalDevelopment:true}));await new Promise(r=>apiServer.listen(8787,'127.0.0.1',r));
  siteServer=createServer(async(req,res)=>{let file=req.url.startsWith('/ui-client.bundle.js')?'ui-client.bundle.js':req.url.startsWith('/assets/')?req.url.slice(1).split('?')[0]:'ui-emulator-preview.html';if(!/^[a-zA-Z0-9_./-]+$/.test(file)||file.includes('..')){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html');try{res.end(await fs.readFile(path.join(dir,file)));}catch{res.statusCode=404;res.end();}});await new Promise(r=>siteServer.listen(4173,'127.0.0.1',r));
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const teacher=await context.newPage();const errors=[];teacher.on('pageerror',err=>errors.push(err.message));
  await teacher.goto('http://127.0.0.1:4173/?mode=teacher');
  await teacher.locator('#tp-login-teacher-select').selectOption('Teacher One',{timeout:15000});await teacher.locator('#tp-login-password').fill('Local-ui-fixture-only-2026');await teacher.locator('#tp-login-password').press('Enter');
  try { await teacher.locator('#tp-main-content').waitFor({state:'visible',timeout:20000}); } catch(err) { console.log('LOGIN DEBUG', errors, await teacher.locator('#toast-container').innerText(), await teacher.locator('#tp-login-teacher-select').inputValue(), await teacher.locator('#tp-login-password').evaluate(input=>({length:input.value.length}))); throw err; }
  await teacher.locator('#tp-experiment').fill('UI round-trip microscopy');
  for(const selector of ['#tp-subject','#tp-grade','#tp-period','#tp-lab']){const value=await teacher.locator(selector+' option').evaluateAll(options=>options.find(o=>o.value)?.value);await teacher.locator(selector).selectOption(value);}
  await teacher.locator('#tp-date').fill('2026-11-22');
  const itemId=await teacher.locator('#tp-item-select option').evaluateAll(options=>options.find(o=>o.value)?.value);await teacher.locator('#tp-item-select').selectOption(itemId);await teacher.locator('#tp-item-qty').fill('3');await teacher.getByRole('button',{name:/Add Item/}).click();
  console.log('FORM CHECK',await teacher.locator('#teacher-portal-form').evaluate(form=>({valid:form.checkValidity(),invalid:[...form.querySelectorAll(':invalid')].map(e=>({id:e.id,message:e.validationMessage}))})));
  teacher.on('response',async response=>{if(response.url().startsWith('http://127.0.0.1:8787/')&&response.status()>=400)console.log('API failure',response.status(),await response.text());});
  await teacher.locator('#teacher-portal-form').evaluate(form=>form.requestSubmit());
  console.log('SUBMIT TOAST',await teacher.locator('#toast-container').innerText());
  try{await teacher.locator('#teacher-submit-success').waitFor({state:'visible',timeout:12000});}catch(err){console.log('PAGE ERRORS',errors);console.log('VISIBLE TEXT',(await teacher.locator('body').innerText()).slice(-2500));await teacher.screenshot({path:path.join(dir,'ui-test-failure.png')});throw err;}
  const requests=await db.collection('regent_v2_requests').get();assert.equal(requests.docs.filter(doc=>!doc.data()._meta).length,1);assert.equal(requests.docs.find(doc=>!doc.data()._meta).data().teacherUid,'ui_teacher');
  const adminPage=await context.newPage();adminPage.on('pageerror',err=>errors.push(err.message));
  adminPage.on('response',async response=>{if(response.url().startsWith('http://127.0.0.1:8787/')&&response.status()>=400)console.log('ADMIN API failure',response.status(),response.url().split('8787')[1],await response.text());});await adminPage.goto('http://127.0.0.1:4173/');await adminPage.locator('#admin-login-user').fill('admin');await adminPage.locator('#admin-login-pass').fill('Local-ui-fixture-only-2026');await adminPage.locator('#admin-login-pass').press('Enter');
  await adminPage.locator('#admin-login-gate').waitFor({state:'hidden',timeout:20000});await adminPage.evaluate(()=>window.switchTab('requests'));await adminPage.getByRole('button',{name:/Approve & Fulfill/}).click();
  await teacher.getByText('Approved by Lab',{exact:false}).waitFor({state:'visible',timeout:20000});
  assert.equal((await db.doc('regent_v2_inventory/'+itemId).get()).data().qty,7);
  async function stock(expected){for(let tries=0;tries<40;tries++){if((await db.doc('regent_v2_inventory/'+itemId).get()).data().qty===expected)return;await new Promise(r=>setTimeout(r,100));}assert.equal((await db.doc('regent_v2_inventory/'+itemId).get()).data().qty,expected);}
  await adminPage.evaluate(id=>window.openInventoryModal(id),itemId);await adminPage.locator('#inv-qty').fill('12');await adminPage.locator('#inventory-modal form').evaluate(form=>form.requestSubmit());await adminPage.locator('#inventory-modal').waitFor({state:'hidden'});await stock(12);
  // A form opened before a listener update must not adopt the newer record's version.
  await adminPage.evaluate(id=>window.openInventoryModal(id),itemId);
  const staleItem=(await db.doc('regent_v2_inventory/'+itemId).get()).data();
  await db.doc('regent_v2_inventory/'+itemId).update({qty:11,version:staleItem.version+1,updatedAt:new Date().toISOString()});
  await adminPage.waitForFunction(id=>[...document.querySelectorAll('#loan-item-select option')].some(option=>option.value===id&&option.textContent.includes('[11 left]')),itemId);
  await adminPage.locator('#inv-qty').fill('10');await adminPage.locator('#inventory-modal form').evaluate(form=>form.requestSubmit());
  await adminPage.getByText('This form is out of date. Close it and open it again before saving.',{exact:true}).waitFor();await stock(11);
  assert.equal(await adminPage.locator('#inventory-modal').isVisible(),true);
  await adminPage.evaluate(id=>{window.closeModal('inventory-modal');window.openInventoryModal(id);},itemId);
  await adminPage.locator('#inv-qty').fill('12');await adminPage.locator('#inventory-modal form').evaluate(form=>form.requestSubmit());await adminPage.locator('#inventory-modal').waitFor({state:'hidden'});await stock(12);
  const hostile=`O'Brien \"><img src=x onerror=window.__xssProbe=1>');window.__xssProbe=1;//`;
  const escaped=await adminPage.evaluate(value=>{const tag=window.__safeHTMLForTest,box=document.createElement('div');window.__safeChoice=v=>{window.__chosenValue=v;};box.innerHTML=tag`<button onclick="window.__safeChoice('${value} (${value})')">${value}</button>`;document.body.appendChild(box);box.querySelector('button').click();const result={text:box.textContent,images:box.querySelectorAll('img').length,chosen:window.__chosenValue,executed:window.__xssProbe||0};box.remove();delete window.__safeChoice;return result;},hostile);
  assert.equal(escaped.text,hostile);assert.equal(escaped.images,0);assert.equal(escaped.chosen,hostile+' ('+hostile+')');assert.equal(escaped.executed,0);
  console.log('PASS: stale inventory modal rejected after a concurrent update; quoted event parameters and imported markup render as data.');
  async function manualLoan(qty){await adminPage.evaluate(()=>window.openModal('loan-modal'));await adminPage.locator('#loan-teacher').selectOption('Teacher One');const cls=await adminPage.locator('#loan-class option').evaluateAll(options=>options.find(o=>o.value)?.value);await adminPage.locator('#loan-class').selectOption(cls);await adminPage.locator('#loan-due-date').fill('2026-11-23');await adminPage.locator('#loan-item-select').selectOption(itemId);await adminPage.locator('#loan-qty').fill(String(qty));await adminPage.locator('#loan-modal form').evaluate(form=>form.requestSubmit());await adminPage.locator('#loan-modal').waitFor({state:'hidden'});const loans=(await db.collection('regent_v2_loans').get()).docs.filter(doc=>!doc.data()._meta);return loans.find(d=>d.data().status==='active').id;}
  const firstLoan=await manualLoan(2);await stock(10);await adminPage.evaluate(id=>window.returnTeacherLoan(id),firstLoan);await stock(12);
  async function loss(qty,loanId=''){await adminPage.evaluate(({itemId,loanId})=>window.openLossModal(itemId,loanId,'Teacher One',1),{itemId,loanId});await adminPage.locator('#loss-qty').fill(String(qty));await adminPage.locator('#loss-notes').fill('Synthetic regression fixture');await adminPage.locator('#loss-modal form').evaluate(form=>form.requestSubmit());await adminPage.locator('#loss-modal').waitFor({state:'hidden'});}
  await loss(2);await stock(10);const partialLoan=await manualLoan(3);await stock(7);await loss(1,partialLoan);await stock(9);assert.equal((await db.doc('regent_v2_loans/'+partialLoan).get()).data().status,'returned');
  await adminPage.evaluate(()=>window.switchTab('schedule'));
  await adminPage.evaluate(period=>window.openScheduleSlotModal('Sunday',period,'2026-11-29'),state.settings.periods[1]);
  await adminPage.locator('#slot-lab').selectOption(state.settings.labs[0]);await adminPage.locator('#slot-teacher').selectOption('Teacher One');await adminPage.locator('#slot-subject').selectOption(state.settings.subjects[0]);await adminPage.locator('#slot-grade').selectOption(state.settings.grades[0]);await adminPage.locator('#slot-topic').fill('Recurring regression session');await adminPage.locator('#schedule-slot-modal form').evaluate(form=>form.requestSubmit());await adminPage.locator('#schedule-slot-modal').waitFor({state:'hidden'});
  const slots=(await db.collection('regent_v2_scheduleSlots').get()).docs.filter(doc=>!doc.data()._meta);assert.equal(slots.length,1);const slotId=slots[0].id;
  await adminPage.evaluate(({period,slotId})=>window.openScheduleSlotModal('Monday',period,'2026-11-30',slotId),{period:state.settings.periods[2],slotId});await adminPage.locator('#slot-topic').fill('Moved recurring regression session');await adminPage.locator('#schedule-slot-modal form').evaluate(form=>form.requestSubmit());await adminPage.locator('#schedule-slot-modal').waitFor({state:'hidden'});let slot=(await db.doc('regent_v2_scheduleSlots/'+slotId).get()).data();assert.equal(slot.day,'Monday');assert.equal(slot.period,state.settings.periods[2]);
  await adminPage.evaluate(id=>window.skipRecurringSlotDate(id,'2026-12-07'),slotId);slot=(await db.doc('regent_v2_scheduleSlots/'+slotId).get()).data();assert.ok(slot.skippedDates.includes('2026-12-07'));
  const downloadPromise=adminPage.waitForEvent('download');await adminPage.evaluate(()=>window.exportSystemJSON());const download=await downloadPromise;const exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));assert.equal(exported.inventory.find(i=>i.id===itemId).qty,9);assert.equal(/"(?:password|adminPassword)"\s*:/.test(JSON.stringify(exported)),false);
  await adminPage.evaluate(()=>{window.print=()=>{window.__printTriggered=true;};window.printFullInventoryReport();});await adminPage.waitForFunction(()=>window.__printTriggered===true);assert.match(await adminPage.locator('#print-stage').innerText(),/Complete Laboratory Inventory Register/);
  await adminPage.evaluate(()=>window.switchTab('settings'));
  await adminPage.locator('#set-sync-room-id').fill('synthetic-qr-label');
  await adminPage.evaluate(()=>window.saveCloudSyncSettings());
  assert.equal((await db.doc('regent_v2_settings/main').get()).data().syncRoomId,'synthetic-qr-label');
  await adminPage.getByText('Advanced: Matching Firebase Web Config (JSON)',{exact:true}).click();
  await adminPage.locator('#set-custom-firebase-cfg').fill(JSON.stringify({apiKey:'synthetic-public-web-config',projectId:'wrong-project',authDomain:'wrong-project.invalid'}));
  await adminPage.evaluate(()=>window.saveCustomFirebaseConfig());
  assert.equal(await adminPage.evaluate(()=>localStorage.getItem('ris_custom_firebase_cfg_v1')),null);
  assert.match(await adminPage.locator('#toast-container').innerText(),/does not match the secure backend/);
  await adminPage.locator('#set-custom-firebase-cfg').fill(JSON.stringify({apiKey:'synthetic',projectId:'demo-regent-lab',authDomain:'demo.invalid',private_key:'inert-not-a-key'}));
  await adminPage.evaluate(()=>window.saveCustomFirebaseConfig());assert.match(await adminPage.locator('#toast-container').innerText(),/Never paste a service account/);
  const teacherPasswordHandler=await adminPage.locator('#settings-teachers-list input[type=password]').first().getAttribute('onchange');assert.match(teacherPasswordHandler,/updateTeacherPassword\('ui_teacher'/);
  await adminPage.evaluate(()=>window.switchTab('reports'));
  await adminPage.evaluate(()=>{window.confirm=()=>true;});
  await adminPage.locator('input[type=file][accept=".json"]').setInputFiles({name:'synthetic-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});
  await adminPage.getByRole('button',{name:'Restore backup',exact:true}).click();
  const expectedToast='Backup restored: '+exported.requests.length+' requests, '+exported.loans.length+' loans, '+exported.inventory.length+' inventory records. Accounts kept.';
  try{await adminPage.getByText(expectedToast,{exact:true}).waitFor({timeout:20000});}catch(err){console.log('RESTORE TOAST DEBUG',JSON.stringify({expected:exported&&{requests:exported.requests.length,loans:exported.loans.length,inventory:exported.inventory.length,kinds:Object.keys(exported)},toast:await adminPage.locator('#toast-container').innerText()}));throw err;}
  await adminPage.waitForFunction(()=>window.secureClient&&window.secureClient.ready===true);
  assert.equal((await db.doc('regent_v2_settings/main').get()).data().restoreEpoch,1);
  assert.equal((await db.collection('regent_v2_requests').get()).docs.filter(doc=>!doc.data()._meta).length,1);
  assert.equal((await db.collection('regent_v2_loans').get()).docs.filter(doc=>!doc.data()._meta).length,2);
  assert.equal((await db.doc('regent_v2_inventory/'+itemId).get()).data().qty,9);
  assert.equal((await db.doc('regent_v2_accounts/ui_teacher').get()).data().role,'teacher');
  const priorLog=await db.doc('regent_v2_logs/restore_test_prior').get();assert.equal(priorLog.exists,true);
  const incompleteBackup={...exported};delete incompleteBackup.loans;
  await adminPage.locator('input[type=file][accept=".json"]').setInputFiles({name:'incomplete-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(incompleteBackup))});
  await adminPage.getByText('The backup must include settings and every dataset, including requests and loans.',{exact:true}).waitFor();
  const tamperedBackup=JSON.parse(JSON.stringify(exported));tamperedBackup.requests[0].status='bogus';
  await adminPage.locator('input[type=file][accept=".json"]').setInputFiles({name:'tampered-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(tamperedBackup))});
  await adminPage.getByRole('button',{name:'Restore backup',exact:true}).click();
  try{await adminPage.getByText('A backed-up request has an invalid status or use mode',{exact:false}).waitFor({timeout:15000});}catch(err){console.log('TAMPERED TOAST DEBUG',JSON.stringify({toast:await adminPage.locator('#toast-container').innerText(),settings:(await db.doc('regent_v2_settings/main').get()).data()}));throw err;}
  assert.equal((await db.doc('regent_v2_settings/main').get()).data().restoreEpoch,1);
  assert.equal((await db.doc('regent_v2_inventory/'+itemId).get()).data().qty,9);
  // A second generation must re-sync both the restorer and the already-open teacher session.
  const secondBackup=structuredClone(exported);secondBackup.inventory.find(row=>row.id===itemId).qty=8;
  await adminPage.locator('input[type=file][accept=".json"]').setInputFiles({name:'second-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(secondBackup))});
  await adminPage.getByRole('button',{name:'Restore backup',exact:true}).click();
  await adminPage.waitForFunction(()=>window.secureClient?.ready&&window.secureClient.snapshot.settings.restoreEpoch===2);
  await teacher.waitForFunction(()=>window.secureClient?.ready&&window.secureClient.snapshot.settings.restoreEpoch===2);
  assert.equal((await db.doc('regent_v2_inventory/'+itemId).get()).data().qty,8);
  await adminPage.evaluate(()=>window.switchTab('settings'));
  await adminPage.locator('#set-sync-room-id').fill('post-restore-generation-two');await adminPage.evaluate(()=>window.saveCloudSyncSettings());
  assert.equal((await db.doc('regent_v2_settings/main').get()).data().syncRoomId,'post-restore-generation-two');
  await adminPage.evaluate(()=>window.switchTab('settings'));
  await adminPage.screenshot({path:path.join(dir,'ui-settings-review.png'),fullPage:false});
  await adminPage.evaluate(()=>window.switchTab('requests'));
  console.log('PASS: safe QR-label save, rejection of mismatched backend config, full UI restore with audit/account preservation, and rejection of incomplete and tampered backups.');
  console.log('PASS: inventory edit, loan issue and full return, direct loss, partial-loan loss/restock, recurring booking create/move/skip, password-free JSON export and print-stage rendering.');
  await adminPage.evaluate(()=>document.fonts.ready);await teacher.evaluate(()=>document.fonts.ready);
  await adminPage.screenshot({path:path.join(dir,'ui-auth-admin-desktop.png'),fullPage:false});
  await teacher.setViewportSize({width:390,height:844});await teacher.screenshot({path:path.join(dir,'ui-auth-teacher-mobile.png'),fullPage:false});
  await adminPage.evaluate(()=>window.lockAdminSession());
  await adminPage.locator('#admin-login-gate').waitFor({state:'visible'});
  assert.equal(await adminPage.evaluate(()=>localStorage.getItem('ris_lab_secure_review_v2')),null);
  assert.equal((await adminPage.locator('body').innerText()).includes('UI round-trip microscopy'),false);
  console.log('PASS: logout clears the administrator dataset from the UI and no cloud dataset is written into browser localStorage.');
  assert.deepEqual(errors,[]);console.log('PASS: actual teacher dropdown/password login, request submission, admin login/approval, stock 10 -> 7, teacher receives approval through live listener. Desktop/mobile screenshots captured. No external network allowed.');
}finally{if(browser)await browser.close();if(apiServer)await new Promise(r=>apiServer.close(r));if(siteServer)await new Promise(r=>siteServer.close(r));await deleteApp(app);}
