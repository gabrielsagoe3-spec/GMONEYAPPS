// Run: node tests/profile-smoke.cjs (requires Playwright and Chromium).
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const server = http.createServer((req,res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
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
    let saved=null, failSave=false, failRead=false;
    await page.route('https://*.supabase.co/**', async route => {
      const req=route.request(), url=req.url();
      const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(url.includes('/otp')) {assert.equal(req.postDataJSON().email,'test@example.com');return reply({});}
      if(url.includes('/verify')) return reply({user:{id:'test-user',email:'test@example.com'},access_token:'test-access',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600});
      if(url.includes('/logout')) return route.fulfill({status:204});
      if(url.includes('/agent_preferences')) {
        assert.equal(req.headers().authorization,'Bearer test-access');
        if(req.method()==='POST') {if(failSave)return reply({},500);saved=req.postDataJSON();return route.fulfill({status:204});}
        return reply(saved?[saved]:[],failRead?503:200);
      }
      return reply([]);
    });
    const base='http://127.0.0.1:'+server.address().port;
    await page.goto(base+'/#preferences');
    assert.equal(await page.locator('#preferencesForm').isHidden(),true);
    await page.locator('#accountEmail').fill('test@example.com');await page.locator('#emailForm button').click();
    await page.locator('#loginCode').fill('123456');await page.locator('#codeForm button').click();
    await page.waitForFunction(()=>!document.getElementById('profileFields').disabled);
    await page.locator('#fullName').fill('Test Candidate');await page.locator('#resumeText').fill('Real experience');
    await page.locator('#locations').fill('Houston, TX; Remote');await page.locator('#salary').fill('80000');
    await page.locator('#sponsorship').selectOption('required_future');
    await page.locator('#preferencesForm button').click();
    await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Profile saved'));
    assert.equal(saved.user_id,'test-user');assert.deepEqual(saved.locations,['Houston, TX','Remote']);assert.equal(saved.minimum_salary,80000);
    await page.reload();await page.waitForFunction(()=>!document.getElementById('profileFields').disabled);
    assert.equal(await page.locator('#resumeText').inputValue(),'Real experience');
    failSave=true;await page.locator('#preferencesForm button').click();await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Request failed'));
    failRead=true;await page.reload();await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Could not load'));
    assert.equal(await page.locator('#resumeText').isDisabled(),true);
    await page.locator('#signOut').click();assert.equal(await page.locator('#resumeText').inputValue(),'');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('gmoney_session')),null);
    assert.deepEqual(errors,[]);
    console.log('PASS: sign-in, authenticated saves, reload, save failure, protected load failure, sign-out clears data.');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
