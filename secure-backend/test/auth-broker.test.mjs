import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignInBroker,createPasswordVerifier,publicDirectoryEntry} from '../auth-broker.mjs';
function fixture(){
  const rows=new Map(),profile={uid:'opaque_teacher_1',role:'teacher',name:'Teacher One',login:'private@fixture.invalid',sessionVersion:2,disabled:false};
  rows.set('accounts/'+profile.uid,profile);
  const snap=key=>({exists:rows.has(key),data:()=>structuredClone(rows.get(key))});
  const collection=kind=>({doc:uid=>({key:kind+'/'+uid,async get(){return snap(this.key);}}),where:(field,op,value)=>({async get(){return {docs:[...rows].filter(([key,row])=>key.startsWith(kind+'/')&&row[field]===value).map(([key])=>snap(key))};}})});
  let chain=Promise.resolve();
  const repo={collection,db:{runTransaction(fn){const run=chain.then(()=>fn({get:ref=>ref.get(),set:(ref,value)=>rows.set(ref.key,structuredClone(value))}));chain=run.catch(()=>{});return run;}}};
  let verifyCalls=0;
  const auth={getUser:async()=>({disabled:false}),createCustomToken:async(uid,claims)=>'fixture-token:'+uid+':'+claims.sessionVersion};
  const passwordVerifier=async(email,password)=>{verifyCalls++;assert.equal(email,profile.login);if(password!=='fixture-password')throw Error('Provider detail must not leak');return profile.uid;};
  const broker=createSignInBroker({repo,auth,passwordVerifier}),input={role:'teacher',name:profile.name,selector:profile.uid,password:'fixture-password'};
  return {rows,profile,repo,auth,broker,input,get verifyCalls(){return verifyCalls;}};
}
test('public directory has only display name, opaque selector and enabled metadata',()=>{assert.deepEqual(publicDirectoryEntry({uid:'opaque',name:'Teacher',role:'teacher',login:'private',disabled:false}),{name:'Teacher',selector:'opaque',disabled:false});assert.equal(publicDirectoryEntry({uid:'admin',name:'Private Admin',role:'admin'}).disabled,true);});
test('broker verifies private login then mints only matching scoped session',async()=>{const f=fixture();assert.deepEqual(await f.broker(f.input),{token:'fixture-token:opaque_teacher_1:2'});assert.equal(f.verifyCalls,1);});
test('selector/name/role mismatch, disabled and unknown profiles never reach password provider',async()=>{for(const change of [{selector:'unknown'},{name:'Other Teacher'},{role:'admin'},{selector:'../bad'}]){const f=fixture();await assert.rejects(f.broker({...f.input,...change}),{code:'SIGN_IN_FAILED'});assert.equal(f.verifyCalls,0);}const f=fixture();f.profile.disabled=true;await assert.rejects(f.broker(f.input),{code:'SIGN_IN_FAILED'});assert.equal(f.verifyCalls,0);});
test('server refuses provider UID mismatch and racing account disable/session change',async()=>{for(const action of ['uid','disabled','version']){const f=fixture();const broker=createSignInBroker({repo:f.repo,auth:f.auth,passwordVerifier:async()=>{if(action==='uid')return 'different_uid';if(action==='disabled')f.profile.disabled=true;if(action==='version')f.profile.sessionVersion++;return f.input.selector;}});await assert.rejects(broker(f.input),{code:'SIGN_IN_FAILED'});}});
test('persistent throttle caps concurrent password checks at ten per account/window',async()=>{const f=fixture();const results=await Promise.allSettled(Array.from({length:12},()=>f.broker(f.input)));assert.equal(results.filter(r=>r.status==='fulfilled').length,10);assert.equal(results.filter(r=>r.reason?.code==='SIGN_IN_LIMIT').length,2);assert.equal(f.verifyCalls,10);assert.equal([...f.rows.keys()].filter(key=>key.startsWith('authThrottle/')).length,1);});
test('unknown attempts never create throttle records or expose provider detail',async()=>{const f=fixture();for(let i=0;i<5;i++)await assert.rejects(f.broker({...f.input,selector:'unknown_'+i}),{code:'SIGN_IN_FAILED'});assert.equal(f.rows.size,1);await assert.rejects(f.broker({...f.input,password:'wrong'}),error=>error.code==='AUTH_UNAVAILABLE'&&!error.message.includes('Provider detail'));});
test('emulator verifier rejects non-demo or remote credential destinations',()=>{assert.throws(()=>createPasswordVerifier({apiKey:'fixture',projectId:'real-project',emulatorHost:'127.0.0.1:9099'}));assert.throws(()=>createPasswordVerifier({apiKey:'fixture',projectId:'demo-test',emulatorHost:'remote.invalid:9099'}));});
