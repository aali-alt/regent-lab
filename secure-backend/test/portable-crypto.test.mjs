import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {sha256Hex,base64Url,decodeBase64UrlText,signRs256,randomUUID} from '../portable-crypto.mjs';
import {createHandler} from '../http-handler.mjs';
test('portable SHA256 matches Node for UTF8 and byte input',()=>{
  for(const value of ['', 'abc', 'Regent معمل العلوم', new Uint8Array([0,1,254,255])])assert.equal(sha256Hex(value),createHash('sha256').update(value).digest('hex'));
  assert.match(randomUUID(),/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
});
test('portable base64url preserves Unicode without padding',()=>{
  const value=JSON.stringify({name:'معمل العلوم',sample:'test+/='});
  assert.equal(base64Url(value),Buffer.from(value).toString('base64url'));
  assert.equal(decodeBase64UrlText(base64Url(value)),value);
});
test('WebCrypto RS256 service assertion verifies with Node',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const unsigned=base64Url(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+base64Url(JSON.stringify({iss:'synthetic@example.invalid',aud:'synthetic-test'}));
  const signature=await signRs256(unsigned,privateKey.export({type:'pkcs8',format:'pem'}));
  assert.equal(verify('RSA-SHA256',Buffer.from(unsigned),publicKey,Buffer.from(signature,'base64url')),true);
  assert.equal(verify('RSA-SHA256',Buffer.from(unsigned+'x'),publicKey,Buffer.from(signature,'base64url')),false);
  await assert.rejects(()=>signRs256(unsigned,'not-a-key'));
});
test('HTTP body decoder preserves UTF8 split across single-byte chunks',async()=>{
  const account={uid:'admin',role:'admin',name:'Synthetic Admin',sessionVersion:1,validAfter:0,disabled:false};
  const rows=new Map([['accounts/admin',account],['directory/admin',account]]);
  const repo={collection:kind=>({doc:uid=>({get:async()=>({exists:rows.has(kind+'/'+uid),data:()=>structuredClone(rows.get(kind+'/'+uid))}),update:async value=>rows.set(kind+'/'+uid,{...rows.get(kind+'/'+uid),...value})})})};
  const auth={app:{options:{projectId:'demo-regent-lab'}},verifyIdToken:async()=>({uid:'admin',sessionVersion:1,auth_time:Math.floor(Date.now()/1000)}),updateUser:async()=>{}};
  const name='معمل العلوم';const bytes=new TextEncoder().encode(JSON.stringify({name,password:''}));
  const request={method:'POST',url:'https://synthetic.invalid/admin/self',headers:{origin:'https://synthetic.invalid',authorization:'Bearer synthetic','content-type':'application/json','x-command-id':'unicode_probe'},async *[Symbol.asyncIterator](){for(const byte of bytes)yield new Uint8Array([byte]);}};
  let body;const response={setHeader(){},statusCode:0,end:value=>{body=JSON.parse(value);}};
  await createHandler({repo,auth,allowedOrigin:'https://synthetic.invalid'})(request,response);
  assert.equal(response.statusCode,200);assert.equal(body.name,name);assert.equal(rows.get('accounts/admin').name,name);
});
