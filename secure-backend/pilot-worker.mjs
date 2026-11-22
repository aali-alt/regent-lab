// This entry point is a synthetic, non-production runtime probe only.
// It deliberately has no credential bindings and cannot read or write school data.
import backend from './worker.mjs';
import {createRequisition,decideRequisition,applyAdminChanges} from './domain.mjs';
class MemoryRepository {
  constructor(){this.rows=new Map();this.queue=Promise.resolve();}
  now(){return new Date().toISOString();}
  set(kind,id,value){this.rows.set(kind+'/'+id,structuredClone(value));}
  get(kind,id){return structuredClone(this.rows.get(kind+'/'+id)||null);}
  transaction(fn){
    const run=this.queue.then(async()=>{
      const draft=new Map(structuredClone([...this.rows]));
      const tx={preload:async()=>{},list:async kind=>[...draft.entries()].filter(([key])=>key.startsWith(kind+'/')).map(([,value])=>structuredClone(value)),get:async(kind,id)=>structuredClone(draft.get(kind+'/'+id)||null),set:(kind,id,value)=>draft.set(kind+'/'+id,structuredClone(value)),delete:(kind,id)=>draft.delete(kind+'/'+id),findActiveBooking:async slot=>[...draft.entries()].filter(([key])=>key.startsWith('bookings/')).map(([,value])=>value).find(value=>value.date===slot.date&&value.period===slot.period&&value.lab===slot.lab)||null};
      const result=await fn(tx);this.rows=draft;return result;
    });this.queue=run.catch(()=>{});return run;
  }
}
async function selfTest(){
  const repo=new MemoryRepository(),teacher={uid:'synthetic_teacher',name:'Synthetic Teacher',role:'teacher'},admin={uid:'synthetic_admin',name:'Synthetic Administrator',role:'admin'},checks=[];
  const check=(condition,name)=>{if(!condition)throw new Error(name);checks.push(name);};
  repo.set('settings','main',{labs:['Synthetic Lab'],periods:['Period 1']});
  for(let i=0;i<100;i++)repo.set('inventory','item_'+i,{id:'item_'+i,nameEn:'Synthetic Item '+i,qty:10,unit:'pcs',version:1});
  const input={id:'synthetic_request',usageMode:'outside-lab',date:'2026-11-22',period:'Period 1',lab:'Synthetic Lab',experiment:'Synthetic runtime probe',grade:'Synthetic Grade',subject:'Science',items:Array.from({length:100},(_,i)=>({itemId:'item_'+i,qty:3}))};
  await createRequisition(repo,teacher,input,'create_probe');check(repo.get('requests',input.id)?.teacherUid===teacher.uid,'request identity binding');
  await decideRequisition(repo,admin,{requestId:input.id,decision:'approved'},'approve_probe');check(repo.get('inventory','item_99').qty===7,'100-item approval');
  await decideRequisition(repo,admin,{requestId:input.id,decision:'approved'},'approve_probe_retry');check(repo.get('inventory','item_99').qty===7,'approval retry does not double-deduct');
  try{await applyAdminChanges(repo,teacher,{changes:[]},'deny_probe');throw new Error('Teacher permission check failed');}catch(error){check(error.code==='FORBIDDEN','teacher cannot change administrator data');}
  return {mode:'synthetic-runtime-probe',passed:checks.length,checks,schoolDataAccess:false,persistentWrites:false,notVerified:['Firebase IAM','real Firebase authentication','provider concurrency','CPU under real network workload']};
}
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
export default {
  async fetch(request){
    try{
      const path=new URL(request.url).pathname;
      if(request.method==='GET'&&path==='/pilot/self-test')return new Response(JSON.stringify(await selfTest()),{headers});
      if(path==='/')return new Response(JSON.stringify({mode:'synthetic-pilot',schoolDataAccess:false,status:'Runtime probe only. Firebase integration remains unverified.'}),{headers});
      return await backend.fetch(request,{FIREBASE_PROJECT_ID:'demo-regent-lab-pilot',ALLOWED_ORIGIN:'https://aali-alt.github.io'});
    }catch{return new Response(JSON.stringify({error:{code:'PILOT_FAILED'},mode:'synthetic-pilot'}),{status:503,headers});}
  }
};
