import {readFile, mkdir, writeFile, open, unlink, stat} from 'node:fs/promises';
import {join, resolve, isAbsolute, extname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export const PROJECT_URL = 'https://awscnughpnerhkslhmln.supabase.co';
export const PUBLISHABLE_KEY = 'sb_publishable_Tp4xsfO0QWAvMPR2AlrHkw_j6MwGwOp';
export const DASHBOARD_URL = 'https://gabrielsagoe3-spec.github.io/GMONEYAPPS/#applications';
export const connectorHome = () => resolve(process.env.GMONEY_CONNECTOR_HOME || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'GMoneyConnector') : join(homedir(),'.local','state','gmoney-connector')));
export async function settings(home = connectorHome()) {
  await mkdir(home,{recursive:true,mode:0o700});
  try {
    const value = JSON.parse(await readFile(join(home,'config.json'),'utf8'));
    return {home,resume_path:typeof value.resume_path === 'string' ? value.resume_path : '',browser_executable_path:typeof value.browser_executable_path === 'string' ? value.browser_executable_path : undefined};
  } catch (error) {
    if (error.code === 'ENOENT') return {home,resume_path:''};
    throw Error('Connector settings could not be read. Run the Windows installer again.');
  }
}
export function readToken(home = connectorHome()) {
  let token = process.env.GMONEY_CONNECTOR_TOKEN;
  if (!token && process.platform === 'win32') {
    const quoted = join(home,'connector.token').replaceAll("'","''");
    const script = "$ErrorActionPreference='Stop';$s=ConvertTo-SecureString (Get-Content -LiteralPath '"+quoted+"' -Raw);$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}";
    const child = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:16384});
    if (child.status === 0) token = child.stdout.trim();
  }
  if (typeof token !== 'string' || !/^gmcp_[a-f0-9]{64}$/.test(token)) throw Error('A valid scoped connector credential is required. Create one in your signed-in G Money workspace and run the Windows installer.');
  return token;
}
export async function workerId(home = connectorHome()) {
  await mkdir(home,{recursive:true,mode:0o700});
  const path = join(home,'worker-id');
  try { const id=(await readFile(path,'utf8')).trim();if (/^[a-f0-9-]{36}$/i.test(id)) return id; } catch {}
  const id=randomUUID();
  try { await writeFile(path,id,{flag:'wx',mode:0o600});return id; } catch(error) {if(error.code==='EEXIST')return (await readFile(path,'utf8')).trim();throw error;}
}
export async function verifyResume(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.pdf') throw Error('Choose an existing local PDF résumé in the Windows installer.');
  const info=await stat(path);
  if (!info.isFile() || info.size < 8 || info.size > 10*1024*1024) throw Error('The local résumé must be a PDF smaller than 10 MB.');
  const handle=await open(path,'r');
  try {const header=Buffer.alloc(5);await handle.read(header,0,5,0);if(header.toString()!=='%PDF-')throw Error('The selected résumé is not a PDF.');}finally{await handle.close();}
  return path;
}
export async function withWorkerLock(home, action) {
  await mkdir(home,{recursive:true,mode:0o700});
  const path=join(home,'worker.lock');let handle;
  for(let attempt=0;attempt<2;attempt++) {
    try {handle=await open(path,'wx',0o600);break;}catch(error){
      if(error.code!=='EEXIST')throw error;
      try {
        const previous=JSON.parse(await readFile(path,'utf8'));
        let alive=true;try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
        if(!alive && Number.isFinite(previous.created_at) && Date.now()-previous.created_at>15*60*1000){await unlink(path);continue;}
      } catch {}
      throw Error('Another G Money browser worker is running. Wait for it to finish.');
    }
  }
  if(!handle)throw Error('The browser worker lock could not be acquired.');
  try {await handle.writeFile(JSON.stringify({pid:process.pid,created_at:Date.now()}));return await action();}
  finally {await handle.close();await unlink(path).catch(()=>{});}
}
