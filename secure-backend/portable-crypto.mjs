// Edge-safe crypto shared by Node tests and the deployed Worker.
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
const encoder=new TextEncoder();
export const sha256Hex=value=>bytesToHex(sha256(typeof value==='string'?encoder.encode(value):value));
export const randomUUID=()=>globalThis.crypto.randomUUID();
export function base64Url(value){
  const bytes=typeof value==='string'?encoder.encode(value):new Uint8Array(value);
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
export function decodeBase64UrlText(value){
  const base64=value.replace(/-/g,'+').replace(/_/g,'/');
  return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'=')),c=>c.charCodeAt(0)));
}
export async function signRs256(unsigned,pem){
  if(typeof pem!=='string'||!pem.startsWith('-----BEGIN PRIVATE KEY-----'))throw new Error('A PKCS8 service credential is required');
  const binary=atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,''));
  const key=await globalThis.crypto.subtle.importKey('pkcs8',Uint8Array.from(binary,c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  return base64Url(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(unsigned)));
}
