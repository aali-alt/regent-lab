import {sha256Hex,randomUUID} from './portable-crypto.mjs';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const fail = (status,code,message) => {throw new AppError(status,code,message);};
export const clone = value => structuredClone(value);
export const entityKinds = new Set(['inventory','cabinets','requests','scheduleSlots','loans','lossRecords','logs']);
const forbiddenSettings = /password|credential|firebase|private.?key|auth.?token|secret/i;
export function cleanSettings(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) fail(400,'INVALID_SETTINGS','Settings must be an object');
  const scan = obj => {
    if (Array.isArray(obj)) return obj.map(scan);
    if (obj && typeof obj==='object') return Object.fromEntries(Object.entries(obj)
      .filter(([key])=>!forbiddenSettings.test(key) && !['__proto__','constructor','prototype'].includes(key))
      .map(([key,val])=>[key,scan(val)]));
    return obj;
  };
  return scan(value);
}
export function id(value) {
  if (typeof value!=='string'||value.startsWith('__')||!/^[a-zA-Z0-9_-]{1,120}$/.test(value)) fail(400,'INVALID_ID','Invalid record identifier');
  return value;
}
export function positive(value) {
  if (typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e9) fail(400,'INVALID_QUANTITY','Quantity must be positive');
  return value;
}
export function text(value,max=300) {
  if (typeof value!=='string'||value.trim().length===0||value.length>max) fail(400,'INVALID_TEXT','A required text field is empty or too long');
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400,'INVALID_TEXT','Markup and control characters are not allowed');
  return value.trim();
}
export function dateOnly(value) {
  if (typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400,'INVALID_DATE','Use a calendar date');
  const parsed = new Date(value+'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==value) fail(400,'INVALID_DATE','Invalid calendar date');
  return value;
}
export function assertActor(actor,role) {
  if (!actor?.uid||actor.disabled) fail(401,'UNAUTHENTICATED','Sign in again');
  if (role && actor.role!==role) fail(403,'FORBIDDEN','This action is for the lab administrator');
}
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const digest=value=>sha256Hex(canonical(value));

// The repository runs each callback atomically. No cloud access occurs in this module.
export async function createRequisition(repo,actor,input,commandId) {
  assertActor(actor);
  const cmd=id(commandId);
  const payloadHash=digest(input);
  return repo.transaction(async tx=>{
    const prior=await tx.get('commands',actor.uid+'_'+cmd);
    if(prior){if(prior.hash!==payloadHash) fail(409,'IDEMPOTENCY_CONFLICT','Retry has different content'); return prior.result;}
    const settings=(await tx.get('settings','main'))||{};
    const reqId=id(input.id||'req_'+randomUUID());
    if(await tx.get('requests',reqId)) fail(409,'ALREADY_EXISTS','Request identifier already exists');
    const usageMode=input.usageMode;
    if(!['in-lab','outside-lab'].includes(usageMode)) fail(400,'INVALID_MODE','Choose lab use or classroom loan');
    const date=dateOnly(input.date),period=text(input.period),lab=usageMode==='in-lab'?text(input.lab):'Classroom Loan';
    if(!(settings.periods||[]).includes(period)) fail(400,'INVALID_PERIOD','Period is not configured');
    if(usageMode==='in-lab'&&!(settings.labs||[]).includes(lab)) fail(400,'INVALID_LAB','Laboratory is not configured');
    // Do not invent a school-day policy: reject only if the owner has configured it.
    const weekday=new Date(date+'T12:00:00Z').getUTCDay();
    if(Array.isArray(settings.allowedWeekdays)&&!settings.allowedWeekdays.includes(weekday)) fail(409,'CLOSED_DAY','This school day is not bookable');
    const experiment=text(input.experiment,500),grade=text(input.grade),subject=text(input.subject);
    if(!Array.isArray(input.items)||input.items.length===0||input.items.length>100) fail(400,'EMPTY_REQUEST','Choose one or more items');
    await tx.preload(input.items.map(entry=>['inventory',id(entry.itemId)]));
    const seen=new Set(),items=[];
    for(const entry of input.items){
      const itemId=id(entry.itemId);if(seen.has(itemId))fail(400,'DUPLICATE_ITEM','Combine repeated items');seen.add(itemId);
      const item=await tx.get('inventory',itemId);if(!item)fail(409,'MISSING_ITEM','An item is no longer available');
      const qty=positive(entry.qty);if(qty>Number(item.qty))fail(409,'INSUFFICIENT_STOCK','Not enough stock for this request');
      items.push({itemId,qty,nameEn:item.nameEn||'',unit:item.unit||''});
    }
    const returnDate=usageMode==='outside-lab'?dateOnly(input.returnDate||date):'';
    if(returnDate&&returnDate<date)fail(400,'INVALID_RETURN','Return cannot precede issue date');
    const row={id:reqId,teacherUid:actor.uid,teacherName:actor.name,subject,grade,experiment,usageMode,date,period,lab,
      groups:Number.isInteger(input.groups)&&input.groups>0?Math.min(input.groups,100):1,
      returnDate,returnPeriod:usageMode==='outside-lab'?text(input.returnPeriod||period):'',
      items,notes:input.notes?text(input.notes,2000):'',status:'pending',submittedAt:repo.now(),version:1};
    if(usageMode==='in-lab'){
      const conflict=await tx.findActiveBooking({date,period,lab});
      if(conflict)fail(409,'BOOKING_CONFLICT','This laboratory period is already booked');
      tx.set('bookings',digest({date,period,lab}),{date,period,lab,requestId:reqId,status:'pending'});
    }
    tx.set('requests',reqId,row);
    const result={request:row};tx.set('commands',actor.uid+'_'+cmd,{hash:payloadHash,result,createdAt:repo.now()});
    return result;
  });
}

export async function decideRequisition(repo,actor,{requestId,decision},commandId) {
  assertActor(actor,'admin');id(requestId);id(commandId);
  if(!['approved','rejected'].includes(decision))fail(400,'INVALID_DECISION','Unknown decision');
  const payloadHash=digest({requestId,decision});
  return repo.transaction(async tx=>{
    const cmd=actor.uid+'_'+commandId, prior=await tx.get('commands',cmd);
    if(prior){if(prior.hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','Retry has different content');return prior.result;}
    const req=await tx.get('requests',requestId);if(!req)fail(404,'NOT_FOUND','Request not found');
    if(req.status===decision)return {request:req,alreadyApplied:true};
    if(req.status!=='pending')fail(409,'ALREADY_DECIDED','Request already processed');
    const inventory=[],loans=[];
    if(decision==='approved'){
      await tx.preload(req.items.map(entry=>['inventory',id(entry.itemId)]));
      for(const entry of req.items){
        const item=await tx.get('inventory',entry.itemId);if(!item)fail(409,'MISSING_ITEM','Item no longer exists');
        const qty=positive(entry.qty);if(Number(item.qty)<qty)fail(409,'INSUFFICIENT_STOCK','Stock changed; approval was not saved');
        const next={...item,qty:Number(item.qty)-qty,version:(item.version||0)+1,updatedAt:repo.now()};inventory.push(next);
        if(req.usageMode==='outside-lab')loans.push({id:'loan_'+randomUUID(),requestId,teacherUid:req.teacherUid,
          teacherName:req.teacherName,itemId:item.id,itemName:item.nameEn,qty,unit:item.unit||'',classRoom:req.grade,
          dueDate:req.returnDate,duePeriod:req.returnPeriod,status:'active',issuedAt:repo.now(),version:1});
      }
    }
    // Every read is complete before repository writes are queued.
    const updated={...req,status:decision,version:(req.version||0)+1,updatedAt:repo.now(),decidedBy:actor.uid};
    for(const item of inventory)tx.set('inventory',item.id,item);
    for(const loan of loans)tx.set('loans',loan.id,loan);
    tx.set('requests',requestId,updated);
    if(req.usageMode==='in-lab'){
      const key=digest({date:req.date,period:req.period,lab:req.lab});
      if(decision==='rejected')tx.delete('bookings',key);else tx.set('bookings',key,{date:req.date,period:req.period,lab:req.lab,requestId,status:decision});
    }
    const audit={id:'log_'+randomUUID(),item:req.experiment,delta:decision==='approved'?'-'+req.items.reduce((sum,item)=>sum+item.qty,0):'0',note:'Requisition '+decision+' for '+req.teacherName,time:repo.now(),type:'requisition_'+decision,requestId,actorUid:actor.uid,at:repo.now()};
    tx.set('logs',audit.id,audit);
    const result={request:updated,inventory,loans};tx.set('commands',cmd,{hash:payloadHash,result,createdAt:repo.now()});return result;
  });
}

export async function applyAdminChanges(repo,actor,input,commandId) {
  assertActor(actor,'admin');id(commandId);
  if(!Array.isArray(input.changes)||input.changes.length===0||input.changes.length>150)fail(400,'INVALID_PATCH','Invalid changes');
  const hash=digest(input);
  return repo.transaction(async tx=>{
    const cmd=actor.uid+'_'+commandId,prior=await tx.get('commands',cmd);
    if(prior){if(prior.hash!==hash)fail(409,'IDEMPOTENCY_CONFLICT','Retry has different content');return prior.result;}
    const writes=[],keys=new Set();
    for(const change of input.changes){if(!entityKinds.has(change.kind)&&change.kind!=='settings')fail(400,'INVALID_KIND','Unsupported record type');id(change.id);}
    await tx.preload(input.changes.map(change=>[change.kind,change.id]));
    for(const change of input.changes){
      const kind=change.kind,key=id(change.id);
      if(!entityKinds.has(kind)&&kind!=='settings')fail(400,'INVALID_KIND','Unsupported record type');
      if(kind==='requests')fail(400,'USE_REQUEST_API','Use request submission and approval actions');
      if(kind==='loans')fail(400,'USE_LOAN_API','Use the issue and return loan actions');
      const fullKey=kind+'/'+key;if(keys.has(fullKey))fail(400,'DUPLICATE_CHANGE','Record changed twice');keys.add(fullKey);
      const current=await tx.get(kind,key);
      if(kind==='logs'&&(current||change.delete))fail(400,'AUDIT_READ_ONLY','Existing audit entries cannot be edited');
      if((current?.version||0)!==change.expectedVersion)fail(409,'STALE_WRITE','Another device changed this record. Refresh and retry.');
      if(change.delete){writes.push({kind,key,delete:true});continue;}
      const value=cleanSettings(change.value);
      if(value&&typeof value==='object'){delete value._meta;delete value._revision;}
      if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'INVALID_RECORD','Record must be an object');
      if(kind==='inventory'&&(!Number.isFinite(value.qty)||value.qty<0))fail(409,'NEGATIVE_STOCK','Inventory cannot be negative');
      if(kind==='loans'&&value.status==='active')positive(value.qty);
      // Treat input as data, not HTML or script. IDs are never supplied by display names.
      if(value.id&&value.id!==key)fail(400,'INVALID_ID','Record ID does not match');
      writes.push({kind,key,value:{...value,...(kind==='settings'?{}:{id:key}),version:(current?.version||0)+1,updatedAt:repo.now()}});
    }
    if(writes.some(w=>w.kind==='scheduleSlots')){
      const lock=(await tx.get('meta','scheduleLock'))||{version:0};
      const existing=await tx.list('scheduleSlots'),bookings=await tx.list('bookings');
      const map=new Map(existing.map(s=>[s.id,s]));
      for(const w of writes.filter(w=>w.kind==='scheduleSlots')){if(w.delete)map.delete(w.key);else map.set(w.key,w.value);}
      const slots=[...map.values()];
      const overlaps=(a,b)=>a.lab===b.lab&&a.day===b.day&&a.period===b.period&&(a.recurrence==='weekly'||b.recurrence==='weekly'||a.weekDate===b.weekDate);
      for(const w of writes.filter(w=>w.kind==='scheduleSlots'&&!w.delete)){
        const slot=w.value;text(slot.lab);text(slot.period);dateOnly(slot.weekDate);
        const day=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(slot.weekDate+'T12:00:00Z').getUTCDay()];
        if(slot.day!==day)fail(400,'INVALID_WEEKDAY','Schedule weekday does not match its calendar date');
        if(!['weekly','single'].includes(slot.recurrence))fail(400,'INVALID_RECURRENCE','Choose weekly or single');
        for(const other of slots){
          if(other.id===slot.id||!overlaps(slot,other))continue;
          const occurrence=slot.recurrence==='weekly'?other.weekDate:slot.weekDate;
          if(slot.recurrence==='weekly'&&other.recurrence==='weekly')fail(409,'BOOKING_CONFLICT','Weekly laboratory periods overlap');
          if(!(slot.skippedDates||[]).includes(occurrence)&&!(other.skippedDates||[]).includes(occurrence))fail(409,'BOOKING_CONFLICT','Laboratory period is already booked');
        }
        for(const booking of bookings){
          const bookingDay=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(booking.date+'T12:00:00Z').getUTCDay()];
          if(booking.lab===slot.lab&&booking.period===slot.period&&bookingDay===slot.day&&!(slot.skippedDates||[]).includes(booking.date)&&(slot.recurrence==='weekly'||slot.weekDate===booking.date))fail(409,'BOOKING_CONFLICT','A requisition already holds this laboratory period');
        }
      }
      tx.set('meta','scheduleLock',{version:lock.version+1});
    }
    for(const w of writes){if(w.delete)tx.delete(w.kind,w.key);else tx.set(w.kind,w.key,w.value);}
    const result={changes:writes};tx.set('commands',cmd,{hash,result,createdAt:repo.now()});return result;
  });
}

export async function returnLoan(repo,actor,{loanId},commandId) {
  assertActor(actor,'admin');id(loanId);id(commandId);
  return repo.transaction(async tx=>{
    const loan=await tx.get('loans',loanId);if(!loan)fail(404,'NOT_FOUND','Loan not found');
    if(loan.status==='returned')return {loan,alreadyApplied:true};
    if(loan.status!=='active')fail(409,'INVALID_LOAN_STATUS','Loan cannot be returned');
    const item=await tx.get('inventory',loan.itemId);if(!item)fail(409,'MISSING_ITEM','Restore the item before returning this loan');
    const qty=positive(loan.qty),updatedItem={...item,qty:Number(item.qty)+qty,version:(item.version||0)+1,updatedAt:repo.now()};
    if(!Number.isFinite(updatedItem.qty))fail(409,'INVALID_STOCK','Inventory quantity needs correction');
    const updatedLoan={...loan,status:'returned',version:(loan.version||0)+1,returnedAt:repo.now(),returnedBy:actor.uid};
    tx.set('inventory',item.id,updatedItem);tx.set('loans',loanId,updatedLoan);
    const logId='log_'+randomUUID();tx.set('logs',logId,{id:logId,item:item.nameEn,delta:'+'+qty,note:'Returned by '+loan.teacherName,time:repo.now(),type:'loan_returned',loanId,itemId:item.id,qty,at:repo.now(),actorUid:actor.uid});
    return {loan:updatedLoan,item:updatedItem};
  });
}

export async function issueManualLoan(repo,actor,input,commandId) {
  assertActor(actor,'admin');id(commandId);const hash=digest(input);
  return repo.transaction(async tx=>{
    const cmd=actor.uid+'_'+commandId,prior=await tx.get('commands',cmd);
    if(prior){if(prior.hash!==hash)fail(409,'IDEMPOTENCY_CONFLICT','Retry has different content');return prior.result;}
    const itemId=id(input.itemId),item=await tx.get('inventory',itemId);if(!item)fail(404,'NOT_FOUND','Item not found');
    const qty=positive(input.qty);if(qty>Number(item.qty))fail(409,'INSUFFICIENT_STOCK','Not enough stock');
    const loanId='loan_'+randomUUID(),loan={id:loanId,itemId,itemName:item.nameEn,unit:item.unit||'',qty,
      teacherName:text(input.teacherName),classRoom:text(input.classRoom),dueDate:dateOnly(input.dueDate),
      duePeriod:text(input.duePeriod||'End of Day'),status:'active',version:1,issuedAt:repo.now(),issuedBy:actor.uid};
    const updated={...item,qty:Number(item.qty)-qty,version:(item.version||0)+1,updatedAt:repo.now()};
    tx.set('inventory',itemId,updated);tx.set('loans',loanId,loan);
    const logId='log_'+randomUUID();tx.set('logs',logId,{id:logId,item:item.nameEn,delta:'-'+qty,note:'Manual loan to '+loan.teacherName,time:repo.now(),type:'loan_issued',loanId,itemId,qty,at:repo.now(),actorUid:actor.uid});
    const result={loan,item:updated};tx.set('commands',cmd,{hash,result,createdAt:repo.now()});return result;
  });
}

export async function recordLoss(repo,actor,input,commandId){
  assertActor(actor,'admin');id(commandId);const hash=digest(input);
  return repo.transaction(async tx=>{
    const cmd=actor.uid+'_'+commandId,prior=await tx.get('commands',cmd);
    if(prior){if(prior.hash!==hash)fail(409,'IDEMPOTENCY_CONFLICT','Retry has different content');return prior.result;}
    const itemId=id(input.itemId),item=await tx.get('inventory',itemId);if(!item)fail(404,'NOT_FOUND','Item not found');
    const qty=positive(input.qty),reason=text(input.reason),person=input.person?text(input.person):actor.name,notes=input.notes?text(input.notes,2000):'';
    let nextQty=Number(item.qty),loan=null,returnedGood=0;
    if(input.linkedLoanId){loan=await tx.get('loans',id(input.linkedLoanId));if(!loan||loan.itemId!==itemId||loan.status!=='active')fail(409,'INVALID_LOAN','Active matching loan not found');if(qty>Number(loan.qty))fail(409,'INVALID_LOSS','Loss exceeds the amount loaned');returnedGood=Number(loan.qty)-qty;nextQty+=returnedGood;}
    else{if(qty>nextQty)fail(409,'INSUFFICIENT_STOCK','Loss exceeds current stock');nextQty-=qty;}
    const lossId='loss_'+randomUUID(),loss={id:lossId,itemId,itemCode:item.code||'',itemName:item.nameEn,qty,unit:item.unit||'',reason,person,notes,date:input.date?dateOnly(input.date):repo.now().slice(0,10),time:repo.now(),updatedAt:repo.now(),version:1,...(loan?{linkedLoanId:loan.id}:{})};
    const updatedItem={...item,qty:nextQty,version:(item.version||0)+1,updatedAt:repo.now()};
    tx.set('inventory',itemId,updatedItem);tx.set('lossRecords',lossId,loss);
    if(loan)tx.set('loans',loan.id,{...loan,status:'returned',lostQty:qty,returnedGood,version:(loan.version||0)+1,returnedAt:repo.now()});
    const logId='log_'+randomUUID();tx.set('logs',logId,{id:logId,item:item.nameEn,delta:loan?'+'+returnedGood+' / -'+qty+' lost':'-'+qty,note:reason+' ('+person+')',time:repo.now(),actorUid:actor.uid});
    const result={loss,item:updatedItem};tx.set('commands',cmd,{hash,result,createdAt:repo.now()});return result;
  });
}
