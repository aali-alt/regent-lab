export const datasetKinds=['inventory','cabinets','requests','scheduleSlots','loans','lossRecords','logs'];
// A restore compares every record version, not just the settings document.
export function datasetStamp(state){return JSON.stringify({epoch:state.settings?.restoreEpoch||0,settings:state.settings?.version||0,rows:datasetKinds.map(kind=>[kind,(state[kind]||[]).filter(row=>!row._meta).map(row=>[String(row.id),row.version||0,row._revision||0]).sort((a,b)=>a[0].localeCompare(b[0]))])});}
