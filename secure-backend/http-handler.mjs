import {createSignInBroker,publicDirectoryEntry} from './auth-broker.mjs';
import {AppError,assertActor,createRequisition,decideRequisition,applyAdminChanges,issueManualLoan,returnLoan,recordLoss,id,text} from './domain.mjs';
import {restoreDataset} from './restore.mjs';
import {sha256Hex} from './portable-crypto.mjs';
const error=(status,code,message)=>{throw new AppError(status,code,message);};
export function createHandler({repo,auth,allowedOrigin,allowLocalDevelopment=false,passwordVerifier=auth.passwordSignIn?.bind(auth)}) {
  if(!allowedOrigin||!(/^https:\/\//.test(allowedOrigin)||(allowLocalDevelopment&&auth.app.options.projectId.startsWith('demo-')&&/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(allowedOrigin))))throw new Error('An explicit HTTPS ALLOWED_ORIGIN is required');
  const broker=createSignInBroker({repo,auth,passwordVerifier});
  const publicProfile=account=>({uid:account.uid,name:account.name,login:account.login,role:account.role});
  async function actorFor(token){
    if(!token)error(401,'UNAUTHENTICATED','Sign in first');
    let decoded;
    try{decoded=await auth.verifyIdToken(token,true);}catch{error(401,'UNAUTHENTICATED','Sign in again');}
    const snap=await repo.collection('accounts').doc(decoded.uid).get(),profile=snap.data();
    if(!snap.exists||profile.disabled||!['teacher','admin'].includes(profile.role))error(403,'ACCOUNT_DISABLED','Account is not enabled');
    if(!Number.isInteger(decoded.sessionVersion)||!([profile.sessionVersion,profile.pendingSessionVersion].includes(decoded.sessionVersion))||(decoded.auth_time||0)<(profile.validAfter||0))error(401,'SESSION_EXPIRED','Sign in again');
    return {...profile,uid:decoded.uid,authTime:decoded.auth_time};
  }
  return async function handler(request,response){
    const origin=request.headers.origin;
    response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Vary','Origin');
    const send=(status,body)=>{response.statusCode=status;response.end(JSON.stringify(body));};
    try{
      // Bearer-token authentication is still required. CORS is not authorization.
      if(origin&&origin!==allowedOrigin)error(403,'ORIGIN_DENIED','This origin is not allowed');
      if(origin===allowedOrigin)response.setHeader('Access-Control-Allow-Origin',allowedOrigin);
      response.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Command-ID');
      response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      if(request.method==='OPTIONS'){response.statusCode=204;return response.end();}
      const url=new URL(request.url,'https://backend.invalid');
      if(request.method==='GET'&&url.pathname==='/info')return send(200,{projectId:auth.app.options.projectId});
      if(request.method==='GET'&&url.pathname==='/health')return send(200,{status:'ok'});
      if(request.method==='GET'&&url.pathname==='/directory'){
        const docs=await repo.collection('directory').where('disabled','==',false).get();
        return send(200,{accounts:docs.docs.map(d=>({name:d.data().name,selector:d.id||d.data().selector||d.data().uid})).sort((a,b)=>a.name.localeCompare(b.name))});
      }
      if(request.method==='POST'&&url.pathname==='/auth/login'){
        if(origin!==allowedOrigin)error(403,'ORIGIN_DENIED','Use the application sign-in page');
        if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))error(415,'JSON_REQUIRED','Use JSON');
        let raw='',size=0;const decoder=new TextDecoder();
        for await(const chunk of request){const bytes=typeof chunk==='string'?new TextEncoder().encode(chunk):chunk;size+=bytes.byteLength;if(size>4096)error(413,'TOO_LARGE','Sign-in request is too large');raw+=decoder.decode(bytes,{stream:true});}
        raw+=decoder.decode();let input;try{input=JSON.parse(raw);}catch{error(400,'INVALID_JSON','Invalid JSON');}
        if(!input||typeof input!=='object'||Array.isArray(input))error(400,'INVALID_JSON','Use a sign-in object');
        return send(200,await broker(input));
      }
      const token=/^Bearer ([^ ]+)$/.exec(request.headers.authorization||'')?.[1];
      const actor=await actorFor(token);
      if(request.method==='GET'&&url.pathname==='/admin/directory'){
        assertActor(actor,'admin');const docs=await repo.collection('accounts').where('disabled','==',false).get();
        return send(200,{accounts:docs.docs.map(d=>publicProfile(d.data())).sort((a,b)=>a.name.localeCompare(b.name))});
      }
      if(request.method==='GET'&&url.pathname==='/me')return send(200,{account:publicProfile(actor)});
      if(request.method!=='POST')error(404,'NOT_FOUND','Action not found');
      if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))error(415,'JSON_REQUIRED','Use JSON');
      let raw='',size=0;const decoder=new TextDecoder();
      for await(const chunk of request){const bytes=typeof chunk==='string'?new TextEncoder().encode(chunk):chunk;size+=bytes.byteLength;if(size>(url.pathname==='/admin/restore'?4*1024*1024:512*1024))error(413,'TOO_LARGE','Request is too large');raw+=decoder.decode(bytes,{stream:true});}
      raw+=decoder.decode();
      let body;try{body=JSON.parse(raw);}catch{error(400,'INVALID_JSON','Invalid JSON');}
      const commandId=id(request.headers['x-command-id']||'');
      const requestRepo=repo.withEpoch?repo.withEpoch(body.epoch||0):repo;
      // Restore owns its version check and checks the idempotency record before that check.
      // Wrapping it in the old epoch guard would reject a safe retry after a successful restore.
      if(url.pathname==='/admin/restore')return send(200,await restoreDataset(repo,actor,body,commandId));
      if(url.pathname==='/requests')return send(200,await createRequisition(requestRepo,actor,body,commandId));
      if(url.pathname==='/requests/decide')return send(200,await decideRequisition(requestRepo,actor,body,commandId));
      if(url.pathname==='/admin/changes')return send(200,await applyAdminChanges(requestRepo,actor,body,commandId));
      if(url.pathname==='/loans/issue')return send(200,await issueManualLoan(requestRepo,actor,body,commandId));
      if(url.pathname==='/losses')return send(200,await recordLoss(requestRepo,actor,body,commandId));
      if(url.pathname==='/loans/return')return send(200,await returnLoan(requestRepo,actor,body,commandId));
      if(url.pathname==='/admin/directory/minimize'){
        assertActor(actor,'admin');
        const count=await repo.db.runTransaction(async tx=>{
          const accounts=await tx.get(repo.collection('accounts')),existing=await tx.get(repo.collection('directory'));
          const rows=new Map(existing.docs.map(doc=>[doc.id||doc.data().uid,{name:doc.data().name,selector:doc.id||doc.data().uid,disabled:true}]));
          for(const doc of accounts.docs){const profile=doc.data();rows.set(profile.uid,publicDirectoryEntry(profile));}
          if(rows.size>300)error(413,'DIRECTORY_TOO_LARGE','More than 300 directory records need a staged administrator procedure');
          for(const [uid,row] of rows)tx.set(repo.collection('directory').doc(uid),row);
          return rows.size;
        });
        return send(200,{minimized:true,records:count,accountsUnchanged:true});
      }
      if(url.pathname==='/admin/self'){
        assertActor(actor,'admin');
        if(Date.now()/1000-(actor.authTime||0)>300)error(401,'RECENT_LOGIN_REQUIRED','Sign out and sign in again before changing administrator credentials');
        const name=text(body.name,120),password=body.password;
        if(password&&(typeof password!=='string'||password.length<12||password.length>128))error(400,'PASSWORD_POLICY','Use a password of 12 to 128 characters');
        const ref=repo.collection('accounts').doc(actor.uid);
        const sessionVersion=actor.pendingSessionVersion||((actor.sessionVersion||0)+1);
        if(password)await ref.update({pendingSessionVersion:sessionVersion,validAfter:Math.floor(Date.now()/1000)});
        await auth.updateUser(actor.uid,{displayName:name,...(password?{password}:{})});
        if(password){
          const user=await auth.getUser(actor.uid);
          await auth.setCustomUserClaims(actor.uid,{...user.customClaims,sessionVersion});
          await auth.revokeRefreshTokens(actor.uid);
          // During a partial failure the new signed-in token remains authorized through pendingSessionVersion.
          await ref.update({name,sessionVersion,pendingSessionVersion:null,validAfter:Math.floor(Date.now()/1000)});
        }else await ref.update({name});
        await repo.collection('directory').doc(actor.uid).update({name});
        return send(200,{name,signInAgain:!!password});
      }
      if(url.pathname.startsWith('/admin/accounts')){
        assertActor(actor,'admin');
        if(url.pathname==='/admin/accounts/create'){
          const name=text(body.name,120),role=body.role||'teacher';
          // Additional admins require an explicit future workflow, never a dropdown accident.
          if(role!=='teacher')error(400,'TEACHERS_ONLY','This action creates teacher accounts only');
          if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)error(400,'PASSWORD_POLICY','Use a password of 12 to 128 characters');
          const uid='teacher_'+sha256Hex(actor.uid+':'+commandId).slice(0,32),login=uid+'@'+auth.app.options.projectId+'.invalid';
          const previous=await repo.collection('accounts').doc(uid).get();
          if(previous.exists){
            const existing=previous.data();
            if(existing.name!==name||existing.createdBy!==actor.uid)error(409,'IDEMPOTENCY_CONFLICT','Account operation has different content');
            const user=await auth.getUser(uid);
            if(user.disabled||existing.disabled)error(409,'PROVISIONING_INCOMPLETE','A disabled partial account needs administrator review');
            return send(200,{account:publicProfile(existing),alreadyApplied:true});
          }
          const normalizedName=name.normalize('NFKC').toLocaleLowerCase('en');
          const nameRef=repo.collection('accountNames').doc(sha256Hex(normalizedName));
          await repo.db.runTransaction(async transaction=>{
            const reserved=await transaction.get(nameRef),directory=await transaction.get(repo.collection('directory'));
            if(reserved.exists&&reserved.data().uid!==uid)error(409,'DUPLICATE_NAME','This teacher name already has an account. Use a distinct display name or manage the existing account.');
            if(directory.docs.some(doc=>(doc.id||doc.data().selector||doc.data().uid)!==uid&&doc.data().name.normalize('NFKC').toLocaleLowerCase('en')===normalizedName))error(409,'DUPLICATE_NAME','This display name already has an account.');
            transaction.set(nameRef,{uid,createdBy:actor.uid});
          });
          await auth.createUser({uid,email:login,password:body.password,displayName:name,disabled:true});
          const profile={uid,name,login,role,disabled:false,validAfter:0,sessionVersion:1,createdBy:actor.uid,createdAt:repo.now(),version:1};
          // A partially provisioned Auth user remains disabled; no administrator authority is granted.
          try{
            const batch=repo.db.batch();batch.set(repo.collection('accounts').doc(uid),profile);
            batch.set(repo.collection('directory').doc(uid),publicDirectoryEntry(profile));await batch.commit();
            await auth.setCustomUserClaims(uid,{sessionVersion:1});
            await auth.updateUser(uid,{disabled:false});
          }catch{error(503,'PROVISIONING_INCOMPLETE','Teacher account setup did not complete. Do not retry blindly; review the disabled account.');}
          return send(201,{account:publicProfile(profile)});
        }
        const uid=id(body.uid||''),ref=repo.collection('accounts').doc(uid),snap=await ref.get(),account=snap.data();
        if(!snap.exists||account.role!=='teacher')error(404,'TEACHER_NOT_FOUND','Teacher account not found');
        if(url.pathname==='/admin/accounts/password'){
          if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)error(400,'PASSWORD_POLICY','Use a password of 12 to 128 characters');
          const commandRef=repo.collection('accountCommands').doc(actor.uid+'_'+commandId);
          const operation=await repo.db.runTransaction(async transaction=>{
            const previous=await transaction.get(commandRef),current=await transaction.get(ref);
            if(previous.exists){const value=previous.data();if(value.uid!==uid||value.operation!=='password_reset')error(409,'IDEMPOTENCY_CONFLICT','This command belongs to another account action');return value;}
            const profile=current.data(),value={uid,operation:'password_reset',status:'pending',wasDisabled:!!profile.disabled,sessionVersion:(profile.sessionVersion||0)+1,startedAt:repo.now()};
            transaction.set(commandRef,value);transaction.set(ref,{...profile,disabled:true});return value;
          });
          if(operation.status==='done')return send(200,{account:publicProfile(account),sessionsRevoked:true,alreadyApplied:true});
          await auth.updateUser(uid,{disabled:true});
          await auth.updateUser(uid,{password:body.password});await auth.revokeRefreshTokens(uid);
          const validAfter=Math.floor(Date.now()/1000),currentUser=await auth.getUser(uid);
          await auth.setCustomUserClaims(uid,{...currentUser.customClaims,sessionVersion:operation.sessionVersion});
          // Preserve deliberate disable state. A failed in-progress reset can resume with the same command.
          await ref.update({validAfter,sessionVersion:operation.sessionVersion,disabled:operation.wasDisabled});
          await auth.updateUser(uid,{disabled:operation.wasDisabled});
          await commandRef.update({status:'done',finishedAt:repo.now()});
          return send(200,{account:publicProfile(account),sessionsRevoked:true,disabled:operation.wasDisabled});
        }
        if(url.pathname==='/admin/accounts/disable'){
          await ref.update({disabled:true});await auth.updateUser(uid,{disabled:true});await auth.revokeRefreshTokens(uid);
          await repo.collection('directory').doc(uid).update({disabled:true});return send(200,{disabled:true,uid});
        }
      }
      error(404,'NOT_FOUND','Action not found');
    }catch(err){
      const known=err instanceof AppError;
      // Never log request bodies, passwords, tokens, or raw provider errors.
      send(known?err.status:503,{error:{code:known?err.code:'SERVICE_UNAVAILABLE',message:known?err.message:'The service could not complete this action. Nothing is confirmed saved.'}});
    }
  };
}
