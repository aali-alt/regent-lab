import {publicDirectoryEntry,createPasswordVerifier} from './auth-broker.mjs';
// Isolated synthetic integration runner. Never deploy this entry point for school data.
import probe from './pilot-worker.mjs';
import {pilotConfig,pilotAdminUid} from './pilot-config.mjs';
import {restPlatform} from './rest-platform.mjs';
import {FirestoreRepository} from './firebase-repository.mjs';
import {createHandler} from './http-handler.mjs';
import {createRequisition,decideRequisition,applyAdminChanges,id} from './domain.mjs';
import {base64Url,signRs256} from './portable-crypto.mjs';
import ui from './pilot-ui.html';
import fixture from './pilot-fixture.json';
import {restoreDataset} from './restore.mjs';
import {datasetKinds,datasetStamp} from '../restore-contract.mjs';
const PROJECT='regent-lab-pilot',ORIGIN='https://regent-lab-backend-pilot.pages.dev',TEACHER='synthetic_pilot_teacher';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
let cache;
export function guardedPlatform(env){
  const credential=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT||'null');
  if(pilotConfig.projectId!==PROJECT||(env.FIREBASE_PROJECT_ID&&env.FIREBASE_PROJECT_ID!==PROJECT)||credential?.project_id!==PROJECT||!credential.client_email?.endsWith('@'+PROJECT+'.iam.gserviceaccount.com'))throw Error('Pilot target refused');
  return {platform:restPlatform({projectId:PROJECT,apiKey:pilotConfig.apiKey,serviceAccount:credential}),credential};
}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
async function adapt(request,handler){
  const outHeaders={};let status=200,body='';
  const response={setHeader:(k,v)=>{outHeaders[k]=v;},set statusCode(v){status=v;},get statusCode(){return status;},end:v=>{body=v||'';}};
  const adapted={method:request.method,url:request.url,headers:Object.fromEntries(request.headers),async *[Symbol.asyncIterator](){if(request.body){const reader=request.body.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;yield value;}}finally{reader.releaseLock();}}}};
  await handler(adapted,response);return new Response(status===204?null:body,{status,headers:outHeaders});
}
async function actor(request,platform,repo,{bootstrap=false}={}){
  const token=/^Bearer ([^ ]+)$/.exec(request.headers.get('authorization')||'')?.[1];
  if(!token)throw Object.assign(Error('Sign in first'),{status:401});
  const decoded=await platform.auth.verifyIdToken(token,true);
  if(decoded.uid!==pilotAdminUid)throw Object.assign(Error('Pilot administrator required'),{status:403});
  if(bootstrap){if(decoded.email!=='synthetic-admin@regent-lab-pilot.invalid'||Date.now()/1000-decoded.auth_time>300)throw Object.assign(Error('Sign in again'),{status:401});return decoded;}
  const snap=await repo.collection('accounts').doc(decoded.uid).get(),profile=snap.data();
  if(!snap.exists||profile.disabled||profile.role!=='admin'||decoded.sessionVersion!==profile.sessionVersion)throw Object.assign(Error('Pilot administrator required'),{status:403});
  return profile;
}
async function bootstrap(platform,repo,decoded){
  const ref=repo.collection('accounts').doc(pilotAdminUid);
  const existing=await ref.get();
  if(existing.exists){const profile=existing.data();if(profile.role!=='admin'||profile.uid!==pilotAdminUid)throw Error('Bootstrap profile conflict');return {initialized:true,alreadyApplied:true,refreshToken:true};}
  const user=await platform.auth.getUser(pilotAdminUid);
  await platform.auth.setCustomUserClaims(pilotAdminUid,{...user.customClaims,sessionVersion:1});
  const profile={uid:pilotAdminUid,name:'Synthetic Administrator',login:decoded.email,role:'admin',disabled:false,validAfter:0,sessionVersion:1,version:1};
  await repo.db.runTransaction(async tx=>{
    const current=await tx.get(ref),settings=await tx.get(repo.collection('settings').doc('main'));
    if(current.exists)throw Error('Bootstrap already changed');
    tx.set(ref,profile);tx.set(repo.collection('directory').doc(pilotAdminUid),publicDirectoryEntry(profile));
    if(!settings.exists)tx.set(repo.collection('settings').doc('main'),{labs:['Synthetic Lab'],periods:['Period 1'],version:1});
  });
  return {initialized:true,refreshToken:true};
}
async function step(platform,repo,admin,input){
  const run=id(input.runId),teacher={uid:TEACHER,name:'Synthetic Teacher',role:'teacher'},prefix='pilot_'+run,reqId=prefix+'_request';
  if(input.step==='ui-setup'){
    const current={};for(const kind of datasetKinds)current[kind]=await repo.transaction(tx=>tx.list(kind));current.settings=(await repo.collection('settings').doc('main').get()).data()||{};
    const result=await restoreDataset(repo,admin,{data:fixture,expectedStamp:datasetStamp(current)},prefix+'_ui_setup');
    return {check:'Synthetic full UI fixture restored with protected accounts kept',passed:result.restored,restoreEpoch:result.restoreEpoch};
  }
  if(input.step==='concurrency'){
    const item=prefix+'_race_item';await repo.db.runTransaction(async tx=>{tx.set(repo.collection('inventory').doc(item),{id:item,nameEn:'Synthetic race fixture',qty:10,unit:'pcs',version:1});});
    const request=(n)=>({id:prefix+'_race_'+n,usageMode:'outside-lab',date:'2026-11-22',period:'Period 1',experiment:'Hosted concurrent approval',grade:'Synthetic Grade',subject:'Science',items:[{itemId:item,qty:7}]});
    await Promise.all([createRequisition(repo,teacher,request(1),prefix+'_rc1'),createRequisition(repo,teacher,request(2),prefix+'_rc2')]);
    const results=await Promise.allSettled([decideRequisition(repo,admin,{requestId:request(1).id,decision:'approved'},prefix+'_ra1'),decideRequisition(repo,admin,{requestId:request(2).id,decision:'approved'},prefix+'_ra2')]);
    const qty=(await repo.collection('inventory').doc(item).get()).data().qty;
    if(results.filter(r=>r.status==='fulfilled').length!==1||qty!==3)throw Error('Hosted concurrency invariant failed');
    return {check:'Concurrent hosted approvals: exactly one wins, stock stays 3',passed:true,stock:qty};
  }
  if(input.step==='seed'){
    const marker=repo.collection('pilotRuns').doc(run),previous=await marker.get();
    if(previous.exists)return {check:'Synthetic seed exists',passed:true,alreadyApplied:true};
    try{await platform.auth.getUser(TEACHER);}catch{await platform.auth.createUser({uid:TEACHER,email:'synthetic-teacher@regent-lab-pilot.invalid',displayName:teacher.name,disabled:false});}
    await platform.auth.setCustomUserClaims(TEACHER,{sessionVersion:1});
    await repo.db.runTransaction(async tx=>{
      const old=await tx.get(marker);if(old.exists)return;
      for(let i=0;i<100;i++)tx.set(repo.collection('inventory').doc(prefix+'_item_'+i),{id:prefix+'_item_'+i,nameEn:'Synthetic Item '+i,qty:10,unit:'pcs',version:1});
      tx.set(repo.collection('accounts').doc(TEACHER),{...teacher,login:'synthetic-teacher@regent-lab-pilot.invalid',disabled:false,validAfter:0,sessionVersion:1,version:1});
      tx.set(repo.collection('directory').doc(TEACHER),publicDirectoryEntry(teacher));
      tx.set(marker,{id:run,createdAt:repo.now(),syntheticOnly:true});
    });
    return {check:'100 synthetic inventory records seeded atomically',passed:true};
  }
  if(input.step==='submit'){
    const result=await createRequisition(repo,teacher,{id:reqId,usageMode:'outside-lab',date:'2026-11-22',period:'Period 1',experiment:'Hosted synthetic integration test',grade:'Synthetic Grade',subject:'Science',items:Array.from({length:100},(_,i)=>({itemId:prefix+'_item_'+i,qty:3}))},prefix+'_create');
    if(result.request.teacherUid!==TEACHER)throw Error('Identity binding failed');
    return {check:'100-item request stored with teacher UID',passed:true};
  }
  if(['approve','retry'].includes(input.step)){
    const result=await decideRequisition(repo,admin,{requestId:reqId,decision:'approved'},prefix+'_'+input.step);
    const [item,loans]=await Promise.all([repo.collection('inventory').doc(prefix+'_item_99').get(),repo.collection('loans').where('requestId','==',reqId).get()]);
    if(item.data()?.qty!==7||loans.docs.length!==100)throw Error('Atomic stock or loan count failed');
    return {check:input.step==='retry'?'Repeated approval does not deduct twice':'100-item approval and 100 loans persisted',passed:true,stock:7,loans:100,alreadyApplied:!!result.alreadyApplied};
  }
  if(input.step==='teacher-denied'){
    try{await applyAdminChanges(repo,teacher,{changes:[]},prefix+'_denied');throw Error('Teacher permission check failed');}catch(err){if(err.code!=='FORBIDDEN')throw err;}
    return {check:'Domain rejects teacher administrator writes',passed:true};
  }
  throw Object.assign(Error('Unknown test step'),{status:400});
}
export default {async fetch(request,env){
  const path=new URL(request.url).pathname;
  try{
    if(path.startsWith('/review/'))return env.ASSETS.fetch(request);
    if(path==='/pilot/self-test')return probe.fetch(request);
    if(path==='/')return new Response(ui.replace('__PILOT_CONFIG__',JSON.stringify(pilotConfig)),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'}});
    if(!cache){const {platform,credential}=guardedPlatform(env),repo=new FirestoreRepository(platform.db);cache={platform,repo,credential,handler:createHandler({repo,auth:platform.auth,allowedOrigin:ORIGIN})};}
    const {platform,repo,credential,handler}=cache;
    if(path.startsWith('/pilot/')){
      if(request.method!=='POST')return json({error:'POST required'},405);
      if(request.headers.get('origin')!==ORIGIN)return json({error:'Origin refused'},403);
      if(path==='/pilot/bootstrap')return json(await bootstrap(platform,repo,await actor(request,platform,repo,{bootstrap:true})));
      const admin=await actor(request,platform,repo);
      if(path==='/pilot/tests'){
        if(Number(request.headers.get('content-length'))>4096)return json({error:'Too large'},413);
        return json(await step(platform,repo,admin,await request.json()));
      }
      if(path==='/pilot/teacher-token'){
        const now=Math.floor(Date.now()/1000),unsigned=base64Url(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+base64Url(JSON.stringify({iss:credential.client_email,sub:credential.client_email,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:now,exp:now+300,uid:TEACHER,claims:{sessionVersion:1}}));
        return json({token:unsigned+'.'+await signRs256(unsigned,credential.private_key)});
      }
      return json({error:'Not found'},404);
    }
    return await adapt(request,handler);
  }catch(err){return json({error:{code:'PILOT_OPERATION_FAILED',message:'Pilot operation did not complete. No school project is permitted.'}},err.status||503);}
}};
