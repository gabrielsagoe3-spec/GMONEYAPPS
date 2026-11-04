// Synthetic browser coverage. No real accounts, messages or employer applications.
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

(async () => {
  const files = ['index.html','assets/app.css','assets/app.js','assets/config.js','assets/profile.js','assets/application-agent.js'];
  const server = http.createServer((req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!files.includes(name)) return res.writeHead(404).end();
    res.setHeader('Content-Type',name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    const source=fs.readFileSync(path.join(__dirname,'..',name));
    res.end(name==='assets/config.js' ? source.toString()+'\nwindow.GMONEY_DB.emailMode="code";' : source);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors = []; page.on('pageerror',error => errors.push(error.message));
    const account = {user:{id:'synthetic-agent-user',email:'synthetic@example.invalid'},access_token:'synthetic-agent-access',refresh_token:'synthetic-agent-refresh',expires_at:Math.floor(Date.now()/1000)+3600};
    let currentAccount=account;
    const draft = {id:'synthetic-draft-1',job_id:'greenhouse-example-1',company:'Synthetic Employer',title:'Business Analyst',location:'Houston',source_url:'https://job-boards.greenhouse.io/example/jobs/1',status:'needs_input',tailored_summary:'Synthetic private résumé summary.',cover_letter:'Synthetic private letter.',match_notes:[],missing_answers:['Confirm the synthetic start date.']};
    const secondDraft = {...draft,id:'synthetic-draft-2',job_id:'lever-example-2',company:'Another Synthetic Company',title:'Operations Analyst',source_url:'https://jobs.lever.co/example/2'};
    let data = {answers:[{key:'phone',question:'Phone number',answer:'SYNTHETIC_PRIVATE_PHONE',source:'user_confirmed',updated_at:new Date().toISOString()}],connectors:[],jobs:[],reports:[],report_preferences:{local_time:'20:00',timezone:'America/Chicago',enabled:true,delivery:'dashboard'}};
    const calls = []; let workspaceFailure = false, failProfile = false, workspaceGate;
    const token = 'gmcp_SYNTHETIC_ONE_TIME_CONNECTOR_TOKEN';
    await page.route('https://*.supabase.co/**',async route => {
      const req = route.request(), url = new URL(req.url());
      const reply = (value,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if (url.pathname.endsWith('/published_research_reports')) return reply([{report:{updatedAt:'2026-11-04',summary:'Synthetic public report.',scope:'Synthetic scope.',records:[],additionalSources:[]}}]);
      if (url.pathname.endsWith('/research_automation_status')) return reply([]);
      if (url.pathname.endsWith('/auth/v1/logout')) return route.fulfill({status:204});
      if (url.pathname.endsWith('/auth/v1/otp')) return reply({});
      if (url.pathname.endsWith('/auth/v1/verify')) return reply(currentAccount);
      assert.equal(req.headers().authorization,'Bearer '+currentAccount.access_token);
      if (url.pathname.endsWith('/agent_preferences')) return reply([{user_id:currentAccount.user.id,full_name:'Synthetic Candidate',resume_text:'Synthetic private profile.',locations:['Houston'],sponsorship_need:'required_future'}],failProfile?503:200);
      if (url.pathname.endsWith('/rpc/claim_candidate_profile')) return reply({imported:false});
      if (url.pathname.endsWith('/rpc/list_candidate_application_drafts')) return reply([draft,secondDraft]);
      assert.equal(req.method(),'POST');
      const body = req.postDataJSON();
      calls.push({name:url.pathname.split('/').at(-1),body});
      if (url.pathname.endsWith('/rpc/get_application_workspace')) {
        assert.deepEqual(body,{});
        const gate=workspaceGate;workspaceGate=null;if(gate) await gate;
        return workspaceFailure ? reply({},503) : reply(data);
      }
      if (url.pathname.endsWith('/rpc/create_application_connector')) {
        assert.deepEqual(body,{p_name:'Windows application worker'});
        data.connectors.push({id:'synthetic-connector',name:'Windows application worker',last_seen_at:null,expires_at:new Date(Date.now()+86400000).toISOString(),revoked:false});
        return reply({token,id:'synthetic-connector',expires_at:data.connectors.at(-1).expires_at});
      }
      if (url.pathname.endsWith('/rpc/revoke_application_connector')) {
        data.connectors.find(item=>item.id===body.p_id).revoked=true;
        return reply({revoked:true});
      }
      if (url.pathname.endsWith('/rpc/queue_application_draft')) {
        assert.ok(['prepare','submit'].includes(body.p_mode));
        const source = [draft,secondDraft].find(item=>item.id===body.p_draft_id);assert.ok(source);
        let job = data.jobs.find(item=>item.draft_id===source.id);
        if(!job){job={id:'job-'+source.id,draft_id:source.id,job_id:source.job_id,company:source.company,title:source.title,source_url:source.source_url,status:'queued',mode:body.p_mode,questions:[],receipt:{},created_at:new Date().toISOString()};data.jobs.push(job);}
        else {job.status='queued';job.mode=body.p_mode;job.questions=[];}
        return reply(job);
      }
      if (url.pathname.endsWith('/rpc/save_application_answer')) {
        assert.equal(typeof body.p_key,'string');assert.equal(typeof body.p_question,'string');assert.equal(typeof body.p_answer,'string');
        const previous=data.answers.findIndex(item=>item.key===body.p_key);if(previous>=0)data.answers.splice(previous,1);
        data.answers.push({key:body.p_key,question:body.p_question,answer:body.p_answer,source:'user_confirmed',updated_at:new Date().toISOString()});
        return reply({saved:true});
      }
      if (url.pathname.endsWith('/rpc/set_application_report_schedule')) {
        data.report_preferences={...data.report_preferences,local_time:body.p_local_time,enabled:body.p_enabled};
        return reply(data.report_preferences);
      }
      throw Error('Unexpected synthetic route: '+url.pathname);
    });
    const base = 'http://127.0.0.1:'+server.address().port;
    await page.goto(base+'/#applications');
    assert.equal(await page.locator('#applicationWorkspace').isHidden(),true);
    assert.equal(calls.length,0,'signed-out application UI does not read private data');
    await page.evaluate(value=>sessionStorage.setItem('gmoney_session',JSON.stringify(value)),account);
    await page.reload();
    const loaded=()=>page.waitForFunction(()=>!document.getElementById('applicationWorkspace').hidden && !document.getElementById('refreshApplicationWorkspace').disabled);
    await loaded();
    assert.equal(await page.locator('#applicationDraftList article').count(),2);
    assert.equal(await page.locator('#applicationConfirmedCount').textContent(),'Confirmed submissions shown: 0');
    assert.equal(await page.locator('#applicationJobList .application-entry').count(),0,'drafts are not application attempts');
    assert.equal(await page.locator('#applicationWorkerState').textContent(),'Windows setup needed');
    assert.equal(await page.locator('#applicationReportTime').inputValue(),'20:00');
    assert.equal(await page.locator('#applicationReportEnabled').isChecked(),true);
    assert.match(await page.locator('#applicationReportSchedule').textContent(),/8:00 PM Houston time/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile private workspace has no horizontal overflow');
    const firstCard=page.locator('#applicationDraftList article').nth(0);
    await firstCard.locator('[data-application-mode="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('.draft-action-status').textContent.includes('Queued for Windows'));
    assert.equal(data.jobs.length,1);assert.equal(data.jobs[0].mode,'submit');
    assert.equal(await page.locator('#applicationConfirmedCount').textContent(),'Confirmed submissions shown: 0');
    assert.match(await page.locator('#applicationJobList').textContent(),/Queued for Windows/);
    await page.locator('#applicationDraftList article').nth(1).locator('[data-application-mode="prepare"]').click();
    await page.waitForFunction(()=>document.getElementById('applicationQueueCount').textContent==='2 application records');
    assert.equal(data.jobs[1].mode,'prepare');

    await page.locator('#createApplicationConnector').click();
    await page.waitForFunction(()=>!document.getElementById('applicationConnectorSecret').hidden);
    assert.equal(await page.locator('#applicationConnectorToken').inputValue(),token);
    assert.equal(await page.locator('#applicationWorkerState').textContent(),'Waiting for Windows');
    const storage=await page.evaluate(()=>({session:JSON.stringify({...sessionStorage}),local:JSON.stringify({...localStorage})}));
    assert.equal((storage.session+storage.local).includes(token),false,'connector token is never cached');
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    assert.equal(await page.locator('#applicationConnectorToken').inputValue(),'');
    assert.equal(await page.locator('#applicationConnectorSecret').isHidden(),true);
    data.connectors[0].last_seen_at=new Date().toISOString();
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    assert.equal(await page.locator('#applicationWorkerState').textContent(),'Windows recently active');
    assert.match(await page.locator('#applicationHeartbeat').textContent(),/Last connector contact.*does not confirm that a browser task completed/);
    data.connectors[0].last_seen_at=new Date(Date.now()+7200000).toISOString();
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    assert.equal(await page.locator('#applicationWorkerState').textContent(),'Waiting for Windows','future timestamps do not prove worker activity');

    const question='Are you currently authorized to work? <img src=x onerror="window.__agentUnsafe=true">';
    const normalize=question.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
    const key='question_'+crypto.createHash('sha256').update(draft.job_id+'\0'+normalize).digest('hex').slice(0,24);
    data.jobs[0].status='needs_input';data.jobs[0].questions=[{key,question,reason:'The exact authorization type and approved dates are unknown.'}];
    data.jobs[1].status='needs_confirmation';
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    assert.match(await page.locator('#applicationJobList').textContent(),/Paused · needs answers/);
    assert.equal(await page.locator('#applicationJobList img').count(),0);
    assert.equal(await page.evaluate(()=>window.__agentUnsafe),undefined);
    assert.equal(await page.locator('#applicationJobList .application-entry').nth(1).getByRole('button').count(),0,'uncertain submissions have no retry action');
    await page.locator('#applicationJobList').getByRole('button',{name:'Answer this question',exact:true}).click();
    assert.equal(await page.locator('#applicationAnswerKey').inputValue(),key);
    assert.equal(await page.locator('#applicationAnswerQuestion').inputValue(),question);
    assert.equal(await page.locator('#applicationAnswerValue').inputValue(),'','unknown authorization is not guessed');
    await page.locator('#applicationAnswerValue').fill('SYNTHETIC_USER_CONFIRMED_ANSWER');
    await page.locator('#applicationAnswerForm button[type="submit"]').click();await loaded();
    assert.deepEqual(calls.filter(item=>item.name==='save_application_answer').at(-1).body,{p_key:key,p_question:question,p_answer:'SYNTHETIC_USER_CONFIRMED_ANSWER'});
    assert.equal(data.jobs[0].status,'needs_input','saving a fact does not automatically requeue an application');
    await page.locator('#applicationJobList .application-entry').nth(0).getByRole('button',{name:'Queue again after reviewing answers'}).click();await loaded();
    assert.equal(data.jobs[0].status,'queued');

    data.jobs[0].status='submitted';data.jobs[0].receipt={};
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    assert.equal(await page.locator('#applicationConfirmedCount').textContent(),'Confirmed submissions shown: 0');
    assert.match(await page.locator('#applicationJobList').textContent(),/Confirmation missing/);
    data.jobs[0].receipt={adapter:'greenhouse',source_url:draft.source_url,confirmation_text:'SYNTHETIC_EMPLOYER_CONFIRMED_RECEIPT',confirmed_at:new Date().toISOString()};
    data.reports=[{id:'synthetic-report',local_date:'2026-11-04',generated_at:new Date().toISOString(),summary:'One confirmed synthetic submission. Paused and failed attempts stay separate.',confirmed:[{company:draft.company,title:draft.title}],blocked:[{company:secondDraft.company,title:secondDraft.title}],failed:[{company:'Synthetic Failed Employer',title:'Assistant'}],worker_last_seen_at:null}];
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    assert.equal(await page.locator('#applicationConfirmedCount').textContent(),'Confirmed submissions shown: 1');
    assert.equal(await page.locator('#applicationDraftList .badge').first().textContent(),'Prepared draft');
    assert.doesNotMatch(await page.locator('#applicationDraftStatus').textContent(),/No applications|Not submitted/i);
    assert.match(await page.locator('#applicationReportList').textContent(),/Confirmed submissions: 1/);
    assert.match(await page.locator('#applicationReportList').textContent(),/Paused attempts: 1/);
    assert.match(await page.locator('#applicationReportList').textContent(),/Failed attempts: 1/);
    assert.equal(await page.locator('#applicationReportList').getByText('Drafts', {exact:true}).count(),0);

    await page.locator('#applicationReportEnabled').uncheck();
    await page.locator('#applicationReportForm button').click();await loaded();
    assert.match(await page.locator('#applicationReportSchedule').textContent(),/disabled/);
    await page.locator('#applicationReportEnabled').check();
    await page.locator('#applicationReportTime').fill('20:00');
    await page.locator('#applicationReportForm button').click();await loaded();
    assert.deepEqual(calls.filter(item=>item.name==='set_application_report_schedule').at(-1).body,{p_local_time:'20:00',p_enabled:true});
    assert.match(await page.locator('#applicationAgentStatus').textContent(),/Email delivery is not connected/);

    await page.locator('#createApplicationConnector').click();
    await page.waitForFunction(()=>!document.getElementById('applicationConnectorSecret').hidden);
    workspaceFailure=true;
    await page.locator('#refreshApplicationWorkspace').click();
    await page.waitForFunction(()=>document.getElementById('applicationAgentStatus').textContent.includes('Could not load'));
    const assertPrivateCleared=async()=>{
      for(const id of ['applicationAnswerList','applicationConnectorList','applicationJobList','applicationReportList']) assert.equal(await page.locator('#'+id).textContent(),'');
      assert.equal(await page.locator('#applicationConnectorToken').inputValue(),'');
      assert.equal(await page.locator('#applicationAnswerQuestion').inputValue(),'');
      assert.equal(await page.locator('#applicationAnswerValue').inputValue(),'');
      assert.equal(await page.locator('#applicationAnswerScope option').count(),1);
      assert.equal(await page.locator('#applicationWorkspace').isHidden(),true);
      for(const secret of [token,'SYNTHETIC_PRIVATE_PHONE','SYNTHETIC_USER_CONFIRMED_ANSWER','SYNTHETIC_EMPLOYER_CONFIRMED_RECEIPT']) assert.equal(await page.evaluate(value=>document.body.textContent.includes(value),secret),false);
    };
    await assertPrivateCleared();
    workspaceFailure=false;
    await page.locator('#refreshApplicationWorkspace').click();await loaded();
    failProfile=true;
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Could not load your profile'));
    await assertPrivateCleared();
    failProfile=false;
    await page.reload();await loaded();
    // An async question-key calculation must not send account A's answer under
    // account B after signing out and signing in again without a page reload.
    const savesBeforeSwitch=calls.filter(item=>item.name==='save_application_answer').length;
    await page.locator('#newApplicationAnswer').click();
    await page.locator('#applicationAnswerScope').selectOption(draft.job_id);
    await page.locator('#applicationAnswerQuestion').fill('SYNTHETIC_ACCOUNT_A_PRIVATE_QUESTION');
    await page.locator('#applicationAnswerValue').fill('SYNTHETIC_ACCOUNT_A_PRIVATE_ANSWER');
    await page.evaluate(()=>{
      const digest=crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest=(...args)=>new Promise(resolve=>{
        window.__releaseAnswerDigest=async()=>resolve(await digest(...args));
      });
    });
    await page.locator('#applicationAnswerForm button[type="submit"]').click();
    await page.waitForFunction(()=>typeof window.__releaseAnswerDigest==='function');
    await page.locator('[data-view="preferences"]').click();
    await page.locator('#signOut').click();
    currentAccount={user:{id:'synthetic-second-user',email:'second@example.invalid'},access_token:'synthetic-second-access',refresh_token:'synthetic-second-refresh',expires_at:Math.floor(Date.now()/1000)+3600};
    data={answers:[],connectors:[],jobs:[],reports:[],report_preferences:{local_time:'20:00',timezone:'America/Chicago',enabled:true,delivery:'dashboard'}};
    await page.locator('#accountEmail').fill(currentAccount.user.email);
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>!document.getElementById('codeForm').hidden && !document.getElementById('loginCode').disabled);
    await page.locator('#loginCode').fill('12345678');
    await page.locator('#codeForm button').click();
    await loaded();
    await page.evaluate(()=>window.__releaseAnswerDigest());
    await page.waitForTimeout(100);
    assert.equal(calls.filter(item=>item.name==='save_application_answer').length,savesBeforeSwitch,'account A answer never mutates account B');
    assert.equal(await page.evaluate(()=>document.body.textContent.includes('SYNTHETIC_ACCOUNT_A_PRIVATE_ANSWER')),false);
    await page.locator('[data-view="applications"]').click();
    let release;
    workspaceGate=new Promise(resolve=>{release=resolve;});
    const pending=page.waitForRequest(req=>req.url().endsWith('/rpc/get_application_workspace'));
    await page.locator('#refreshApplicationWorkspace').click();await pending;
    await page.locator('[data-view="preferences"]').click();
    await page.locator('#signOut').click();
    await assertPrivateCleared();
    release();
    await page.waitForTimeout(100);
    await assertPrivateCleared();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('gmoney_session')),null);
    assert.deepEqual(errors,[]);
    console.log('PASS: two-draft queue modes, scoped unknown answers, proof-only confirmations, uncertainty/no-retry UI, one-time Windows key privacy, heartbeat truth, 8PM nightly report states, mobile layout, async answer account-switch isolation and in-flight sign-out/failure clearing.');
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
