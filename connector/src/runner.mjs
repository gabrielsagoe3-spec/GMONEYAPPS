import {openBrowser,performApplication} from './browser.mjs';
import {workerId,withWorkerLock} from './runtime.mjs';

export async function runNext(api,config,{prepareOnly=false,browserFactory=openBrowser}={}) {
  return withWorkerLock(config.home,async()=>{
    const id=await workerId(config.home);
    await api.call('heartbeat',{worker_id:id});
    const claim=await api.call('claim',{worker_id:id});
    if(!claim?.job)return {status:'idle',message:'No queued applications are available.'};
    const {job,lease_token:lease}=claim;
    if(!lease||typeof job.id!=='string')throw Error('The server returned an invalid application lease. No employer page was opened.');
    const base={job_id:job.id,lease_token:lease};
    let browser,checkpoint=false;
    try {
      browser=await browserFactory(config,job);
      const outcome=await performApplication({page:browser.page,job,answers:claim.answers||[],resumePath:config.resume_path,mode:prepareOnly?'prepare':job.mode,beforeSubmit:async()=>{
        const saved=await api.call('before_submit',base);
        if(saved?.status!=='submitting'&&saved?.job?.status!=='submitting')throw Error('The submission checkpoint was not confirmed.');
        checkpoint=true;
      }});
      try {await api.call('result',{...base,...outcome});}
      catch {
        return {job_id:job.id,status:checkpoint?'needs_confirmation':'reporting_failed',message:checkpoint?'The employer outcome could not be saved. Do not retry; verify the employer confirmation directly.':'The browser stopped, but its result could not be saved. The lease will expire for manual review.'};
      }
      return {job_id:job.id,company:job.company,title:job.title,...outcome};
    } catch {
      const status=checkpoint?'needs_confirmation':'failed';
      const outcome={status,questions:[],error:checkpoint?'Submission may have started. Confirm directly before any retry.':'The employer form could not be processed safely. Review the job and supported adapter before requeueing.'};
      try{await api.call('result',{...base,...outcome});}catch{}
      return {job_id:job.id,...outcome};
    } finally {if(browser)await browser.close().catch(()=>{});}
  });
}
