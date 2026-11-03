// Run: node tests/automation-smoke.cjs (requires Playwright and Chromium).
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const files = ['index.html','assets/app.css','assets/app.js','assets/config.js','assets/profile.js'];
  const server = http.createServer((req,res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!files.includes(name)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(__dirname,'..',name)));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const page = await browser.newPage();
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    let report = {updatedAt:'2026-11-02',summary:'Previous curated report.',scope:'Entry-level analyst roles.',records:[],additionalSources:[]};
    let fail = false, scheduleFail = false, schedule = null;
    await page.route('https://*.supabase.co/**', route => {
      const scheduleRequest = route.request().url().includes('/research_automation_status?');
      const failed = scheduleRequest ? scheduleFail : fail;
      const data = scheduleRequest ? (schedule ? [schedule] : []) : [{report}];
      return route.fulfill({status:failed ? 503 : 200,contentType:'application/json',body:JSON.stringify(failed ? {} : data)});
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/#automation');
    await page.waitForFunction(()=>!document.getElementById('refreshAutomation').disabled);
    assert.equal(await page.locator('#automationRunStatus').textContent(),'No automated run published');
    assert.equal(await page.locator('#automationFetched').textContent(),'—');
    assert.equal(await page.locator('#automationSchedule').textContent(),'No recurring schedule reported');
    report = {...report,summary:'One lead and one exclusion.',records:[
      {id:'one',company:'Example employer',title:'Business Analyst <img src=x onerror="window.untrusted=true">',location:'Houston',decision:'Verify first',category:'verify',sponsorship:'Unknown; requires review.',finding:'Public posting fetched.',fit:'Business analyst title matches. Résumé fit is not established.',next:'Verify sponsorship.',url:'https://example.com/jobs/1',checkedAt:'2026-11-02'},
      {id:'two',company:'Other employer',title:'Operations Analyst',location:'Remote (US)',decision:'Ruled out',category:'excluded',sponsorship:'Employer excludes sponsorship.',finding:'Sponsorship requirement conflicts.',fit:'Role title matches but eligibility does not.',next:'Do not apply.',url:'https://example.com/jobs/2',checkedAt:'2026-11-02'}
    ],automation:{runId:'smoke-run',status:'partial',startedAt:'2026-11-02T12:00:00Z',finishedAt:'2026-11-02T12:01:00Z',execution:'one_shot',trigger:'scheduled',stats:{fetched:1200,relevant:2,selected:2,duplicates:0},sources:[
      {id:'good',name:'Example employer',url:'https://example.com/jobs',status:'ok',fetched:1200,invalid:0},
      {id:'bad',name:'Unavailable employer',url:'javascript:alert(1)',status:'failed',fetched:0,error:'HTTP 403 <script>window.untrusted=true</script>'}
    ]}};
    await page.locator('#refreshAutomation').click();
    await page.waitForFunction(()=>document.getElementById('automationRunId').textContent==='smoke-run');
    assert.equal(await page.locator('#automationRunStatus').textContent(),'Completed with source failures');
    assert.equal(await page.locator('#automationSources').textContent(),'1 / 2');
    assert.equal(await page.locator('#automationFetched').textContent(),'1,200');
    assert.equal(await page.locator('#automationSelected').textContent(),'2');
    assert.equal(await page.locator('#automationTrigger').textContent(),'Schedule-triggered run');
    assert.equal(await page.locator('#automationSchedule').textContent(),'No recurring schedule reported');
    assert.equal(await page.locator('#automationSourceList a').count(),1);
    assert.equal(await page.locator('#automationSourceList .source-error').textContent(),'HTTP 403 <script>window.untrusted=true</script>');
    assert.equal(await page.locator('#automationFindings img').count(),0);
    assert.equal(await page.evaluate(()=>window.untrusted),undefined);
    schedule = {schedule_enabled:true,schedule_expression:'17 */6 * * *',backend:'supabase',updated_at:'2026-11-02T12:00:00Z'};
    await page.locator('#refreshAutomation').click();
    await page.waitForFunction(()=>!document.getElementById('refreshAutomation').disabled);
    assert.equal(await page.locator('#automationSchedule').textContent(),'Configured every 6 hours');
    assert.match(await page.locator('#automationScheduleNote').textContent(),/Configuration recorded/);
    scheduleFail = true;
    report = {...report,summary:'A new report loaded while schedule settings were unavailable.'};
    await page.locator('#refreshAutomation').click();
    await page.waitForFunction(()=>!document.getElementById('refreshAutomation').disabled);
    assert.equal(await page.locator('#summary').textContent(),report.summary);
    assert.equal(await page.locator('#databaseStatus').textContent(),'Supabase connected · report loaded');
    assert.equal(await page.locator('#automationSchedule').textContent(),'Last reported: configured every 6 hours');
    assert.match(await page.locator('#automationScheduleNote').textContent(),/may be stale/);
    scheduleFail = false;
    schedule = {...schedule,schedule_enabled:false};
    await page.locator('#refreshAutomation').click();
    await page.waitForFunction(()=>!document.getElementById('refreshAutomation').disabled);
    assert.equal(await page.locator('#automationSchedule').textContent(),'Recurring searches disabled');
    assert.doesNotMatch(await page.locator('#automationScheduleNote').textContent(),/may be stale/);

    await page.locator('[data-view="research"]').click();
    await page.locator('[data-filter="verify"]').click();
    assert.equal(await page.locator('#records .finding').count(),1);
    await page.locator('[data-view="automation"]').click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true);
    if (process.env.GMONEY_SCREENSHOT_PATH) await page.screenshot({path:process.env.GMONEY_SCREENSHOT_PATH,fullPage:true});
    fail = true;
    schedule = {...schedule,schedule_enabled:true};
    await page.locator('#refreshAutomation').click();
    await page.waitForFunction(()=>document.getElementById('automationLoadState').textContent.includes('may be stale'));
    assert.equal(await page.locator('#automationRunId').textContent(),'smoke-run');
    await page.waitForFunction(()=>!document.getElementById('refreshAutomation').disabled);
    assert.equal(await page.locator('#automationSchedule').textContent(),'Configured every 6 hours');
    assert.equal(await page.locator('#refreshAutomation').isEnabled(),true);
    scheduleFail = true;
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('automationLoadState').textContent.includes('No automation results have been assumed'));
    assert.equal(await page.locator('#automationFetched').textContent(),'—');
    await page.waitForFunction(()=>!document.getElementById('refreshAutomation').disabled);
    assert.equal(await page.locator('#automationSchedule').textContent(),'Schedule status unavailable');
    await page.locator('[data-view="preferences"]').click();
    assert.equal(await page.locator('#emailForm').isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: legacy report, partial-run evidence, source failures, safe rendering, filters, mobile layout, independent enabled/disabled/unavailable schedules, stale results, failed initial load, profile navigation.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
