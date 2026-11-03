// Run: node tests/profile-smoke.cjs (requires Playwright and Chromium).
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const server = http.createServer((req,res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html','assets/app.css','assets/app.js','assets/config.js','assets/profile.js'].includes(name)) {res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    const source=fs.readFileSync(path.join(__dirname,'..',name));
    res.end(name==='assets/config.js' ? source.toString()+'\nwindow.GMONEY_DB.emailMode="code";' : source);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const page = await browser.newPage();
    await page.clock.install();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let saved=null, failSave=false, failRead=false, failImport=false, importCalls=0, failDraftRead=false, draftCalls=0;
    const otpCalls=[], verifyCalls=[];
    let otpGate=null, verifyGate=null, otpFailure=null, verifyFailure=null, failOtpConnection=false;
    const importedProfile={user_id:'test-user',full_name:'Uploaded Candidate',resume_text:'Uploaded résumé text',preferred_roles:'Business roles',locations:['Houston'],sponsorship_need:'required_future'};
    const draft={id:'synthetic-draft',job_id:'synthetic-job',company:'Synthetic Employer',title:'Business Analyst <img src=x onerror="window.__draftHtmlExecuted=true">',location:'Houston, TX',source_url:'https://example.invalid/jobs/synthetic',status:'needs_input',tailored_summary:'Synthetic résumé summary <script>window.__draftHtmlExecuted=true</script>',cover_letter:'Synthetic cover letter.\nPlease review before applying.',match_notes:['Synthetic Excel experience <b>is plain text</b>'],missing_answers:['Confirm the synthetic start date.'],created_at:'2026-11-03T06:00:00Z'};
    await page.route('https://*.supabase.co/**', async route => {
      const req=route.request(), url=req.url();
      const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(url.includes('/otp')) {
        assert.equal(req.method(),'POST');
        const body=req.postDataJSON();
        assert.deepEqual(Object.keys(body).sort(),['create_user','email']);
        assert.equal(body.create_user,true);
        otpCalls.push(body);
        const gate=otpGate;otpGate=null;
        if(gate) await gate;
        if(failOtpConnection) {failOtpConnection=false;return route.abort('connectionfailed');}
        const failure=otpFailure;otpFailure=null;
        return failure ? reply(failure.body,failure.status) : reply({});
      }
      if(url.includes('/verify')) {
        assert.equal(req.method(),'POST');
        const body=req.postDataJSON();
        assert.deepEqual(Object.keys(body).sort(),['email','token','type']);
        assert.equal(body.type,'email');
        assert.match(body.token,/^\d{8}$/);
        verifyCalls.push(body);
        const gate=verifyGate;verifyGate=null;
        if(gate) await gate;
        const failure=verifyFailure;verifyFailure=null;
        if(failure?.raw) return route.fulfill({status:failure.status,contentType:'application/json',body:failure.raw});
        return failure ? reply(failure.body,failure.status) : reply({user:{id:'test-user',email:'test@example.com'},access_token:'test-access',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600});
      }
      if(url.includes('/logout')) return route.fulfill({status:204});
      if(url.includes('/rpc/claim_candidate_profile')) {
        assert.equal(req.method(),'POST');
        assert.equal(req.headers().authorization,'Bearer test-access');
        assert.deepEqual(req.postDataJSON(),{});
        importCalls++;
        if(failImport) return reply({},503);
        if(!saved) { saved={...importedProfile}; return reply({imported:true}); }
        return reply({imported:false});
      }
      if(url.includes('/rpc/list_candidate_application_drafts')) {
        assert.equal(req.method(),'POST');
        assert.equal(req.headers().authorization,'Bearer test-access');
        assert.deepEqual(req.postDataJSON(),{});
        draftCalls++;
        return failDraftRead ? reply({},503) : reply([draft]);
      }
      if(url.includes('/agent_preferences')) {
        assert.equal(req.headers().authorization,'Bearer test-access');
        if(req.method()==='POST') {if(failSave)return reply({},500);saved=req.postDataJSON();return route.fulfill({status:204});}
        return reply(saved?[saved]:[],failRead?503:200);
      }
      return reply([]);
    });
    const base='http://127.0.0.1:'+server.address().port;
    await page.goto(base+'/#applications');
    assert.equal(draftCalls,0);
    assert.equal(await page.locator('#applicationDraftList article').count(),0);
    assert.equal(await page.locator('#privateApplicationDrafts').isHidden(),true);
    assert.equal(await page.locator('#refreshApplicationDrafts').isDisabled(),true);
    assert.match(await page.locator('#applicationDraftStatus').textContent(),/Sign in to view/);
    await page.locator('#applicationDraftSignIn').click();
    assert.equal(await page.locator('#preferencesForm').isHidden(),true);
    const requestAuthForms=()=>page.evaluate(()=>{
      document.getElementById('emailForm').requestSubmit();
      document.getElementById('codeForm').requestSubmit();
    });
    let releaseOtp;
    otpGate=new Promise(resolve=>{releaseOtp=resolve;});
    await page.locator('#accountEmail').fill('test@example.com');
    const initialSend=page.waitForRequest(req=>req.url().endsWith('/auth/v1/otp'));
    await page.locator('#emailForm button').click();await initialSend;
    assert.equal(await page.locator('#accountEmail').isDisabled(),true);
    assert.equal(await page.locator('#codeForm button').isDisabled(),true);
    await requestAuthForms();
    releaseOtp();
    await page.waitForFunction(()=>!document.getElementById('codeForm').hidden && !document.getElementById('loginCode').disabled);
    assert.equal(otpCalls.length,1);assert.equal(verifyCalls.length,0);
    assert.equal(await page.locator('#codeDestination').textContent(),'Enter the code sent to test@example.com.');
    assert.equal(await page.locator('#emailForm button').isDisabled(),true);
    verifyFailure={status:422,body:{code:'otp_expired',msg:'Untrusted private server detail <img src=x>'}};
    await page.locator('#loginCode').fill('11112222');await page.locator('#codeForm button').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('invalid or expired'));
    assert.equal(await page.locator('#preferencesForm').isHidden(),true);
    assert.equal(await page.locator('#codeForm').isHidden(),false);
    assert.equal(await page.locator('#codeForm button').isDisabled(),false);
    assert.doesNotMatch(await page.locator('#authStatus').textContent(),/Untrusted|private server|<img/);
    verifyFailure={status:200,raw:'Untrusted malformed success response'};
    await page.locator('#loginCode').fill('22223333');await page.locator('#codeForm button').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('response could not be read'));
    assert.doesNotMatch(await page.locator('#authStatus').textContent(),/Untrusted|malformed success/);
    verifyFailure={status:200,body:null};
    await page.locator('#loginCode').fill('33334444');await page.locator('#codeForm button').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Sign-in failed. Request a new code.'));
    assert.equal(await page.locator('#preferencesForm').isHidden(),true);
    await page.clock.fastForward(61000);
    await page.locator('#loginCode').fill('87654321');
    otpGate=new Promise(resolve=>{releaseOtp=resolve;});
    const resend=page.waitForRequest(req=>req.url().endsWith('/auth/v1/otp'));
    await page.locator('#emailForm button').click();await resend;
    assert.equal(await page.locator('#loginCode').isDisabled(),true);
    assert.equal(await page.locator('#codeForm button').isDisabled(),true);
    await requestAuthForms();
    releaseOtp();
    await page.waitForFunction(()=>!document.getElementById('loginCode').disabled && document.getElementById('loginCode').value==='');
    assert.equal(otpCalls.length,2);assert.equal(verifyCalls.length,3);
    await page.clock.fastForward(61000);
    await page.locator('#loginCode').fill('87654321');
    await page.locator('#accountEmail').fill('changed@example.com');
    otpFailure={status:500,body:{error_code:'unexpected_failure',msg:'Untrusted SMTP secret'}};
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Could not send a sign-in code'));
    assert.equal(await page.locator('#codeDestination').textContent(),'Enter the code sent to test@example.com.');
    assert.equal(await page.locator('#loginCode').inputValue(),'87654321');
    assert.doesNotMatch(await page.locator('#authStatus').textContent(),/Untrusted|SMTP secret/);
    otpFailure={status:429,body:{error_code:'over_email_send_rate_limit',msg:'Untrusted rate-limit detail'}};
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Wait at least a minute'));
    assert.equal(await page.locator('#emailForm button').isDisabled(),true);
    assert.equal(await page.locator('#codeDestination').textContent(),'Enter the code sent to test@example.com.');
    await page.clock.fastForward(61000);
    failOtpConnection=true;
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Check your connection'));
    assert.equal(await page.locator('#codeForm button').isDisabled(),false);
    let releaseVerify;
    verifyGate=new Promise(resolve=>{releaseVerify=resolve;});
    const verification=page.waitForRequest(req=>req.url().endsWith('/auth/v1/verify'));
    await page.locator('#codeForm button').click();await verification;
    assert.equal(await page.locator('#emailForm button').isDisabled(),true);
    assert.equal(await page.locator('#codeForm button').isDisabled(),true);
    await requestAuthForms();
    releaseVerify();
    await page.waitForFunction(()=>!document.getElementById('profileFields').disabled);
    assert.deepEqual(verifyCalls,[
      {email:'test@example.com',token:'11112222',type:'email'},
      {email:'test@example.com',token:'22223333',type:'email'},
      {email:'test@example.com',token:'33334444',type:'email'},
      {email:'test@example.com',token:'87654321',type:'email'}
    ]);
    assert.deepEqual(otpCalls.map(body=>body.email),['test@example.com','test@example.com','changed@example.com','changed@example.com','changed@example.com']);
    assert.equal(importCalls,1);
    assert.equal(await page.locator('#resumeText').inputValue(),'Uploaded résumé text');
    assert.equal(await page.locator('#fullName').inputValue(),'Uploaded Candidate');
    assert.match(await page.locator('#saveStatus').textContent(),/uploaded résumé is ready/);
    await page.waitForFunction(()=>document.getElementById('applicationDraftStatus').textContent.includes('1 private application drafts ready'));
    assert.equal(draftCalls,1);
    await page.locator('button[data-view="applications"]').click();
    const card=page.locator('#applicationDraftList article');
    assert.equal(await card.count(),1);
    assert.equal(await card.isVisible(),true);
    assert.equal(await card.locator('h3').textContent(),draft.title);
    assert.match(await card.locator('.meta').textContent(),/Synthetic Employer · Houston, TX/);
    assert.equal(await card.locator('.badge').textContent(),'Needs your answers · Not submitted');
    assert.equal(await card.locator('a').getAttribute('href'),draft.source_url);
    assert.equal(await card.locator('a').getAttribute('target'),'_blank');
    assert.match(await card.locator('a').getAttribute('rel'),/noopener/);
    assert.match(await card.locator('a').getAttribute('rel'),/noreferrer/);
    assert.equal(await card.locator('details').nth(0).locator('p').textContent(),draft.tailored_summary);
    assert.equal(await card.locator('details').nth(1).locator('p').textContent(),draft.cover_letter);
    assert.deepEqual(await card.locator('li').allTextContents(),[...draft.match_notes,...draft.missing_answers]);
    assert.equal(await card.locator('img,script,b').count(),0);
    assert.equal(await page.evaluate(()=>window.__draftHtmlExecuted),undefined);
    assert.match(await page.locator('#applicationDraftStatus').textContent(),/No applications have been submitted/);
    failDraftRead=true;
    await page.locator('#refreshApplicationDrafts').click();
    await page.waitForFunction(()=>document.getElementById('applicationDraftStatus').textContent.includes('Could not load your private drafts'));
    assert.equal(await card.count(),0);
    assert.equal(await page.locator('#privateApplicationDrafts').isHidden(),true);
    assert.equal(await page.locator('#refreshApplicationDrafts').isDisabled(),false);
    assert.doesNotMatch(await page.locator('#applicationDraftStatus').textContent(),/No private application drafts are prepared/);
    failDraftRead=false;
    await page.locator('#refreshApplicationDrafts').click();
    await page.waitForFunction(()=>document.getElementById('applicationDraftStatus').textContent.includes('1 private application drafts ready'));
    assert.equal(await card.count(),1);
    assert.equal(draftCalls,3);
    await page.locator('button[data-view="preferences"]').click();
    await page.locator('#fullName').fill('Test Candidate');await page.locator('#resumeText').fill('Real experience');
    await page.locator('#locations').fill('Houston, TX; Remote');await page.locator('#salary').fill('80000');
    await page.locator('#sponsorship').selectOption('required_future');
    await page.locator('#preferencesForm button').click();
    await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Profile saved'));
    assert.equal(saved.user_id,'test-user');assert.deepEqual(saved.locations,['Houston, TX','Remote']);assert.equal(saved.minimum_salary,80000);
    await page.reload();await page.waitForFunction(()=>!document.getElementById('profileFields').disabled);
    assert.equal(await page.locator('#resumeText').inputValue(),'Real experience');
    assert.equal(importCalls,2);
    failImport=true;await page.reload();await page.waitForFunction(()=>!document.getElementById('profileFields').disabled);
    assert.equal(await page.locator('#resumeText').inputValue(),'Real experience');
    assert.match(await page.locator('#saveStatus').textContent(),/import is unavailable/);
    assert.equal(importCalls,3);
    failSave=true;await page.locator('#preferencesForm button').click();await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Request failed'));
    failRead=true;await page.reload();await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Could not load'));
    assert.equal(await page.locator('#resumeText').isDisabled(),true);
    assert.equal(await card.count(),0);
    failRead=false;await page.reload();
    await page.waitForFunction(()=>document.getElementById('applicationDraftStatus').textContent.includes('1 private application drafts ready'));
    assert.equal(await card.count(),1);
    await page.locator('#signOut').click();assert.equal(await page.locator('#resumeText').inputValue(),'');
    assert.equal(await card.count(),0);
    assert.equal(await page.locator('#privateApplicationDrafts').evaluate(node=>node.hidden),true);
    assert.match(await page.locator('#applicationDraftStatus').textContent(),/Sign in to view/);
    assert.equal(await page.evaluate(text=>document.body.textContent.includes(text),draft.tailored_summary),false);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('gmoney_session')),null);
    assert.equal(await page.locator('#loginCode').inputValue(),'');
    assert.equal(await page.locator('#codeDestination').textContent(),'');
    assert.equal(await page.locator('#codeForm').isHidden(),true);
    for(const fragment of [
      '#access_token=untrusted-url-access&refresh_token=untrusted-url-refresh&type=magiclink',
      '#error=access_denied&error_code=otp_expired&error_description=untrusted-url-error'
    ]) {
      const legacy=await browser.newPage();
      legacy.on('pageerror',e=>errors.push(e.message));
      let backendRequests=0;
      await legacy.route('https://*.supabase.co/**',route=>{
        backendRequests++;
        assert.equal(new URL(route.request().frame().url()).hash,'#preferences');
        assert.equal(route.request().url().includes('/auth/v1/'),false);
        return route.fulfill({status:200,contentType:'application/json',body:'[]'});
      });
      await legacy.goto(base+'/'+fragment);
      assert.equal(new URL(legacy.url()).hash,'#preferences');
      assert.equal(await legacy.locator('#preferences').isVisible(),true);
      assert.match(await legacy.locator('#authStatus').textContent(),/Request a new sign-in code/);
      assert.equal(await legacy.evaluate(()=>sessionStorage.getItem('gmoney_session')),null);
      assert.doesNotMatch(await legacy.evaluate(()=>location.href+document.body.textContent+JSON.stringify({...sessionStorage,...localStorage})),/untrusted-url-/);
      assert.ok(backendRequests>0);
      await legacy.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: email-code payload, invalid-code recovery, resend clearing/cooldown, failed-send destination preservation, concurrency guards and sanitized legacy links; private drafts, profile import/save/restore/failures and sign-out privacy.');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
