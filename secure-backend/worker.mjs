import {restPlatform} from './rest-platform.mjs';
import {FirestoreRepository} from './firebase-repository.mjs';
import {createHandler} from './http-handler.mjs';
let cached;
export default {
  async fetch(request,env){
    if(!cached){
      const platform=restPlatform({projectId:env.FIREBASE_PROJECT_ID,apiKey:env.FIREBASE_WEB_API_KEY,serviceAccount:JSON.parse(env.FIREBASE_SERVICE_ACCOUNT||'null')});
      cached=createHandler({repo:new FirestoreRepository(platform.db),auth:platform.auth,allowedOrigin:env.ALLOWED_ORIGIN});
    }
    const headers={};let status=200,body='';
    const response={setHeader:(key,value)=>{headers[key]=value;},set statusCode(value){status=value;},get statusCode(){return status;},end:value=>{body=value||'';}};
    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>(new URL(request.url).pathname==='/admin/restore'?4*1024*1024:512*1024))return new Response(JSON.stringify({error:{code:'TOO_LARGE'}}),{status:413,headers:{'Content-Type':'application/json'}});
    const adapted={method:request.method,url:request.url,headers:Object.fromEntries(request.headers),async *[Symbol.asyncIterator](){
      if(!request.body)return;const reader=request.body.getReader();
      try{while(true){const {done,value}=await reader.read();if(done)break;yield value;}}finally{reader.releaseLock();}
    }};
    await cached(adapted,response);return new Response(status===204?null:body,{status,headers});
  }
};
