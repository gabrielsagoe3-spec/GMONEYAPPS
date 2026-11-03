// Run: node tests/email-link-smoke.cjs (requires Playwright and Chromium).
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

(async () => {
  const recordKey='gmoney_email_link';
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const name=pathname==='/' ? 'index.html' : pathname.slice(1);
    if(!['index.html','assets/app.css','assets/app.js','assets/config.js','assets/profile.js'].includes(name)) {res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    let source=fs.readFileSync(path.join(__dirname,'..',name),'utf8');
    if(name==='assets/config.js') source+='\nwindow.GMONEY_DB.emailMode="link";\n';
    res.end(source);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  const errors=[];
  try {
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const importedProfile={user_id:'link-user',full_name:'Synthetic Link Candidate',resume_text:'Synthetic imported résumé',locations:['Houston'],sponsorship_need:'required_future'};
    const draft={id:'synthetic-link-draft',company:'Synthetic Employer',title:'Business Analyst',location:'Houston',source_url:'https://example.invalid/job',status:'needs_input',tailored_summary:'Synthetic private summary',cover_letter:'Synthetic private cover letter',match_notes:['Synthetic fit note'],missing_answers:['Confirm availability']};
    const pendingRecord=overrides=>({version:1,email:'test@example.com',verifier:'a'.repeat(43),requestedAt:Date.now(),requestId:'synthetic-request',...overrides});
    async function harness() {
      const context=await browser.newContext();
      const state={otp:[],tokens:[],imports:0,drafts:0,backend:0,otpFailure:null,tokenFailure:null,otpGate:null,tokenEmail:'TEST@EXAMPLE.COM'};
      context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
      await context.route('https://*.supabase.co/**',async route=>{
        const req=route.request(),url=new URL(req.url());
        const frameURL=new URL(req.frame().url());
        state.backend++;
        for(const key of ['code','error','error_code','error_description','access_token','refresh_token']) assert.equal(frameURL.searchParams.has(key),false,'callback query must be scrubbed before backend requests');
        assert.doesNotMatch(frameURL.hash,/access_token|refresh_token|error_description/);
        assert.equal(req.headers().referer,undefined,'callback page must not send a referrer');
        const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
        if(url.pathname==='/auth/v1/otp') {
          assert.equal(req.method(),'POST');
          assert.equal(url.searchParams.get('redirect_to'),base+'/');
          const body=req.postDataJSON();
          assert.deepEqual(Object.keys(body).sort(),['code_challenge','code_challenge_method','create_user','email']);
          assert.equal(body.create_user,true);assert.equal(body.code_challenge_method,'s256');
          const record=await req.frame().evaluate(key=>JSON.parse(localStorage.getItem(key)),recordKey);
          assert.equal(record.version,1);assert.equal(record.email,body.email);
          assert.match(record.verifier,/^[A-Za-z0-9_-]{43}$/);
          assert.equal(typeof record.requestId,'string');assert.ok(record.requestId.length>0);
          assert.equal(typeof record.requestedAt,'number');
          assert.equal(body.code_challenge,crypto.createHash('sha256').update(record.verifier).digest('base64url'));
          state.otp.push({body,record});
          const gate=state.otpGate;state.otpGate=null;if(gate) await gate;
          const failure=state.otpFailure;state.otpFailure=null;
          return failure ? reply(failure.body,failure.status) : reply({});
        }
        if(url.pathname==='/auth/v1/token') {
          assert.equal(req.method(),'POST');assert.equal(url.searchParams.get('grant_type'),'pkce');
          const body=req.postDataJSON();
          assert.deepEqual(Object.keys(body).sort(),['auth_code','code_verifier']);
          state.tokens.push(body);
          const failure=state.tokenFailure;
          return failure ? reply(failure.body,failure.status) : reply({user:{id:'link-user',email:state.tokenEmail},access_token:'synthetic-link-access',refresh_token:'synthetic-link-refresh',expires_at:Math.floor(Date.now()/1000)+3600});
        }
        if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
        if(url.pathname.endsWith('/rpc/claim_candidate_profile')) {
          assert.equal(req.headers().authorization,'Bearer synthetic-link-access');
          state.imports++;return reply({imported:true});
        }
        if(url.pathname.endsWith('/rpc/list_candidate_application_drafts')) {
          assert.equal(req.headers().authorization,'Bearer synthetic-link-access');
          state.drafts++;return reply([draft]);
        }
        if(url.pathname.endsWith('/agent_preferences')) {
          assert.equal(req.headers().authorization,'Bearer synthetic-link-access');
          return reply([importedProfile]);
        }
        if(url.pathname.endsWith('/published_research_reports')) return reply([{report:{updatedAt:'2026-11-03',summary:'Synthetic report',scope:'Synthetic scope',records:[],additionalSources:[]}}]);
        if(url.pathname.endsWith('/research_automation_status')) return reply([]);
        throw Error('Unexpected backend request: '+url.pathname);
      });
      const page=await context.newPage();await page.clock.install();
      await page.goto(base+'/#preferences');
      assert.equal(await page.locator('#codeForm').isHidden(),true);
      assert.match(await page.locator('#emailForm button').textContent(),/sign-in link/i);
      assert.equal(await page.locator('meta[name="referrer"]').getAttribute('content'),'no-referrer');
      return {context,page,state};
    }
    const readRecord=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),recordKey);
    const setRecord=(page,record)=>page.evaluate(({key,record})=>record ? localStorage.setItem(key,JSON.stringify(record)) : localStorage.removeItem(key),{key:recordKey,record});
    async function assertSignedOut(page) {
      assert.equal(await page.locator('#preferencesForm').isHidden(),true);
      assert.equal(await page.locator('#codeForm').isHidden(),true);
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('gmoney_session')),null);
      assert.equal(await page.locator('#applicationDraftList article').count(),0);
      assert.doesNotMatch(await page.locator('#authStatus').textContent(),/untrusted-private|synthetic-link-access|synthetic-link-refresh/);
      assert.equal(await page.evaluate(()=>Object.hasOwn(window,'GMONEY_AUTH_CALLBACK')),false);
    }
    async function waitForLinkFailure(page) {
      await page.waitForFunction(()=>/request.*(?:new|another).*link|link.*(?:invalid|expired|failed|different|browser)|could not.*sign|could not.*link/i.test(document.getElementById('authStatus').textContent));
      await assertSignedOut(page);
    }

    // A real cryptographic challenge is derived from the stored verifier before sending.
    // Returning in another tab shares the verifier, while session tokens remain tab-local.
    for(const newTab of [false,true]) {
      const {context,page,state}=await harness();
      let release;
      state.otpGate=new Promise(resolve=>{release=resolve;});
      await page.locator('#accountEmail').fill('test@example.com');
      const sending=page.waitForRequest(req=>new URL(req.url()).pathname==='/auth/v1/otp');
      await page.locator('#emailForm button').click();await sending;
      assert.equal(await page.locator('#emailForm button').isDisabled(),true);
      await page.evaluate(()=>{document.getElementById('emailForm').requestSubmit();document.getElementById('codeForm').requestSubmit();});
      release();
      await page.waitForFunction(()=>/check your email/i.test(document.getElementById('authStatus').textContent));
      assert.match(await page.locator('#authStatus').textContent(),/same browser|same device/i);
      assert.equal(state.otp.length,1);assert.equal(state.tokens.length,0);
      const record=await readRecord(page);
      assert.doesNotMatch(await page.locator('body').textContent(),new RegExp(record.verifier));
      const callback=newTab ? await context.newPage() : page;
      await callback.goto(base+'/?keep=retained&code=synthetic-auth-code#overview');
      await callback.waitForFunction(()=>!document.getElementById('profileFields').disabled);
      await callback.waitForFunction(()=>document.getElementById('applicationDraftList').childElementCount===1);
      assert.deepEqual(state.tokens,[{auth_code:'synthetic-auth-code',code_verifier:record.verifier}]);
      assert.equal(new URL(callback.url()).searchParams.get('keep'),'retained');
      assert.equal(new URL(callback.url()).searchParams.has('code'),false);
      assert.equal(new URL(callback.url()).hash,'#preferences');
      assert.equal(await callback.evaluate(()=>Object.hasOwn(window,'GMONEY_AUTH_CALLBACK')),false);
      assert.equal(await readRecord(callback),null);
      assert.equal(await callback.locator('#resumeText').inputValue(),importedProfile.resume_text);
      assert.equal(state.imports,1);assert.equal(state.drafts,1);
      assert.equal(await callback.locator('#applicationDraftList h3').textContent(),draft.title);
      assert.equal(await callback.evaluate(()=>JSON.parse(sessionStorage.getItem('gmoney_session')).access_token),'synthetic-link-access');
      if(newTab) assert.equal(await page.evaluate(()=>sessionStorage.getItem('gmoney_session')),null);
      await setRecord(callback,pendingRecord({email:'extra@example.com',requestId:'synthetic-extra-request'}));
      await callback.locator('#signOut').click();
      await callback.waitForFunction(key=>localStorage.getItem(key)===null,recordKey);
      assert.equal(await callback.locator('#resumeText').inputValue(),'');
      await assertSignedOut(callback);
      await context.close();
    }

    for(const invalid of [
      null,
      pendingRecord({requestedAt:Date.now()-3600001}),
      pendingRecord({verifier:'short'}),
      pendingRecord({verifier:'!'.repeat(43)})
    ]) {
      const {context,page,state}=await harness();
      await setRecord(page,invalid);
      await page.goto(base+'/?code=untrusted-private-auth-code');
      await waitForLinkFailure(page);
      assert.equal(state.tokens.length,0);assert.equal(state.imports,0);
      assert.equal(new URL(page.url()).searchParams.has('code'),false);
      await context.close();
    }

    for(const failure of ['wrong_email','exchange_failure','callback_error','raw_fragment']) {
      const {context,page,state}=await harness();
      await setRecord(page,pendingRecord());
      if(failure==='wrong_email') state.tokenEmail='someone-else@example.com';
      if(failure==='exchange_failure') state.tokenFailure={status:400,body:{error_code:'bad_code_verifier',msg:'untrusted-private-exchange-detail'}};
      const suffix=failure==='callback_error'
        ? '/?error=access_denied&error_code=otp_expired&error_description=untrusted-private-provider-detail'
        : failure==='raw_fragment'
          ? '/?keep=raw-fragment#access_token=untrusted-private-access&refresh_token=untrusted-private-refresh&type=magiclink'
          : '/?code=synthetic-auth-code';
      await page.goto(base+suffix);
      await waitForLinkFailure(page);
      assert.equal(state.tokens.length,['wrong_email','exchange_failure'].includes(failure) ? 1 : 0);
      assert.equal(state.imports,0);assert.equal(state.drafts,0);
      assert.doesNotMatch(await page.evaluate(()=>location.href+document.body.textContent+JSON.stringify({...sessionStorage})),/untrusted-private/);
      if(failure==='raw_fragment') {
        await page.evaluate(()=>{location.hash='access_token=untrusted-private-later-token&refresh_token=untrusted-private-later-refresh';});
        await page.waitForFunction(()=>location.hash==='#preferences');
        await assertSignedOut(page);
        assert.equal(state.tokens.length,0);
      }
      await context.close();
    }

    const blocked=await harness();
    await blocked.page.evaluate(key=>{
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(name,value) {
        if(this===localStorage && name===key) throw new DOMException('Synthetic storage denial','SecurityError');
        return original.call(this,name,value);
      };
    },recordKey);
    await blocked.page.locator('#accountEmail').fill('test@example.com');
    await blocked.page.locator('#emailForm button').click();
    await blocked.page.waitForFunction(()=>document.getElementById('authStatus').textContent.length>0);
    assert.equal(blocked.state.otp.length,0);assert.equal(blocked.state.tokens.length,0);
    assert.equal(await readRecord(blocked.page),null);
    await assertSignedOut(blocked.page);
    await blocked.context.close();

    // A failed replacement request cannot destroy a still-usable prior request.
    const {context,page,state}=await harness();
    await page.locator('#accountEmail').fill('test@example.com');await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>/check your email/i.test(document.getElementById('authStatus').textContent));
    const original=await readRecord(page);
    await page.clock.fastForward(61000);
    await page.locator('#accountEmail').fill('changed@example.com');
    state.otpFailure={status:500,body:{error_code:'unexpected_failure',msg:'untrusted-private-delivery-detail'}};
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>/could not send/i.test(document.getElementById('authStatus').textContent));
    assert.deepEqual(await readRecord(page),original);
    assert.notEqual(state.otp[1].record.verifier,original.verifier);
    await page.clock.fastForward(61000);
    state.otpFailure={status:429,body:{error_code:'over_email_send_rate_limit',msg:'untrusted-private-rate-detail'}};
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>/wait at least a minute/i.test(document.getElementById('authStatus').textContent));
    assert.deepEqual(await readRecord(page),original);
    assert.equal(await page.locator('#emailForm button').isDisabled(),true);
    await page.clock.fastForward(61000);
    assert.equal(await page.locator('#emailForm button').isDisabled(),false);
    assert.doesNotMatch(await page.locator('#authStatus').textContent(),/untrusted-private/);
    await page.locator('#emailForm button').click();
    await page.waitForFunction(()=>/check your email/i.test(document.getElementById('authStatus').textContent));
    const replacement=await readRecord(page);
    assert.equal(replacement.email,'changed@example.com');
    assert.notEqual(replacement.requestId,original.requestId);assert.notEqual(replacement.verifier,original.verifier);
    assert.equal(await page.locator('#codeForm').isHidden(),true);
    await context.close();
    assert.deepEqual(errors,[]);
    console.log('PASS: secure PKCE link request/challenge, same-tab and new-tab return, callback/referrer scrubbing, verifier expiry/validation, account binding, exchange rejection, failed-send restoration/rate limits, private profile/drafts and sign-out.');
  } finally {if(browser) await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
