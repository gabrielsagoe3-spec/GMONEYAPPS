import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DASHBOARD_URL} from './runtime.mjs';

export async function notifyLatestReport(api,config,{platform=process.platform,show}={}) {
  if(platform!=='win32')return {notified:false,reason:'Windows notifications are available on Windows only.'};
  const workspace=await api.call('workspace');
  const reports=Array.isArray(workspace?.reports)?workspace.reports:[];
  const latest=reports.filter(r=>r&&typeof r.id==='string'&&Number.isFinite(Date.parse(r.generated_at))).sort((a,b)=>Date.parse(b.generated_at)-Date.parse(a.generated_at))[0];
  if(!latest)return {notified:false,reason:'No nightly report has been generated yet.'};
  const statePath=join(config.home,'notification-state.json');let state={};
  try{state=JSON.parse(await readFile(statePath,'utf8'));}catch{}
  if(state.last_notified_report_id===latest.id)return {notified:false,reason:'The newest report was already announced.'};
  const summary=typeof latest.summary==='string'?latest.summary:'Your private nightly application report is ready. Open Applications to review confirmed submissions and blocked attempts.';
  const message={title:'G Money nightly application report',body:summary.slice(0,800),url:DASHBOARD_URL};
  const temp=join(config.home,'report-toast-'+randomUUID()+'.json');
  try {
    await writeFile(temp,JSON.stringify(message),{flag:'wx',mode:0o600});
    const send=show || (()=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/show-report.ps1',import.meta.url)),'-SummaryFile',temp],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384}));
    const result=await send(temp,message);
    if(result?.status!==0)return {notified:false,reason:'Windows could not show the report notification. The report remains available in the dashboard.'};
    await writeFile(statePath,JSON.stringify({last_notified_report_id:latest.id}),{mode:0o600});
    return {notified:true,report_id:latest.id};
  } finally {await unlink(temp).catch(()=>{});}
}
