import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {applicationTarget,allowedNavigation,performApplication} from '../src/browser.mjs';
import {answerFor,questionKey} from '../src/answers.mjs';
import {ConnectorApi} from '../src/api.mjs';
import {runNext} from '../src/runner.mjs';
import {notifyLatestReport} from '../src/notify.mjs';

const job={id:'11111111-1111-4111-8111-111111111111',job_id:'greenhouse-example-42',draft_id:'22222222-2222-4222-8222-222222222222',company:'Synthetic Employer',title:'Business Analyst',source_url:'https://job-boards.greenhouse.io/example/jobs/42',mode:'submit'};
const answers=[{key:'first_name',question:'First name',answer:'Synthetic'},{key:'last_name',question:'Last name',answer:'Candidate'},{key:'email',question:'Email',answer:'candidate@example.invalid'}];
const fields='<label>First name<input name="first_name" required></label><label>Last name<input name="last_name" required></label><label>Email<input name="email" type="email" required></label><label>Resume<input name="resume" type="file" style="display:none" required></label>';
const html=(extra='',success=true)=>`<p id="intro"></p><form>${fields}${extra}<button type="submit">Submit application</button></form><script>window.clicks=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.clicks++;${success?"document.querySelector('form').remove();document.getElementById('intro').textContent='Your application has been submitted successfully.';":"document.querySelector('form').style.display='none';"}};</script>`;
let browser,home,resume;
test.before(async()=>{home=await mkdtemp(join(tmpdir(),'gmoney-connector-test-'));resume=join(home,'synthetic.pdf');await writeFile(resume,'%PDF-1.4\nSynthetic local test only.');browser=await chromium.launch({headless:true,executablePath:process.env.GMONEY_TEST_CHROMIUM||(process.platform==='win32'?undefined:'/usr/bin/chromium'),args:['--no-sandbox']});});
test.after(async()=>{if(browser)await browser.close();if(home)await rm(home,{recursive:true,force:true});});
async function pageFor(content){const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent(content);page.waitForTimeout=async()=>{};return page;}

test('ATS URL identity is fixed to employer, board and exact job; Datadog mapping is explicit',()=>{
 assert.equal(applicationTarget(job).board,'example');
 const target=applicationTarget(job);
 assert.equal(allowedNavigation('https://job-boards.greenhouse.io/example/jobs/42/thank_you',target),true);
 for(const url of ['https://job-boards.greenhouse.io/other/jobs/42','https://job-boards.greenhouse.io/other/thank_you','https://job-boards.greenhouse.io/example/jobs/420','https://127.0.0.1/jobs/42','http://job-boards.greenhouse.io/example/jobs/42'])assert.equal(allowedNavigation(url,target),false,url);
 for(const url of ['http://localhost:8000/job','https://127.0.0.1/job','https://user:secret@job-boards.greenhouse.io/example/jobs/42','https://example.com/job','javascript:alert(1)'])assert.throws(()=>applicationTarget({...job,source_url:url}));
 assert.equal(applicationTarget({...job,job_id:'greenhouse-datadog-7172466',source_url:'https://careers.datadoghq.com/detail/7172466/?gh_jid=7172466'}).url,'https://job-boards.greenhouse.io/datadog/jobs/7172466');
 assert.throws(()=>applicationTarget({...job,source_url:'https://careers.datadoghq.com/detail/7172466/?gh_jid=7172466'}));
});
test('custom answers are job-scoped; authorization, demographics and inverse sponsorship are never inferred',()=>{
 const question='Why do you want to work here?',bank=[{key:questionKey(question,'job-a'),question,answer:'Company A specific answer'},{key:'requires_sponsorship',answer:'Yes'}];
 assert.equal(answerFor(question,bank,'job-a').answer,'Company A specific answer');
 assert.equal(answerFor(question,bank,'job-b'),null);
 for(const q of ['Are you legally authorized to work in the United States?','Do you currently require sponsorship?','Do you not require sponsorship?','Gender'])assert.equal(answerFor(q,bank,'job-a'),null,q);
 assert.equal(answerFor('Will you now or in the future require visa sponsorship?',bank,'job-a').answer,'Yes');
});
test('hidden résumé input is filled and the checkpoint precedes a single confirmed employer submission',async()=>{
 const page=await pageFor(html());let checkpoint=false;
 const result=await performApplication({page,job,answers,resumePath:resume,mode:'submit',beforeSubmit:async()=>{assert.equal(await page.evaluate(()=>window.clicks),0);checkpoint=true;assert.equal(await page.locator('input[type=file]').evaluate(n=>n.files.length),1);}});
 assert.equal(checkpoint,true);assert.equal(result.status,'submitted');assert.equal(result.receipt.source_url,job.source_url);assert.equal(result.receipt.adapter,'greenhouse');assert.match(result.receipt.confirmation_text,/application has been submitted/i);assert.match(result.receipt.screenshot_sha256,/^[a-f0-9]{64}$/);assert.equal(await page.evaluate(()=>window.clicks),1);await page.close();
});
test('unknown required legal authorization blocks before the checkpoint or submit click',async()=>{
 const page=await pageFor(html('<label>Are you legally authorized to work in the United States?<select required><option value="">Choose</option><option>Yes</option><option>No</option></select></label>'));
 const result=await performApplication({page,job,answers,resumePath:resume,mode:'submit',beforeSubmit:async()=>assert.fail('must not checkpoint')});
 assert.equal(result.status,'needs_input');assert.match(result.questions[0].question,/legally authorized/);assert.equal(await page.evaluate(()=>window.clicks),0);await page.close();
});
test('readonly wrong identity and unapproved optional preselected eligibility block',async()=>{
 for(const extra of ['<label>Email<input type="email" readonly value="wrong@example.invalid"></label>','<label>Email<input type="email" readonly value="candidate@example-invalid"></label>','<label>Gender<select><option selected>Female</option><option>Male</option></select></label>','<fieldset><legend>Are you a US citizen?</legend><label><input type="radio" name="citizen" value="yes" checked>Yes</label><label><input type="radio" name="citizen" value="no">No</label></fieldset>','<div role="combobox" aria-label="Country">Canada</div>']) {
  const page=await pageFor(html(extra));const result=await performApplication({page,job,answers,resumePath:resume,mode:'submit',beforeSubmit:async()=>assert.fail('must not checkpoint')});assert.equal(result.status,'needs_input',extra);assert.equal(await page.evaluate(()=>window.clicks),0);await page.close();
 }
});
test('unknown editable optional text and checkbox defaults are cleared',async()=>{
 const page=await pageFor(html('<label>Current company<input name="current_company" value="Unapproved old employer"></label><label>Newsletter opt in<input type="checkbox" checked></label>'));
 const result=await performApplication({page,job,answers,resumePath:resume,mode:'prepare',beforeSubmit:async()=>assert.fail('dry run must not checkpoint')});assert.equal(result.status,'ready');assert.equal(await page.locator('[name=current_company]').inputValue(),'');assert.equal(await page.locator('input[type=checkbox]').isChecked(),false);assert.equal(await page.evaluate(()=>window.clicks),0);await page.close();
});
test('preexisting success-like text is not accepted as submission evidence',async()=>{
 const page=await pageFor(html('',false));await page.locator('#intro').evaluate(node=>node.textContent='Thank you for applying.');
 const result=await performApplication({page,job,answers,resumePath:resume,mode:'submit',beforeSubmit:async()=>{}});assert.equal(result.status,'needs_confirmation');assert.equal(result.receipt,undefined);assert.equal(await page.evaluate(()=>window.clicks),1);await page.close();
});
test('a lost receipt save never reports confirmed submission or requeues after the checkpoint',async()=>{
 const page=await pageFor(html()),calls=[];const local=await mkdtemp(join(home,'lost-receipt-'));
 const api={call:async(action,payload)=>{calls.push({action,payload});if(action==='claim')return {job,lease_token:'lease-test',answers};if(action==='before_submit')return {status:'submitting'};if(action==='result')throw Error('synthetic response lost');return {};}};
 const result=await runNext(api,{home:local,resume_path:resume},{browserFactory:async()=>({page,close:()=>page.close()})});assert.equal(result.status,'needs_confirmation');assert.equal(calls.filter(c=>c.action==='before_submit').length,1);assert.equal(calls.filter(c=>c.action==='claim').length,1);assert.equal(calls.filter(c=>c.action==='result').length,1);assert.equal(calls.some(c=>c.action==='queue'),false);
});
test('API errors never expose a reflected credential or private server body',async()=>{
 const token='gmcp_'+'a'.repeat(64),api=new ConnectorApi({token,fetchImpl:async()=>new Response('secret '+token+' private contact',{status:401})});
 await assert.rejects(api.call('workspace'),error=>!String(error).includes(token)&&!String(error).includes('private contact'));
});
test('nightly Windows notification uses generated reports and does not repeat one',async()=>{
 const local=await mkdtemp(join(home,'notify-'));let shown=0;
 const api={call:async()=>({reports:[{id:'report-1',generated_at:'2026-11-05T02:05:00Z',summary:'0 confirmed applications. 1 blocked attempt.'}]})};
 const show=async(path,message)=>{shown++;assert.equal(message.title,'G Money nightly application report');assert.match(await readFile(path,'utf8'),/0 confirmed/);return {status:0};};
 assert.equal((await notifyLatestReport(api,{home:local},{platform:'win32',show})).notified,true);assert.equal((await notifyLatestReport(api,{home:local},{platform:'win32',show})).notified,false);assert.equal(shown,1);
});
test('official SDK stdio server initializes and advertises real tools without a credential',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],stderr:'pipe'});
 const client=new Client({name:'synthetic-connector-test',version:'1.0.0'});try{await client.connect(transport);const listed=await client.listTools();const names=listed.tools.map(tool=>tool.name);for(const name of ['get_workspace','remember_answer','queue_application','dry_run_next','process_next','list_nightly_reports','status'])assert.ok(names.includes(name),name);}finally{await client.close();}
});
