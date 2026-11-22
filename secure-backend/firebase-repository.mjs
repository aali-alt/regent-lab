import {digest,AppError,entityKinds} from './domain.mjs';
export class FirestoreRepository {
  constructor(db,{prefix='regent_v2_',expectedEpoch}={}){this.db=db;this.prefix=prefix;this.expectedEpoch=expectedEpoch;}
  now(){return new Date().toISOString();}
  collection(kind){return this.db.collection(this.prefix+kind);}
  withEpoch(epoch=0){return new FirestoreRepository(this.db,{prefix:this.prefix,expectedEpoch:epoch});}
  async transaction(fn,options={}){
    return this.db.runTransaction(async transaction=>{
      const queued=[],cache=new Map(),touched=new Map();
      const clockRef=this.collection('meta').doc('mutationClock'),clock=await transaction.get(clockRef),revision=(clock.data()?.version||0)+1;
      if(this.expectedEpoch!==undefined){const settings=await transaction.get(this.collection('settings').doc('main'));if((settings.data()?.restoreEpoch||0)!==this.expectedEpoch)throw new AppError(409,'STALE_DATASET','The dataset was restored. Reopen the form before saving.');}
      const cacheKey=(kind,id)=>kind+'/'+id;
      const mark=(kind,value)=>{if(entityKinds.has(kind)||kind==='settings'){if(value)value._revision=revision;const uids=touched.get(kind)||new Set();if(value?.teacherUid)uids.add(value.teacherUid);touched.set(kind,uids);}};
      const tx={
        get:async(kind,id)=>{const key=cacheKey(kind,id);if(cache.has(key))return cache.get(key);const snap=await transaction.get(this.collection(kind).doc(id)),value=snap.exists?snap.data():null;cache.set(key,value);return value;},
        preload:async pairs=>{const unique=[...new Map(pairs.map(([kind,id])=>[cacheKey(kind,id),[kind,id]])).values()].filter(([kind,id])=>!cache.has(cacheKey(kind,id)));if(!unique.length)return;const snaps=await transaction.getAll(...unique.map(([kind,id])=>this.collection(kind).doc(id)));snaps.forEach((snap,index)=>cache.set(cacheKey(...unique[index]),snap.exists?snap.data():null));},
        list:async kind=>(await transaction.get(this.collection(kind))).docs.map(doc=>doc.data()).filter(row=>!row._meta),
        set:(kind,id,value)=>{mark(kind,value);queued.push({kind,id,value});},
        delete:(kind,id)=>{mark(kind,cache.get(cacheKey(kind,id)));queued.push({kind,id,delete:true});},
        findActiveBooking:async slot=>{
          const lock=await transaction.get(this.collection('meta').doc('scheduleLock'));
          queued.push({kind:'meta',id:'scheduleLock',value:{version:(lock.data()?.version||0)+1}});
          const booking=await transaction.get(this.collection('bookings').doc(digest(slot)));if(booking.exists)return booking.data();
          const day=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(slot.date+'T12:00:00Z').getUTCDay()];
          const schedules=await transaction.get(this.collection('scheduleSlots').where('lab','==',slot.lab));
          return schedules.docs.map(doc=>doc.data()).find(row=>!row._meta&&row.day===day&&row.period===slot.period&&!(row.skippedDates||row.excludedDates||[]).includes(slot.date)&&(row.recurrence==='weekly'||row.weekDate===slot.date))||null;
        }
      };
      const result=await fn(tx);
      if(queued.length){
        transaction.set(clockRef,{version:revision});
        if(result&&typeof result==='object')result.revision=revision;
        for(const [kind,uids] of touched){if(kind==='settings')continue;queued.push({kind,id:'__regent_head',value:{_meta:true,_revision:revision}});for(const uid of uids)queued.push({kind,id:'__regent_head_'+uid,value:{_meta:true,_revision:revision,teacherUid:uid}});}
      }
      for(const write of queued){const ref=this.collection(write.kind).doc(write.id);if(write.delete)transaction.delete(ref);else transaction.set(ref,write.value);}
      return result;
    },options);
  }
}
