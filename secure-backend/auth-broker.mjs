import {AppError} from './domain.mjs';
import {sha256Hex} from './portable-crypto.mjs';
const deny=()=>{throw new AppError(401,'SIGN_IN_FAILED','Sign-in failed. Check the account and password.');};
export const publicDirectoryEntry=profile=>({name:profile.name,selector:profile.uid,disabled:profile.role!=='teacher'||!!profile.disabled});

// Passwords go only to Firebase's password-verification endpoint. Never store or log them.
export function createPasswordVerifier({apiKey,projectId,emulatorHost}) {
  if(!apiKey)throw Error('FIREBASE_WEB_API_KEY is required for private sign-in');
  if(emulatorHost&&(!projectId?.startsWith('demo-')||!/^127\.0\.0\.1:\d+$/.test(emulatorHost)))throw Error('Auth emulator is local-only');
  const root=emulatorHost?'http://'+emulatorHost+'/identitytoolkit.googleapis.com/v1':'https://identitytoolkit.googleapis.com/v1';
  return async (email,password)=>{
    const result=await fetch(root+'/accounts:signInWithPassword?key='+encodeURIComponent(apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true}),signal:AbortSignal.timeout(15000)});
    if(!result.ok){if(result.status===429||result.status>=500)throw new AppError(503,'AUTH_UNAVAILABLE','Sign-in service is busy. Try again later.');deny();}
    const value=await result.json();if(!value.localId)deny();return value.localId;
  };
}

export function createSignInBroker({repo,auth,passwordVerifier}) {
  let localWindow=0,localAttempts=0;
  return async input=>{
    const now=Date.now(),window=Math.floor(now/300000);
    if(localWindow!==window){localWindow=window;localAttempts=0;}
    // A backstop per running instance, not a substitute for a host-level IP limit.
    if(++localAttempts>100)throw new AppError(429,'SIGN_IN_LIMIT','Too many sign-in attempts. Try again in five minutes.');
    const role=input.role,name=input.name,selector=input.selector,password=input.password;
    if(!['teacher','admin'].includes(role)||typeof password!=='string'||password.length<1||password.length>128||typeof name!=='string'||name.length>(role==='admin'?254:120)||role==='teacher'&&(typeof selector!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(selector)))deny();
    if(!passwordVerifier||!auth.createCustomToken)throw new AppError(503,'SIGN_IN_SETUP_REQUIRED','Private sign-in is not configured.');
    let profile;
    if(role==='teacher')profile=(await repo.collection('accounts').doc(selector).get()).data();
    else {
      const byName=await repo.collection('accounts').where('name','==',name).get();
      const byLogin=await repo.collection('accounts').where('login','==',name.toLowerCase()).get();
      const enabled=[...new Map([...byName.docs,...byLogin.docs].map(doc=>{const account=doc.data();return [account.uid,account];})).values()].filter(account=>account.role==='admin'&&!account.disabled);
      if(enabled.length===1)profile=enabled[0];
    }
    // Unknown accounts create no unbounded database records.
    if(!profile||profile.disabled||profile.role!==role||role==='teacher'&&profile.name!==name)deny();
    const throttle=repo.collection('authThrottle').doc(sha256Hex(profile.uid));
    await repo.db.runTransaction(async tx=>{
      const previous=(await tx.get(throttle)).data();
      const attempts=previous?.window===window?previous.attempts:0;
      if(attempts>=10)throw new AppError(429,'SIGN_IN_LIMIT','Too many sign-in attempts for this account. Try again in five minutes.');
      tx.set(throttle,{window,attempts:attempts+1,expiresAt:new Date((window+2)*300000).toISOString()});
    });
    let verifiedUid;
    try{verifiedUid=await passwordVerifier(profile.login,password);}catch(error){if(error instanceof AppError)throw error;throw new AppError(503,'AUTH_UNAVAILABLE','Sign-in service could not confirm the password. Try again later.');}
    if(verifiedUid!==profile.uid)deny();
    // A disable/reset racing password verification must win before we mint a session.
    const latest=(await repo.collection('accounts').doc(profile.uid).get()).data(),user=await auth.getUser(profile.uid);
    if(!latest||latest.disabled||user.disabled||latest.role!==role||latest.login!==profile.login||latest.sessionVersion!==profile.sessionVersion)deny();
    return {token:await auth.createCustomToken(profile.uid,{sessionVersion:latest.sessionVersion})};
  };
}
