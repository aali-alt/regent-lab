import {AppError,assertActor,cleanSettings,id,positive,dateOnly,digest,clone} from './domain.mjs';
import {datasetKinds,datasetStamp} from '../restore-contract.mjs';
const fail=(code,message)=>{throw new AppError(409,code,message);};
const normalize=value=>String(value||'').trim().normalize('NFKC').toLocaleLowerCase('en');
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const dayFor=date=>weekdays[new Date(date+'T12:00:00Z').getUTCDay()];
export async function restoreDataset(repo,actor,input,commandId){
  assertActor(actor,'admin');id(commandId);
  if(!input?.data||typeof input.expectedStamp!=='string')fail('INVALID_RESTORE','Choose a complete backup after cloud sync is ready');
  const data=cleanSettings(clone(input.data));
  if(!data.settings||datasetKinds.some(kind=>!Array.isArray(data[kind])))fail('INCOMPLETE_BACKUP','The backup must include settings and every dataset, including requests and loans');
  const hash=digest({data,expectedStamp:input.expectedStamp}),command=actor.uid+'_'+commandId;
  return repo.transaction(async tx=>{
    const prior=await tx.get('commands',command);
    if(prior){if(prior.hash!==hash)fail('IDEMPOTENCY_CONFLICT','Restore retry has different content');return prior.result;}
    const current={};for(const kind of datasetKinds)current[kind]=await tx.list(kind);
    current.settings=(await tx.get('settings','main'))||{};
    const accounts=await tx.list('accounts'),oldBookings=await tx.list('bookings');
    if(datasetStamp(current)!==input.expectedStamp)fail('STALE_RESTORE','Cloud data changed after this restore was opened. Reopen the backup and review it again.');
    const maps={};for(const kind of datasetKinds){maps[kind]=new Map();for(const row of data[kind]){
      if(!row||typeof row!=='object'||Array.isArray(row))fail('INVALID_RESTORE','A backup record is invalid');
      id(row.id);if(maps[kind].has(row.id))fail('DUPLICATE_ID','The backup contains a repeated '+kind+' identifier');
      delete row._revision;delete row._meta;maps[kind].set(row.id,row);
    }}
    const teachers=accounts.filter(row=>row.role==='teacher'&&!row.disabled);
    const mapTeacher=(row,{required=false}={})=>{
      if(row.teacherUid){const account=teachers.find(a=>a.uid===row.teacherUid);if(!account||(row.teacherName&&normalize(account.name)!==normalize(row.teacherName)))fail('TEACHER_MAPPING','A backed-up teacher identity does not match an existing protected account');row.teacherName=account.name;return;}
      const found=teachers.filter(a=>normalize(a.name)===normalize(row.teacherName));
      if(found.length>1||(required&&found.length!==1))fail('TEACHER_MAPPING','Create the missing teacher account or give duplicate teacher names distinct names before restoring');
      if(found.length===1){row.teacherUid=found[0].uid;row.teacherName=found[0].name;}
    };
    for(const row of data.inventory)if(typeof row.qty!=='number'||!Number.isFinite(row.qty)||row.qty<0||row.qty>1e9)fail('INVALID_STOCK','The backup contains invalid inventory stock');
    for(const row of data.requests){
      if(!['pending','approved','rejected'].includes(row.status)||!['in-lab','outside-lab'].includes(row.usageMode))fail('INVALID_REQUEST','A backed-up request has an invalid status or use mode');
      dateOnly(row.date);mapTeacher(row,{required:true});
      if(!Array.isArray(row.items)||!row.items.length)fail('INVALID_REQUEST','A backed-up request has no items');
      const seen=new Set();for(const item of row.items){id(item.itemId);positive(item.qty);if(seen.has(item.itemId))fail('INVALID_REQUEST','A backed-up request repeats an item');seen.add(item.itemId);if(row.status==='pending'&&!maps.inventory.has(item.itemId))fail('MISSING_ITEM','A pending request refers to missing inventory');}
    }
    for(const row of data.loans){
      if(!['active','returned'].includes(row.status))fail('INVALID_LOAN','A backed-up loan has an invalid status');positive(row.qty);id(row.itemId);mapTeacher(row);
      if(row.status==='active'&&!maps.inventory.has(row.itemId))fail('MISSING_ITEM','An active loan refers to missing inventory');
      if(row.requestId&&!maps.requests.has(row.requestId))fail('MISSING_REQUEST','A request-linked loan refers to a missing request');
      if(row.dueDate)dateOnly(row.dueDate);
    }
    for(const row of data.lossRecords){positive(row.qty);if(row.linkedLoanId&&!maps.loans.has(row.linkedLoanId))fail('MISSING_LOAN','A loss record refers to a missing loan');}
    for(const row of data.scheduleSlots){
      dateOnly(row.weekDate);if(row.day!==dayFor(row.weekDate)||!['weekly','single'].includes(row.recurrence))fail('INVALID_SCHEDULE','A backed-up schedule has an invalid weekday or recurrence');
      if(!row.lab||!row.period)fail('INVALID_SCHEDULE','A schedule is missing its laboratory or period');
      if(row.skippedDates&&!Array.isArray(row.skippedDates))fail('INVALID_SCHEDULE','Schedule skipped dates must be a list');
      for(const date of row.skippedDates||[])dateOnly(date);
    }
    const activeRequests=data.requests.filter(row=>row.usageMode==='in-lab'&&row.status!=='rejected'),bookings=new Map();
    for(const row of activeRequests){const slot={date:row.date,period:row.period,lab:row.lab},key=digest(slot);if(bookings.has(key))fail('BOOKING_CONFLICT','Two backed-up requests hold the same laboratory period');bookings.set(key,{...slot,requestId:row.id,status:row.status});
      for(const manual of data.scheduleSlots)if(manual.lab===row.lab&&manual.period===row.period&&manual.day===dayFor(row.date)&&!(manual.skippedDates||[]).includes(row.date)&&(manual.recurrence==='weekly'||manual.weekDate===row.date))fail('BOOKING_CONFLICT','A backed-up request overlaps a recurring schedule');
    }
    for(let i=0;i<data.scheduleSlots.length;i++)for(let j=i+1;j<data.scheduleSlots.length;j++){
      const a=data.scheduleSlots[i],b=data.scheduleSlots[j];if(a.lab!==b.lab||a.day!==b.day||a.period!==b.period)continue;
      if(a.recurrence==='weekly'&&b.recurrence==='weekly')fail('BOOKING_CONFLICT','Two weekly schedule entries overlap');
      const date=a.recurrence==='weekly'?b.weekDate:a.weekDate;
      if((a.recurrence==='weekly'||b.recurrence==='weekly'||a.weekDate===b.weekDate)&&!(a.skippedDates||[]).includes(date)&&!(b.skippedDates||[]).includes(date))fail('BOOKING_CONFLICT','Two schedule entries overlap');
    }
    const now=repo.now(),epoch=(current.settings.restoreEpoch||0)+1;
    const nextSettings={...data.settings,restoreEpoch:epoch,version:(current.settings.version||0)+1,updatedAt:now};
    delete nextSettings.teachers;delete nextSettings.adminUsername;
    // Existing server audit entries stay immutable. Backup audit entries are marked as imports.
    const existingLogs=new Map(current.logs.map(row=>[row.id,row]));let importedLogs=0;
    for(const row of data.logs){
      const old=existingLogs.get(row.id);if(old&&digest(cleanSettings(old))===digest(cleanSettings(row)))continue;
      if(old)row.id='import_'+digest(row).slice(0,48);
      if(existingLogs.has(row.id))continue;
      row.imported=true;row.restoredBy=actor.uid;row.restoredAt=now;existingLogs.set(row.id,row);importedLogs++;
    }
    data.logs=[...existingLogs.values()];
    const audit={id:'restore_'+commandId,type:'dataset_restored',item:'System backup',delta:'0',note:'Full dataset restored; protected accounts and prior audit history kept',time:now,actorUid:actor.uid,restoreEpoch:epoch,version:1};
    data.logs.push(audit);
    for(const kind of datasetKinds){
      const before=new Map(current[kind].map(row=>[row.id,row])),after=new Set(data[kind].map(row=>row.id));
      if(kind!=='logs')for(const row of current[kind])if(!after.has(row.id))tx.delete(kind,row.id);
      for(const row of data[kind]){
        if(kind==='logs'&&before.has(row.id))continue;
        const next={...row,version:Math.max(Number(before.get(row.id)?.version)||0,Number(row.version)||0)+1,updatedAt:now};tx.set(kind,row.id,next);
      }
    }
    for(const row of oldBookings)tx.delete('bookings',digest({date:row.date,period:row.period,lab:row.lab}));
    for(const [key,value] of bookings)tx.set('bookings',key,value);
    tx.set('settings','main',nextSettings);
    const result={restored:true,restoreEpoch:epoch,counts:Object.fromEntries(datasetKinds.map(kind=>[kind,data[kind].length])),importedLogs,accountsPreserved:true,priorAuditPreserved:true};
    tx.set('commands',command,{hash,result,createdAt:now});return result;
  },{maxAttempts:2});
}
