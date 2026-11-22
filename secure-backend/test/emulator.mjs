import {publicDirectoryEntry} from '../auth-broker.mjs';
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,getDoc,setDoc,collection,query,where,getDocs} from 'firebase/firestore';
import {restoreDataset} from '../restore.mjs';
import {FirestoreRepository} from '../firebase-repository.mjs';
import {createRequisition,decideRequisition,applyAdminChanges,returnLoan} from '../domain.mjs';
const enabled=!!process.env.FIRESTORE_EMULATOR_HOST;
const projectId='demo-regent-lab';
let app,db,repo,env;
const admin={uid:'admin1',role:'admin',name:'Lab Admin'},teacher={uid:'teacher1',role:'teacher',name:'Teacher One'};
const request=(id,date='2026-11-22')=>({id,date,usageMode:'in-lab',lab:'Lab 1',period:'Period 1',experiment:'Microscopy',grade:'Grade 7',subject:'Biology',items:[{itemId:'beaker',qty:3}]});
before(async()=>{if(!enabled)return;assert.match(process.env.FIRESTORE_EMULATOR_HOST,/^(127\.0\.0\.1|localhost):/);app=initializeApp({projectId},'integration');db=getFirestore(app);repo=new FirestoreRepository(db);env=await initializeTestEnvironment({projectId,firestore:{rules:await readFile(new URL('../firestore.review.rules',import.meta.url),'utf8')}});});
after(async()=>{if(env)await env.cleanup();if(app)await deleteApp(app);});
async function seed(){await env.clearFirestore();await db.doc('regent_v2_meta/__seed').delete().catch(()=>{});await db.doc('regent_v2_inventory/beaker').set({id:'beaker',nameEn:'Beaker',unit:'pcs',qty:10,version:1});await db.doc('regent_v2_settings/main').set({labs:['Lab 1'],periods:['Period 1']});for(const a of [admin,teacher,{uid:'teacher2',role:'teacher',name:'Teacher Two'}])await db.doc('regent_v2_accounts/'+a.uid).set({...a,disabled:false,validAfter:0,sessionVersion:1});}
const integration=(name,fn)=>test(name,{skip:!enabled},fn);
integration('Firestore: concurrent requests for one slot have exactly one winner',async()=>{await seed();const results=await Promise.allSettled([createRequisition(repo,teacher,request('r1'),'c1'),createRequisition(repo,{...teacher,uid:'teacher2'},request('r2'),'c2')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'BOOKING_CONFLICT');});
integration('Firestore: disjoint requests both persist and duplicate approval is atomic',async()=>{await seed();await Promise.all([createRequisition(repo,teacher,request('r1'),'c1'),createRequisition(repo,{...teacher,uid:'teacher2'},request('r2','2026-11-23'),'c2')]);assert.equal((await db.collection('regent_v2_requests').get()).docs.filter(doc=>!doc.data()._meta).length,2);await Promise.all([decideRequisition(repo,admin,{requestId:'r1',decision:'approved'},'a1'),decideRequisition(repo,admin,{requestId:'r1',decision:'approved'},'a2')]);assert.equal((await db.doc('regent_v2_inventory/beaker').get()).data().qty,7);});
integration('Firestore: teacher booking and admin recurring slot cannot race past each other',async()=>{await seed();const results=await Promise.allSettled([createRequisition(repo,teacher,request('r1'),'c1'),applyAdminChanges(repo,admin,{changes:[{kind:'scheduleSlots',id:'s1',expectedVersion:0,value:{id:'s1',lab:'Lab 1',period:'Period 1',day:'Sunday',weekDate:'2026-11-22',recurrence:'weekly'}}]},'a1')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'BOOKING_CONFLICT');});
integration('Rules: unauthenticated clients cannot read inventory, legacy documents, or write requests',async()=>{await seed();const client=env.unauthenticatedContext().firestore();await assertFails(getDoc(doc(client,'regent_v2_inventory/beaker')));await assertFails(getDoc(doc(client,'regent_lab_data/main_state')));await assertFails(setDoc(doc(client,'regent_v2_requests/forged'),{teacherUid:'teacher1',status:'approved'}));});
integration('Rules: directory is private even if a backend bug writes extra fields',async()=>{
  await seed();const client=env.unauthenticatedContext().firestore(),signedTeacher=env.authenticatedContext('teacher1',{auth_time:100,sessionVersion:1}).firestore(),signedAdmin=env.authenticatedContext('admin1',{auth_time:100,sessionVersion:1}).firestore();
  await db.doc('regent_v2_directory/teacher1').set({...publicDirectoryEntry(teacher),login:'must-remain-private@demo.invalid',role:'teacher'});
  for(const viewer of [client,signedTeacher]){
    await assertFails(getDoc(doc(viewer,'regent_v2_directory/teacher1')));
    await assertFails(getDocs(query(collection(viewer,'regent_v2_directory'),where('disabled','==',false))));
  }
  await assertSucceeds(getDocs(collection(signedAdmin,'regent_v2_directory')));
});
integration('Rules: teacher can read own requests only and cannot write stock',async()=>{await seed();await createRequisition(repo,teacher,request('r1'),'c1');await createRequisition(repo,{...teacher,uid:'teacher2'},request('r2','2026-11-23'),'c2');const client=env.authenticatedContext('teacher1',{auth_time:100,sessionVersion:1}).firestore();await assertSucceeds(getDoc(doc(client,'regent_v2_requests/r1')));await assertFails(getDoc(doc(client,'regent_v2_requests/r2')));await assertSucceeds(getDocs(query(collection(client,'regent_v2_requests'),where('teacherUid','==','teacher1'))));await assertFails(getDocs(collection(client,'regent_v2_requests')));await assertFails(setDoc(doc(client,'regent_v2_inventory/beaker'),{qty:100}));});
integration('Rules: admin can read all requests but cannot bypass the transaction server',async()=>{await seed();const client=env.authenticatedContext('admin1',{auth_time:100,sessionVersion:1}).firestore();await assertSucceeds(getDocs(collection(client,'regent_v2_requests')));await assertFails(setDoc(doc(client,'regent_v2_inventory/beaker'),{qty:-1}));});
integration('Rules: disabled accounts and pre-reset sessions lose access immediately',async()=>{await seed();const old=env.authenticatedContext('teacher1',{auth_time:100,sessionVersion:1}).firestore();await assertSucceeds(getDoc(doc(old,'regent_v2_inventory/beaker')));await db.doc('regent_v2_accounts/teacher1').update({sessionVersion:2});await assertFails(getDoc(doc(old,'regent_v2_inventory/beaker')));const fresh=env.authenticatedContext('teacher1',{auth_time:101,sessionVersion:2}).firestore();await assertSucceeds(getDoc(doc(fresh,'regent_v2_inventory/beaker')));await db.doc('regent_v2_accounts/teacher1').update({disabled:true});await assertFails(getDoc(doc(fresh,'regent_v2_inventory/beaker')));});

import {restPlatform} from '../rest-platform.mjs';
import {createHandler} from '../http-handler.mjs';
import {createServer} from 'node:http';
const platform=enabled?restPlatform({projectId,apiKey:'local-test-api-key',emulatorFirestore:process.env.FIRESTORE_EMULATOR_HOST,emulatorAuth:process.env.FIREBASE_AUTH_EMULATOR_HOST}):null;
const restRepo=enabled?new FirestoreRepository(platform.db):null;
integration('REST adapter: serialized transactions preserve requests and idempotent stock decisions',async()=>{await seed();await Promise.all([createRequisition(restRepo,teacher,request('rr1'),'rc1'),createRequisition(restRepo,{...teacher,uid:'teacher2'},request('rr2','2026-11-23'),'rc2')]);await Promise.all([decideRequisition(restRepo,admin,{requestId:'rr1',decision:'approved'},'ra1'),decideRequisition(restRepo,admin,{requestId:'rr1',decision:'approved'},'ra2')]);assert.equal((await db.doc('regent_v2_inventory/beaker').get()).data().qty,7);assert.equal((await db.collection('regent_v2_requests').get()).docs.filter(doc=>!doc.data()._meta).length,2);});
integration('REST adapter: recurring-slot race is rejected atomically',async()=>{await seed();const results=await Promise.allSettled([createRequisition(restRepo,teacher,request('rr1'),'rc1'),applyAdminChanges(restRepo,admin,{changes:[{kind:'scheduleSlots',id:'rs1',expectedVersion:0,value:{id:'rs1',lab:'Lab 1',period:'Period 1',day:'Sunday',weekDate:'2026-11-22',recurrence:'weekly'}}]},'ra1')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'BOOKING_CONFLICT');});
integration('Real HTTP/Auth emulator: admin-managed teacher passwords, role checks, revocation, and safe directory',async()=>{
  await seed();
  const auth=getAuth(app);
  try{await auth.deleteUser('admin1');}catch{}
  await auth.createUser({uid:'admin1',email:'admin@demo.invalid',password:'Local-emulator-only-2026',displayName:'Lab Admin'});
  await auth.setCustomUserClaims('admin1',{sessionVersion:1});
  await db.doc('regent_v2_accounts/admin1').update({login:'admin@demo.invalid'});
  await db.doc('regent_v2_directory/admin1').set(publicDirectoryEntry(admin));
  const origin='https://aali-alt.github.io';
  const server=createServer(createHandler({repo:restRepo,auth:platform.auth,allowedOrigin:origin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const login=async(email,password)=>{const res=await fetch('http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST+'/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-test-api-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});const out=await res.json();assert.equal(res.status,200,JSON.stringify(out));return out.idToken;};
  const post=async(path,token,value,command='http1',from=origin)=>{const res=await fetch(base+path,{method:'POST',headers:{Origin:from,'Content-Type':'application/json','X-Command-ID':command,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(value)});return {status:res.status,body:await res.json()};};
  try{
    const adminToken=await login('admin@demo.invalid','Local-emulator-only-2026');
    const adminAlias=await post('/auth/login','',{role:'admin',name:'ADMIN@DEMO.INVALID',password:'Local-emulator-only-2026'});assert.equal(adminAlias.status,200,JSON.stringify(adminAlias.body));assert.deepEqual(Object.keys(adminAlias.body),['token']);
    const missing=await post('/admin/accounts/create','',{name:'Teacher X',password:'Local-teacher-only-2026'});assert.equal(missing.status,401);
    const wrongOrigin=await post('/admin/accounts/create',adminToken,{name:'Teacher X',password:'Local-teacher-only-2026'},'x1','https://wrong.invalid');assert.equal(wrongOrigin.status,403);
    const created=await post('/admin/accounts/create',adminToken,{name:'Teacher X',password:'Local-teacher-only-2026'},'create1');assert.equal(created.status,201,JSON.stringify(created.body));
    const duplicate=await post('/admin/accounts/create',adminToken,{name:'Teacher X',password:'Local-teacher-only-2026'},'create1');assert.equal(duplicate.status,200);assert.equal(duplicate.body.account.uid,created.body.account.uid);
    const sameName=await post('/admin/accounts/create',adminToken,{name:'Teacher X',password:'Local-teacher-only-2026'},'another_create');assert.equal(sameName.status,409);assert.equal(sameName.body.error.code,'DUPLICATE_NAME');
    const {uid,login:email}=created.body.account;
    let teacherToken=await login(email,'Local-teacher-only-2026');
    const denied=await post('/admin/accounts/create',teacherToken,{name:'Teacher Y',password:'Local-teacher-only-2026'},'create2');assert.equal(denied.status,403);
    const reset=await post('/admin/accounts/password',adminToken,{uid,password:'Local-replacement-only-2026'},'reset1');assert.equal(reset.status,200,JSON.stringify(reset.body));
    const sameReset=await post('/admin/accounts/password',adminToken,{uid,password:'Local-replacement-only-2026'},'reset1');assert.equal(sameReset.status,200);assert.equal(sameReset.body.alreadyApplied,true);
    const oldSession=await fetch(base+'/me',{headers:{Authorization:'Bearer '+teacherToken}});assert.equal(oldSession.status,401);
    teacherToken=await login(email,'Local-replacement-only-2026');
    const newSession=await fetch(base+'/me',{headers:{Authorization:'Bearer '+teacherToken}});assert.equal(newSession.status,200);
    const directory=await(await fetch(base+'/directory')).json();const entry=directory.accounts.find(a=>a.selector===uid);assert.deepEqual(Object.keys(entry).sort(),['name','selector']);
    const publicRow=(await db.doc('regent_v2_directory/'+uid).get()).data();assert.deepEqual(Object.keys(publicRow).sort(),['disabled','name','selector']);
    const adminDirectory=await fetch(base+'/admin/directory',{headers:{Authorization:'Bearer '+adminToken}});assert.equal(adminDirectory.status,200);assert.ok((await adminDirectory.json()).accounts.some(row=>row.uid===uid&&row.login===email));
    const teacherDirectory=await fetch(base+'/admin/directory',{headers:{Authorization:'Bearer '+teacherToken}});assert.equal(teacherDirectory.status,403);
    const wrongPassword=await post('/auth/login','',{role:'teacher',name:'Teacher X',selector:uid,password:'Not-the-password'});assert.equal(wrongPassword.status,401);
    const wrongRole=await post('/auth/login','',{role:'admin',name:'Teacher X',selector:uid,password:'Local-replacement-only-2026'});assert.equal(wrongRole.status,401);
    const brokered=await post('/auth/login','',{role:'teacher',name:'Teacher X',selector:uid,password:'Local-replacement-only-2026'});assert.equal(brokered.status,200,JSON.stringify(brokered.body));assert.deepEqual(Object.keys(brokered.body),['token']);
    const customExchange=await fetch('http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST+'/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=local-test-api-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:brokered.body.token,returnSecureToken:true})});assert.equal(customExchange.status,200);const customSession=await customExchange.json();
    const brokeredProfile=await fetch(base+'/me',{headers:{Authorization:'Bearer '+customSession.idToken}});assert.equal(brokeredProfile.status,200);assert.equal((await brokeredProfile.json()).account.role,'teacher');
    const beforeMinimize=(await db.doc('regent_v2_accounts/'+uid).get()).data();
    await db.doc('regent_v2_directory/orphan_test').set({uid:'orphan_test',name:'Orphan test',role:'admin',login:'orphan@demo.invalid',disabled:false});
    const minimized=await post('/admin/directory/minimize',adminToken,{},'minimize1');assert.equal(minimized.status,200,JSON.stringify(minimized.body));assert.equal(minimized.body.accountsUnchanged,true);
    assert.deepEqual((await db.doc('regent_v2_accounts/'+uid).get()).data(),beforeMinimize);
    for(const doc of (await db.collection('regent_v2_directory').get()).docs)assert.deepEqual(Object.keys(doc.data()).sort(),['disabled','name','selector']);
    assert.equal((await db.doc('regent_v2_directory/orphan_test').get()).data().disabled,true);

    const profile=(await db.doc('regent_v2_accounts/'+uid).get()).data();assert.equal('password'in profile,false);
    const disabled=await post('/admin/accounts/disable',adminToken,{uid},'disable1');assert.equal(disabled.status,200);
    const disabledSession=await fetch(base+'/me',{headers:{Authorization:'Bearer '+teacherToken}});assert.ok([401,403].includes(disabledSession.status));
    const selfReset=await post('/admin/self',adminToken,{name:'New admin label',password:'Local-admin-replacement-2026'},'self1');assert.equal(selfReset.status,200,JSON.stringify(selfReset.body));
    const freshAdminToken=await login('admin@demo.invalid','Local-admin-replacement-2026');const freshAdminSession=await fetch(base+'/me',{headers:{Authorization:'Bearer '+freshAdminToken}});assert.equal(freshAdminSession.status,200);assert.equal((await freshAdminSession.json()).account.name,'New admin label');
  }finally{await new Promise(resolve=>server.close(resolve));}
});

integration('Firestore: full restore and ordinary write cannot half-overlap, and retry returns once',async()=>{
  await seed();
  const kinds=['inventory','cabinets','requests','scheduleSlots','loans','lossRecords','logs'];
  const stamp=async()=>{const state={settings:(await db.doc('regent_v2_settings/main').get()).data()||{}};for(const kind of kinds)state[kind]=(await db.collection('regent_v2_'+kind).get()).docs.map(doc=>doc.data()).filter(row=>!row._meta);return JSON.stringify({epoch:state.settings.restoreEpoch||0,settings:state.settings.version||0,rows:kinds.map(kind=>[kind,state[kind].map(row=>[String(row.id),row.version||0,row._revision||0]).sort((a,b)=>a[0].localeCompare(b[0]))])});};
  const data={settings:{labs:['Lab 1'],periods:['Period 1']},inventory:[{id:'beaker',nameEn:'Restored Beaker',qty:10,version:1}],cabinets:[],requests:[{id:'restore-request',status:'pending',usageMode:'outside-lab',date:'2026-11-22',teacherName:'Teacher One',items:[{itemId:'beaker',qty:1}]}],scheduleSlots:[],loans:[],lossRecords:[],logs:[{id:'backup-history',note:'Imported history'}]};
  const before=await stamp();
  await assert.rejects(()=>restoreDataset(repo,admin,{data,expectedStamp:before+'-stale'},'stale-precheck'),{code:'STALE_RESTORE'});
  const outcomes=await Promise.allSettled([restoreDataset(repo,admin,{data,expectedStamp:before},'realrestore1'),applyAdminChanges(repo,admin,{changes:[{kind:'inventory',id:'beaker',expectedVersion:1,value:{id:'beaker',nameEn:'Concurrent edit',qty:8}}]},'race1')]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await db.doc('regent_v2_inventory/beaker').get()).data().qty,10);
  assert.ok((await db.doc('regent_v2_meta/mutationClock').get()).data().version>=1);
  const expected=await stamp();
  const restored=await restoreDataset(repo,admin,{data,expectedStamp:expected},'realrestore2');
  const retry=await restoreDataset(repo,admin,{data,expectedStamp:expected},'realrestore2');
  assert.equal(retry.restored,true);assert.equal(retry.restoreEpoch,restored.restoreEpoch);
  const beforeSecond=await stamp();await assert.rejects(()=>restoreDataset(repo,admin,{data,expectedStamp:beforeSecond+'-stale'},'stale1'),{code:'STALE_RESTORE'});
  await assert.rejects(()=>applyAdminChanges(repo.withEpoch(restored.restoreEpoch-1),admin,{changes:[{kind:'inventory',id:'beaker',expectedVersion:2,value:{id:'beaker',nameEn:'Old form',qty:9}}]},'oldform1'),{code:'STALE_DATASET'});
  const teacherAccount=(await db.doc('regent_v2_accounts/teacher1').get()).data();assert.equal(teacherAccount.role,'teacher');assert.equal('password'in teacherAccount,false);
  assert.equal((await db.doc('regent_v2_requests/restore-request').get()).data().teacherUid,'teacher1');
});
