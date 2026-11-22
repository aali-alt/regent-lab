import {createPasswordVerifier} from './auth-broker.mjs';
// Portable Firebase REST facade. It avoids gRPC and filesystem APIs on edge runtimes.
import {base64Url,decodeBase64UrlText,signRs256} from './portable-crypto.mjs';
export function restPlatform({projectId,apiKey,serviceAccount,emulatorFirestore,emulatorAuth}) {
  const emulated=!!(emulatorFirestore||emulatorAuth);
  if(emulated&&(!projectId.startsWith('demo-')||![emulatorFirestore,emulatorAuth].filter(Boolean).every(h=>/^(127\.0\.0\.1|localhost):\d+$/.test(h))))throw Error('Emulator mode is restricted to local demo projects');
  const root=emulatorFirestore?'http://'+emulatorFirestore:'https://firestore.googleapis.com';
  const database='projects/'+projectId+'/databases/(default)';
  const documents=database+'/documents';
  const authRoot=emulatorAuth?'http://'+emulatorAuth+'/identitytoolkit.googleapis.com/v1':'https://identitytoolkit.googleapis.com/v1';
  let oauthCache;
  const base64=base64Url;
  async function accessToken(){
    if(emulated)return 'owner';
    if(oauthCache&&oauthCache.expires>Date.now()+60000)return oauthCache.value;
    if(!serviceAccount?.client_email||!serviceAccount?.private_key||serviceAccount.project_id!==projectId)throw Error('A matching server credential is required');
    const now=Math.floor(Date.now()/1000);
    const unsigned=base64(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+base64(JSON.stringify({iss:serviceAccount.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
    const assertion=unsigned+'.'+await signRs256(unsigned,serviceAccount.private_key);
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    const data=await response.json();if(!response.ok||!data.access_token)throw Error('Server authentication failed');
    oauthCache={value:data.access_token,expires:Date.now()+Number(data.expires_in||3600)*1000};return oauthCache.value;
  }
  async function call(url,{method='POST',body,publicCall=false,missing=false}={}){
    const headers={'Content-Type':'application/json'};if(!publicCall)headers.Authorization='Bearer '+await accessToken();
    const response=await fetch(url,{method,headers,signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(missing&&response.status===404)return null;
    const data=await response.json();
    if(!response.ok){const err=new Error('Firebase operation failed');err.code=data.error?.status||'UNKNOWN';err.status=response.status;throw err;}
    return data;
  }
  const encode=value=>{
    if(value===null)return {nullValue:null};
    if(typeof value==='boolean')return {booleanValue:value};
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Non-finite number');return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};}
    if(typeof value==='string')return {stringValue:value};
    if(Array.isArray(value))return {arrayValue:{values:value.map(encode)}};
    if(value&&typeof value==='object')return {mapValue:{fields:fields(value)}};
    throw Error('Unsupported document value');
  };
  const fields=value=>Object.fromEntries(Object.entries(value).map(([key,val])=>[key,encode(val)]));
  const decode=value=>{
    if('nullValue'in value)return null;
    if('booleanValue'in value)return value.booleanValue;
    if('integerValue'in value)return Number(value.integerValue);
    if('doubleValue'in value)return value.doubleValue;
    if('stringValue'in value)return value.stringValue;
    if('timestampValue'in value)return value.timestampValue;
    if('arrayValue'in value)return (value.arrayValue.values||[]).map(decode);
    if('mapValue'in value)return unfields(value.mapValue.fields||{});
    throw Error('Unsupported stored document type');
  };
  const unfields=value=>Object.fromEntries(Object.entries(value).map(([key,val])=>[key,decode(val)]));
  const snapshot=data=>({exists:!!data,id:data?.name?.split('/').pop(),data:()=>data?unfields(data.fields||{}):undefined});
  async function read(ref,transaction){
    if(ref.query){
      const structuredQuery={from:[{collectionId:ref.kind}]};
      if(ref.filters.length)structuredQuery.where={compositeFilter:{op:'AND',filters:ref.filters.map(f=>({fieldFilter:{field:{fieldPath:f.field},op:'EQUAL',value:encode(f.value)}}))}};
      const rows=await call(root+'/v1/'+documents+':runQuery',{body:{structuredQuery,...(transaction?{transaction}:{})}});
      return {docs:rows.filter(row=>row.document).map(row=>snapshot(row.document))};
    }
    if(transaction){const rows=await call(root+'/v1/'+documents+':batchGet',{body:{documents:[ref.name],transaction}});return snapshot(rows.find(row=>row.found)?.found||null);}
    const data=await call(root+'/v1/'+ref.name,{method:'GET',missing:true});return snapshot(data);
  }
  async function readAll(refs,transaction){const rows=await call(root+'/v1/'+documents+':batchGet',{body:{documents:refs.map(ref=>ref.name),...(transaction?{transaction}:{})}});const map=new Map(rows.map(row=>[row.found?.name||row.missing,snapshot(row.found||null)]));return refs.map(ref=>map.get(ref.name)||snapshot(null));}
  const write=(ref,value,merge=false)=>({update:{name:ref.name,fields:fields(value)},...(merge?{updateMask:{fieldPaths:Object.keys(value)}}:{})});
  const commit=async writes=>call(root+'/v1/'+documents+':commit',{body:{writes}});
  const docRef=(kind,key)=>({name:documents+'/'+kind+'/'+key,get(){return read(this);},set(value){return commit([write(this,value)]);},update(value){return commit([{...write(this,value,true),currentDocument:{exists:true}}]);}});
  const collectionRef=(kind,filters=[])=>({query:true,kind,filters,doc:key=>docRef(kind,key),get(){return read(this);},where:(field,op,value)=>{if(op!=='==')throw Error('Only equality filters are supported');return collectionRef(kind,[...filters,{field,value}]);}});
  const db={collection:kind=>collectionRef(kind),batch(){const writes=[];return {set:(ref,value)=>writes.push(write(ref,value)),commit:()=>commit(writes)};},
    async runTransaction(fn,{maxAttempts=5}={}){
      for(let attempt=0;attempt<maxAttempts;attempt++){
        const {transaction}=await call(root+'/v1/'+documents+':beginTransaction',{body:{options:{readWrite:{}}}}),writes=[];
        try{
          const out=await fn({get:ref=>read(ref,transaction),getAll:(...refs)=>readAll(refs,transaction),set:(ref,value)=>writes.push(write(ref,value)),delete:ref=>writes.push({delete:ref.name})});
          await call(root+'/v1/'+documents+':commit',{body:{transaction,writes}});return out;
        }catch(err){
          try{await call(root+'/v1/'+documents+':rollback',{body:{transaction}});}catch{/* Never mask the original failure. */}
          if(err.code==='ABORTED'&&attempt<maxAttempts-1){await new Promise(resolve=>setTimeout(resolve,30*(attempt+1)));continue;}throw err;
        }
      }
    }
  };
  const providerUser=user=>({uid:user.localId,disabled:!!user.disabled,customClaims:JSON.parse(user.customAttributes||'{}')});
  const adminAuth=(path,body)=>call(authRoot+'/projects/'+projectId+path+'?key='+encodeURIComponent(apiKey),{body});
  const auth={app:{options:{projectId}},async verifyIdToken(token,checkRevoked){
    // Google validates the token signature. Project and lifetime checks are still explicit here.
    const result=await call(authRoot+'/accounts:lookup?key='+encodeURIComponent(apiKey),{body:{idToken:token},publicCall:true});
    const user=result.users?.[0];if(!user||user.disabled)throw Error('Invalid or disabled user');
    let claims;try{claims=JSON.parse(decodeBase64UrlText(token.split('.')[1]));}catch{throw Error('Malformed token');}
    const now=Math.floor(Date.now()/1000);
    if(claims.aud!==projectId||claims.iss!=='https://securetoken.google.com/'+projectId||claims.sub!==user.localId||claims.exp<=now||claims.iat>now+30||(checkRevoked&&Number(claims.auth_time)<Number(user.validSince||0)))throw Error('Invalid token claims');
    return {...claims,uid:user.localId};
  },async getUser(uid){const data=await adminAuth('/accounts:lookup',{localId:[uid]});if(!data.users?.[0])throw Error('User not found');return providerUser(data.users[0]);},
    passwordSignIn:createPasswordVerifier({apiKey,projectId,emulatorHost:emulatorAuth}),
    async createCustomToken(uid,claims={}){
      const now=Math.floor(Date.now()/1000),header={alg:emulated?'none':'RS256',typ:'JWT'},issuer=emulated?'emulator@'+projectId+'.iam.gserviceaccount.com':serviceAccount.client_email;
      const unsigned=base64Url(JSON.stringify(header))+'.'+base64Url(JSON.stringify({iss:issuer,sub:issuer,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:now,exp:now+300,uid,claims}));
      return unsigned+'.'+(emulated?'':await signRs256(unsigned,serviceAccount.private_key));
    },
    async createUser({uid,...value}){const out=await adminAuth('/accounts',{localId:uid,...value});return {uid:out.localId};},
    async updateUser(uid,value){const {disabled,...rest}=value;return adminAuth('/accounts:update',{localId:uid,...rest,...(disabled===undefined?{}:{disableUser:disabled})});},
    async setCustomUserClaims(uid,value){return adminAuth('/accounts:update',{localId:uid,customAttributes:JSON.stringify(value)});},
    async revokeRefreshTokens(uid){return adminAuth('/accounts:update',{localId:uid,validSince:String(Math.floor(Date.now()/1000))});}
  };
  return {db,auth};
}
