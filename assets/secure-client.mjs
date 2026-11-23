import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {getAuth,signInWithCustomToken,signOut,onAuthStateChanged,setPersistence,browserSessionPersistence,connectAuthEmulator} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {getFirestore,collection,doc,query,where,onSnapshot,getDoc,getDocs,connectFirestoreEmulator} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
const kinds=['inventory','cabinets','requests','scheduleSlots','loans','lossRecords','logs'];
export function applyServerRows(rows,snapshot,account){
  const heads=[],data=[];for(const row of rows)(row._meta?heads:data).push(row);
  const latest=Math.max(0,...data.map(row=>row._revision||0),...heads.map(row=>row._revision||0));
  const head=Math.max(0,...heads.filter(row=>account?.role==='admin'||!row.teacherUid||row.teacherUid===account?.uid).map(row=>row._revision||0));
  const previous={...(snapshot?.meta||{})};if(latest<head)return {rows:previous.rows||[],meta:previous};
  // Keep _revision on rows: the restore stamp must match the server's per-row revision clock.
  return {rows:data,meta:{rows:data,lastRevision:latest,acceptedRevision:latest}};
}
const strip=value=>{
  if(Array.isArray(value))return value.map(strip);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|credential|secret|private.?key|auth.?token/i.test(k)&&!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,strip(v)]));
  return value;
};
const comparable=value=>JSON.stringify(strip(value), (key,val)=>['updatedAt','version','_revision','teachers','adminUsername'].includes(key)?undefined:val);
const datasetKinds=kinds;
function datasetStamp(state){return JSON.stringify({epoch:state.settings?.restoreEpoch||0,settings:state.settings?.version||0,rows:datasetKinds.map(kind=>[kind,(state[kind]||[]).filter(row=>!row._meta).map(row=>[String(row.id),row.version||0,row._revision||0]).sort((a,b)=>a[0].localeCompare(b[0]))])});}
export function createSecureClient({firebaseConfig,backendUrl,onState,onAccount,onDirectory,onStatus,testEmulators}){
  const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
  if(testEmulators){
    if(!firebaseConfig.projectId.startsWith('demo-')||!['127.0.0.1','localhost'].includes(location.hostname))throw Error('Emulators are local-only');
    connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFirestoreEmulator(db,'127.0.0.1',8081);
  }
  let resolveDirectory;const directoryLoaded=new Promise(resolve=>{resolveDirectory=resolve;});
  let account=null,directory=[],publicDirectory=[],unsubscribers=[],snapshot=null,ready=false,paused=0,loginWaiters=[],epoch=0,refreshTimer=null;
  const endpoint=backendUrl?new URL(backendUrl):null;
  if(endpoint&&endpoint.protocol!=='https:'&&!(testEmulators&&endpoint.hostname==='127.0.0.1'))throw Error('Secure backend requires HTTPS');
  async function call(path,value,commandId=crypto.randomUUID()){
    if(!endpoint)throw Error('Secure service setup is incomplete. This review build cannot save to the cloud yet.');
    // Carry the dataset generation with every mutation, including teacher actions after a restore.
    if(value!==undefined&&!Object.hasOwn(value,'epoch'))value={...value,epoch};
    const token=auth.currentUser?await auth.currentUser.getIdToken():'';
    const response=await fetch(new URL(path,endpoint),{method:value===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(value===undefined?{}:{'Content-Type':'application/json','X-Command-ID':commandId})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(!response.ok){const err=new Error(result.error?.message||'Could not confirm this action');err.code=result.error?.code;throw err;}return result;
  }
  const pendingIntents=new Map(),editVersions=new Map();
  async function intentCall(path,value){
    const key=path+JSON.stringify(value);let intent=pendingIntents.get(key);
    if(intent?.running)return intent.running;
    if(!intent){intent={commandId:crypto.randomUUID()};pendingIntents.set(key,intent);}
    intent.running=call(path,value,intent.commandId).then(result=>{pendingIntents.delete(key);return result;}).catch(err=>{intent.running=null;if(err.code&&err.code!=='SERVICE_UNAVAILABLE')pendingIntents.delete(key);throw err;});
    return intent.running;
  }
  const withDirectory=state=>({...state,settings:{...state.settings,adminUsername:account?.role==='admin'?account.name:'admin',teachers:directory.filter(a=>a.role==='teacher')}});
  const publish=()=>{if(ready&&!paused)onState(withDirectory(structuredClone(snapshot)));};
  const unsubscribe=()=>{unsubscribers.forEach(fn=>fn());unsubscribers=[];ready=false;snapshot=null;};
  const rejectLogin=err=>{for(const waiter of loginWaiters)waiter.reject(err);loginWaiters=[];};
  async function refreshDirectory(){
    if(account?.role==='admin'){const expectedAccount=account,result=await call('/admin/directory');if(account!==expectedAccount||account?.role!=='admin')return;directory=result.accounts;}
    else directory=structuredClone(publicDirectory);
    onDirectory(directory);publish();
  }
  function watchSession(profile){
    unsubscribe();account=profile;onAccount(profile);refreshDirectory().catch(()=>onStatus('Account list could not refresh'));
    const watched=profile.role==='admin'?kinds:['requests','scheduleSlots','loans'];
    const pending=new Set([...watched,'settings']);snapshot=Object.fromEntries(kinds.map(k=>[k,[]]));snapshot.settings={};snapshot.meta={};
    const receive=kind=>snap=>{
      if(kind==='settings'){
        if(!snap.exists()){ready=false;onStatus('Secure setup incomplete: settings have not been imported');return;}
        const nextSettings=strip(snap.data());if(epoch&&nextSettings.restoreEpoch!==epoch){epoch=nextSettings.restoreEpoch||0;pendingIntents.clear();clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(account)watchSession(account);},100);return;}epoch=nextSettings.restoreEpoch||0;
        snapshot.settings=nextSettings;
      }else if(kind!=='settings'){const update=applyServerRows(snap.docs.map(doc=>strip(doc.data())),snapshot,account);snapshot[kind]=update.rows;snapshot.meta[kind]=update.meta;snapshot[kind].sort((a,b)=>String(b.updatedAt||b.submittedAt||b.issuedAt||'').localeCompare(String(a.updatedAt||a.submittedAt||a.issuedAt||'')));}
      pending.delete(kind);
      if(pending.size===0){ready=true;publish();onStatus('Secure live sync active');for(const waiter of loginWaiters)waiter.resolve(profile);loginWaiters=[];}
    };
    const failed=err=>{ready=false;onStatus('Cloud read failed. Changes are not confirmed.');rejectLogin(err);};
    for(const kind of watched){
      let ref=collection(db,'regent_v2_'+kind);
      if(profile.role!=='admin'&&['requests','loans'].includes(kind))ref=query(ref,where('teacherUid','==',profile.uid));
      unsubscribers.push(onSnapshot(ref,receive(kind),failed));
    }
    unsubscribers.push(onSnapshot(doc(db,'regent_v2_settings','main'),receive('settings'),failed));
    if(profile.role==='admin')unsubscribers.push(onSnapshot(collection(db,'regent_v2_directory'),()=>refreshDirectory().catch(()=>onStatus('Account list could not refresh')),failed));
  }
  let disposed=false;
  const directoryStop=()=>{disposed=true;};
  async function loadPublicDirectory(){
    const result=await call('/directory');if(disposed)return;
    publicDirectory=result.accounts.map(row=>({name:row.name,selector:row.selector,role:'teacher'}));
    resolveDirectory();await refreshDirectory();
  }
  loadPublicDirectory().catch(()=>onStatus('Secure sign-in setup required'));
  const authStop=onAuthStateChanged(auth,async user=>{
    unsubscribe();account=null;pendingIntents.clear();editVersions.clear();onAccount(null);directory=structuredClone(publicDirectory);onDirectory(directory);
    if(!user){loadPublicDirectory().catch(()=>onStatus('Account list could not refresh'));onStatus('Sign in for secure cloud access');return;}
    try{const {account:profile}=await call('/me');watchSession(profile);}catch(err){onStatus(err.message);rejectLogin(err);await signOut(auth);}
  });
  return {
    get account(){return account;},get ready(){return ready;},get directory(){return structuredClone(directory);},get snapshot(){return snapshot?withDirectory(structuredClone(snapshot)):null;},
    async login(name,password,role){
      if(!endpoint)throw Error('Secure sign-in is not configured on this review build yet.');
      await Promise.race([directoryLoaded,new Promise((_,reject)=>setTimeout(()=>reject(Error('Account list is not available yet. Please retry.')),10000))]);
      const entry=publicDirectory.find(a=>a.name===name);
      if(role==='teacher'&&!entry)throw Error('Choose an enabled account and check the password.');
      await setPersistence(auth,browserSessionPersistence);
      const completion=new Promise((resolve,reject)=>{const waiter={resolve,reject};loginWaiters.push(waiter);setTimeout(()=>{const index=loginWaiters.indexOf(waiter);if(index>=0){loginWaiters.splice(index,1);reject(Error('Cloud sign-in setup did not finish. Please retry.'));}},25000);});
      try{const result=await call('/auth/login',{name,password,role,...(role==='teacher'?{selector:entry.selector}:{})});await signInWithCustomToken(auth,result.token);}catch(err){rejectLogin(Error(err.code==='SIGN_IN_LIMIT'?err.message:'Sign-in failed. Check the account and password.'));}
      return completion;
    },
    async logout(){unsubscribe();account=null;pendingIntents.clear();editVersions.clear();onAccount(null);await signOut(auth);},
    beginEdit(kind,id,{ifAbsent=false}={}){if(!ready||!id)return;const key=kind+'/'+id;if(ifAbsent&&editVersions.has(key))return;const value=kind==='settings'?snapshot.settings:snapshot[kind]?.find(row=>row.id===id);editVersions.set(key,value?.version||0);},
    endEdit(kind,id){editVersions.delete(kind+'/'+id);},
    async backendInfo(){return call('/info');},
    async refresh(){if(!auth.currentUser||!account){await loadPublicDirectory();return true;}const {account:profile}=await call('/me');watchSession(profile);return true;},
    async save(desired){
      if(!ready||account?.role!=='admin')throw Error('An active administrator session is required to save.');
      const base=structuredClone(snapshot),changes=[];
      for(const kind of kinds){
        if(['requests','loans'].includes(kind))continue;
        const before=new Map((base[kind]||[]).map(row=>[row.id,row])),after=new Map((desired[kind]||[]).map(row=>[row.id,row]));
        for(const [id,value]of after){const old=before.get(id);if(!old||comparable(old)!==comparable(value))changes.push({kind,id,expectedVersion:editVersions.get(kind+'/'+id)??old?.version??0,value:strip(value)});}
        for(const [id,value]of before){if(!after.has(id)&&kind!=='logs')changes.push({kind,id,expectedVersion:editVersions.get(kind+'/'+id)??value.version??0,delete:true});}
      }
      if(comparable(base.settings)!==comparable(desired.settings)){
        const settings=strip(desired.settings);delete settings.teachers;delete settings.adminUsername;
        changes.push({kind:'settings',id:'main',expectedVersion:editVersions.get('settings/main')??base.settings.version??0,value:settings});
      }
      if(changes.length===0)return;
      paused++;
      try{const result=await intentCall('/admin/changes',{epoch,changes});
        // Merge the authoritative transaction result immediately; do not wait for a stale listener event.
        for(const change of result.changes){if(change.kind==='settings')snapshot.settings=change.value;else{const rows=snapshot[change.kind];const index=rows.findIndex(r=>r.id===change.key);if(change.delete){if(index>=0)rows.splice(index,1);}else if(index>=0){if((rows[index].version||0)<=(change.value.version||0))rows[index]=change.value;}else rows.unshift(change.value);}}
        for(const change of result.changes)editVersions.delete(change.kind+'/'+change.key);
      }catch(err){if(err.code==='STALE_DATASET')err.message='Cloud data was restored after this form opened. Close it and review the latest data before saving.';
        if(err.code==='STALE_WRITE')err.message='This form is out of date. Close it and open it again before saving.';throw err;}finally{paused--;publish();}
    },
    async submitRequest(value,commandId){if(!ready||!account)throw Error('Sign in and wait for cloud sync first');return call('/requests',value,commandId);},
    async decideRequest(requestId,decision,batchChoices,dispense){const body={requestId,decision};if(batchChoices&&batchChoices.length)body.batchChoices=batchChoices;if(dispense&&dispense.length)body.dispense=dispense;return call('/requests/decide',body);},
    async amendBooking(requestId,slot){return call('/requests/amend',{requestId,...slot});},async cancelRequest(requestId,reason){return call('/requests/cancel',{requestId,reason});},
    async reverseRequest(requestId,reason){return call('/requests/reverse',{requestId,reason});},
    async createSnapshot(){if(!ready||account?.role!=='admin')throw Error('Sign in as administrator and wait for cloud sync first');return intentCall('/admin/snapshots/create',{});},
    async listSnapshots(){if(!ready||account?.role!=='admin')throw Error('Sign in as administrator and wait for cloud sync first');return call('/admin/snapshots');},
    async restoreSnapshot(snapshotId){if(!ready||account?.role!=='admin')throw Error('Sign in as administrator and wait for cloud sync first');const result=await call('/admin/snapshots/restore',{snapshotId,expectedStamp:datasetStamp(snapshot),epoch});editVersions.clear();pendingIntents.clear();unsubscribe();watchSession(account);return result;},
    async issueLoan(value){return intentCall('/loans/issue',value);},async returnLoan(loanId){return call('/loans/return',{loanId});},
    async recordLoss(value){return intentCall('/losses',value);},
    async getRestoreStamp(){if(!ready||account?.role!=='admin')throw Error('Sign in as administrator and wait for cloud sync first');const [directoryDocs,nameDocs]=await Promise.all([getDocs(collection(db,'regent_v2_accounts')),getDocs(collection(db,'regent_v2_accountNames'))]);return {accounts:directoryDocs.docs.map(doc=>strip(doc.data())),nameKeys:nameDocs.docs.map(doc=>({id:doc.id,...strip(doc.data())}))};},
    async updateAdmin(name,password){const result=await intentCall('/admin/self',{name,password});if(result.signInAgain)await signOut(auth);return result;},
    async restore(data){if(!ready||account?.role!=='admin')throw Error('Sign in as administrator and wait for cloud sync first');const result=await call('/admin/restore',{data,expectedStamp:datasetStamp(snapshot),epoch});editVersions.clear();pendingIntents.clear();unsubscribe();watchSession(account);return result;},
    async createTeacher(name,password){return intentCall('/admin/accounts/create',{name,password});},
    async resetTeacher(uid,password){return intentCall('/admin/accounts/password',{uid,password});},
    async disableTeacher(uid){return call('/admin/accounts/disable',{uid});},
    dispose(){unsubscribe();directoryStop();authStop();}
  };
}
