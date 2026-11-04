import {ConnectorApi} from './api.mjs';
import {settings} from './runtime.mjs';
import {runNext} from './runner.mjs';
import {notifyLatestReport} from './notify.mjs';

try {
  const config=await settings(),api=new ConnectorApi();
  const outcome=await runNext(api,config,{prepareOnly:process.argv.includes('--prepare')});
  const notification=await notifyLatestReport(api,config).catch(()=>({notified:false,reason:'Report notification is unavailable; check the dashboard.'}));
  // Deliberately omit candidate data, questions, leases, tokens and résumé paths.
  console.log(JSON.stringify({status:outcome.status,job_id:outcome.job_id,notification}));
  if(['failed','reporting_failed','needs_confirmation'].includes(outcome.status))process.exitCode=2;
} catch {
  console.error('G Money connector could not run. Check installation, credential expiry and the private dashboard.');
  process.exitCode=1;
}
