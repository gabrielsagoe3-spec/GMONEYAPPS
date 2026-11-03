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
    res.end(fs.readFileSync(path.join(__dirname,'..',name)));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const page = await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let saved=null, failSave=false, failRead=false, failImport=false, importCalls=0, failDraftRead=false, draftCalls=0;
    const importedProfile={user_id:'test-user',full_name:'Uploaded Candidate',resume_text:'Uploaded résumé text',preferred_roles:'Business roles',locations:['Houston'],sponsorship_need:'required_future'};
    const draft={id:'synthetic-draft',job_id:'synthetic-job',company:'Synthetic Employer',title:'Business Analyst <img src=x onerror="window.__draftHtmlExecuted=true">',location:'Houston, TX',source_url:'https://example.invalid/jobs/synthetic',status:'needs_input',tailored_summary:'Synthetic résumé summary <script>window.__draftHtmlExecuted=true</script>',cover_letter:'Synthetic cover letter.\nPlease review before applying.',match_notes:['Synthetic Excel experience <b>is plain text</b>'],missing_answers:['Confirm the synthetic start date.'],created_at:'2026-11-03T06:00:00Z'};
    await page.route('https://*.supabase.co/**', async route => {
      const req=route.request(), url=req.url();
      const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(url.includes('/otp')) {assert.equal(req.postDataJSON().email,'test@example.com');return reply({});}
      if(url.includes('/verify')) return reply({user:{id:'test-user',email:'test@example.com'},access_token:'test-access',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600});
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
    await page.locator('#accountEmail').fill('test@example.com');await page.locator('#emailForm button').click();
    await page.locator('#loginCode').fill('123456');await page.locator('#codeForm button').click();
    await page.waitForFunction(()=>!document.getElementById('profileFields').disabled);
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
    assert.deepEqual(errors,[]);
    console.log('PASS: private draft sign-in gate, authenticated listing, safe rendering, review-only status, error clearing and refresh recovery; profile import/save/restore/failure protection; sign-out clears private data.');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
