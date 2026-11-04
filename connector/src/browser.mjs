import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {answerFor,blockedQuestion,normalize} from './answers.mjs';
import {verifyResume} from './runtime.mjs';

const greenhouseHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','boards.eu.greenhouse.io','job-boards.eu.greenhouse.io']);
const leverHosts=new Set(['jobs.lever.co','jobs.eu.lever.co']);
const sameAnswer=(a,b)=>String(a??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ')===String(b??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
export function applicationTarget(job) {
  let url;try{url=new URL(job.source_url);}catch{throw Error('This application URL is not supported.');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw Error('Only verified HTTPS employer application URLs are supported.');
  if(greenhouseHosts.has(url.hostname)) {
    const match=url.pathname.match(/^\/([a-z0-9_-]+)\/jobs\/(\d+)\/?$/i);
    if(!match)throw Error('The Greenhouse job URL format is not supported.');
    return {adapter:'greenhouse',url:url.href,jobReference:match[2],board:match[1]};
  }
  if(leverHosts.has(url.hostname)) {
    const match=url.pathname.match(/^\/([a-z0-9_-]+)\/([a-z0-9-]{8,})(?:\/apply)?\/?$/i);
    if(!match)throw Error('The Lever job URL format is not supported.');
    url.pathname='/'+match[1]+'/'+match[2]+'/apply';
    return {adapter:'lever',url:url.href,jobReference:match[2],board:match[1]};
  }
  if(url.hostname==='careers.datadoghq.com') {
    const match=url.pathname.match(/^\/detail\/(\d+)\/?$/);
    if(!match || (url.searchParams.has('gh_jid') && url.searchParams.get('gh_jid')!==match[1]) || job.job_id!=='greenhouse-datadog-'+match[1])throw Error('The Datadog job identity could not be verified.');
    return {adapter:'greenhouse',url:'https://job-boards.greenhouse.io/datadog/jobs/'+match[1],jobReference:match[1],board:'datadog'};
  }
  throw Error('This employer application platform is not supported yet.');
}
function publicResource(value) {
  try {
    const u=new URL(value);
    return u.protocol==='https:' && !u.username && !u.password && (!u.port || u.port==='443') && !/^\d+(?:\.\d+){3}$/.test(u.hostname) && !u.hostname.includes(':') && u.hostname.includes('.') && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname);
  }catch{return false;}
}
export function allowedNavigation(value,target) {
  try {
    const u=new URL(value);
    if(!publicResource(value))return false;
    if(target.adapter==='greenhouse') {
      if(!greenhouseHosts.has(u.hostname))return false;
      return u.pathname===('/'+target.board+'/jobs/'+target.jobReference) || u.pathname===('/'+target.board+'/jobs/'+target.jobReference+'/') ||
        u.pathname===('/'+target.board+'/jobs/'+target.jobReference+'/thank_you') ||
        (['/embed/job_app','/embed/job_app/','/embed/job_app/thank_you'].includes(u.pathname)&&u.searchParams.get('for')===target.board&&u.searchParams.get('token')===target.jobReference);
    }
    return leverHosts.has(u.hostname) && new RegExp('^/'+target.board+'/'+target.jobReference+'(?:/(?:apply|thanks))?/?$','i').test(u.pathname);
  }catch{return false;}
}
export async function openBrowser(config,job) {
  const target=applicationTarget(job);
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(config.home,'browsers');
  const {chromium}=await import('playwright');
  await mkdir(join(config.home,'browser-profile'),{recursive:true,mode:0o700});
  const context=await chromium.launchPersistentContext(join(config.home,'browser-profile'),{headless:false,executablePath:config.browser_executable_path,acceptDownloads:false,viewport:{width:1280,height:900}});
  await context.route('**/*',route=>{
    const req=route.request(),u=req.url();
    if(req.isNavigationRequest() && req.frame()===context.pages()[0]?.mainFrame())return allowedNavigation(u,target)?route.continue():route.abort('blockedbyclient');
    return publicResource(u)?route.continue():route.abort('blockedbyclient');
  });
  const page=context.pages()[0] || await context.newPage();
  try {await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:45000});return {page,target,close:()=>context.close()};}
  catch {await context.close();throw Error('The employer application page could not be opened safely.');}
}
async function fieldDescription(locator) {
  return locator.evaluate(node=>{
    const ownLabels=[...(node.labels||[])].map(n=>n.textContent.trim()).filter(Boolean);
    const labelled=(node.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent?.trim()).filter(Boolean);
    const legend=node.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    const type=(node.type||node.getAttribute('role')||'').toLowerCase();
    const label=ownLabels.join(' ')||node.getAttribute('aria-label')||labelled.join(' ')||node.getAttribute('placeholder')||node.name||node.id||'Unlabeled required field';
    const context=legend&&!/^(?:personal|contact|applicant) information$/i.test(legend)?legend:null;
    const question=type==='radio'&&legend?legend:(context&&context!==label?context+' — ':'')+label;
    return {tag:node.tagName.toLowerCase(),type,name:node.name,id:node.id,question:question.replace(/\s*\*\s*$/,'').trim(),required:node.required||node.getAttribute('aria-required')==='true',disabled:node.disabled,readOnly:node.readOnly,checked:node.checked,value:node.value??node.getAttribute('aria-valuetext')??(type==='combobox'?node.textContent?.trim():''),options:node.options?[...node.options].map(o=>({value:o.value,label:o.label,disabled:o.disabled})):null,optionLabel:ownLabels.join(' ')||node.value};
  });
}
const successPattern=/(?:we (?:have )?received your application|your application (?:has been|was) (?:successfully )?submitted|application submitted successfully|thank you for applying|thanks for applying)/i;
async function confirmation(page,previousPhrases) {
  const text=await page.locator('body').innerText({timeout:3000});
  const match=text.match(successPattern);
  if(!match || previousPhrases.has(normalize(match[0])))return null;
  const forms=page.locator('form');
  for(let i=0;i<await forms.count();i++)if(await forms.nth(i).isVisible() && await forms.nth(i).locator('input:not([type="hidden"]),textarea,select').count())return null;
  return match[0];
}
async function challenge(page) {
  for(const selector of ['iframe[src*="recaptcha"]','iframe[src*="hcaptcha"]','iframe[src*="challenges.cloudflare.com"]','[data-sitekey]','input[type="password"]']) {
    const nodes=page.locator(selector);
    for(let i=0;i<await nodes.count();i++)if(await nodes.nth(i).isVisible())return true;
  }
  return false;
}
export async function performApplication({page,job,answers=[],resumePath,mode='prepare',beforeSubmit}) {
  const scope=job.job_id || job.source_url;
  const target=applicationTarget(job);
  if(await challenge(page))return {status:'needs_input',questions:[blockedQuestion('Employer login or human verification','Complete this step directly with the employer; the connector cannot bypass it.',scope)]};
  let form=null;
  const forms=page.locator('form');
  for(let i=0;i<await forms.count();i++) {
    const candidate=forms.nth(i);
    if(await candidate.isVisible() && await candidate.locator('input[type="file"],input[type="email"],input[name="email"]').count()){form=candidate;break;}
  }
  if(!form)return {status:'needs_input',questions:[blockedQuestion('Supported employer application form','The page does not expose a supported standard application form.',scope)]};
  const questions=[],controls=form.locator('input,textarea,select,[role="combobox"]');
  const radioGroups=new Map();
  for(let i=0;i<await controls.count();i++) {
    const field=controls.nth(i),item=await fieldDescription(field);
    if(!await field.isVisible()&&item.type!=='file')continue;
    if(item.disabled||['hidden','submit','button','reset'].includes(item.type))continue;
    if(item.readOnly) {
      const approved=answerFor(item.question,answers,scope);
      if((item.required&&!approved)||(!approved&&String(item.value||'').trim())||(approved&&!sameAnswer(item.value,approved.answer)))questions.push(blockedQuestion(item.question,'The employer account has a fixed value that could not be verified against the confirmed answer.',scope));
      continue;
    }
    if(item.type==='radio') {
      const key=item.name||item.question;
      if(!radioGroups.has(key))radioGroups.set(key,[]);
      radioGroups.get(key).push({field,item});continue;
    }
    if(item.type==='file') {
      if(/resume|résumé|cv/i.test(item.question+' '+item.name+' '+item.id)) {
        try{await field.setInputFiles(await verifyResume(resumePath));}catch{questions.push(blockedQuestion('Local PDF résumé','Choose your current résumé PDF in the Windows connector settings.',scope));}
      }else if(item.required)questions.push(blockedQuestion(item.question,'This required file must be supplied directly; the résumé is not reused as another document.',scope));
      continue;
    }
    const approved=answerFor(item.question,answers,scope);
    if(item.type==='checkbox') {
      if(approved && ['yes','true','checked'].includes(normalize(approved.answer)))await field.check();
      else if(approved && ['no','false','unchecked'].includes(normalize(approved.answer)))await field.uncheck();
      else if(item.required)questions.push(blockedQuestion(item.question,'This required consent or checkbox needs an explicit confirmed answer.',scope));
      else if(item.checked)await field.uncheck();
      continue;
    }
    if(item.tag==='select') {
      const choices=approved?item.options.filter(option=>!option.disabled && (sameAnswer(option.label,approved.answer)||sameAnswer(option.value,approved.answer))):[];
      if(choices.length===1)await field.selectOption(choices[0].value);
      else if(item.required)questions.push(blockedQuestion(item.question,'Choose the exact employer option; no equivalent eligibility answer is guessed.',scope));
      else if(item.value) {
        if(item.options.some(option=>option.value===''&&!option.disabled))await field.selectOption('');
        else questions.push(blockedQuestion(item.question,'The preselected optional answer is not confirmed and cannot be cleared safely.',scope));
      }
      continue;
    }
    if(item.type==='combobox' || item.type==='search') {
      if(item.required||item.value)questions.push(blockedQuestion(item.question,'This custom selection needs direct review in the employer form.',scope));
      continue;
    }
    if(approved) {
      if(item.type==='date' && !/^\d{4}-\d{2}-\d{2}$/.test(approved.answer))questions.push(blockedQuestion(item.question,'An exact approved day is required; a graduation month is not converted to a day.',scope));
      else if(item.type==='month' && !/^\d{4}-\d{2}$/.test(approved.answer))questions.push(blockedQuestion(item.question,'An exact approved month is required.',scope));
      else await field.fill(approved.answer);
    }else if(item.required)questions.push(blockedQuestion(item.question,undefined,scope));
    else if(item.value)await field.fill('');
  }
  for(const group of radioGroups.values()) {
    const question=group[0].item.question,approved=answerFor(question,answers,scope);
    const options=approved?group.filter(({item})=>sameAnswer(item.optionLabel,approved.answer)||sameAnswer(item.value,approved.answer)):[];
    if(options.length===1)await options[0].field.check();
    else if(group.some(({item})=>item.required||item.checked))questions.push(blockedQuestion(question,'Choose the exact employer option; no authorization or demographic answer is inferred.',scope));
  }
  const unsupported=form.locator('[aria-required="true"]:not(input):not(select):not(textarea):not([role="combobox"])');
  for(let i=0;i<await unsupported.count();i++)if(await unsupported.nth(i).isVisible())questions.push(blockedQuestion((await unsupported.nth(i).innerText()).slice(0,500)||'Required custom field','This employer control needs direct review.',scope));
  if(questions.length)return {status:'needs_input',questions:[...new Map(questions.map(q=>[q.key,q])).values()]};
  const invalid=await form.evaluate(node=>[...node.elements].filter(e=>!e.disabled&&e.type!=='hidden'&&e.willValidate&&!e.validity.valid).map(e=>({question:e.labels?.[0]?.textContent?.trim()||e.name||'Required field'})));
  if(invalid.length)return {status:'needs_input',questions:invalid.map(item=>blockedQuestion(item.question,'The employer form reports an unanswered or invalid field.',scope))};
  const submit=form.locator('button[type="submit"],input[type="submit"]');
  const visible=[];for(let i=0;i<await submit.count();i++)if(await submit.nth(i).isVisible()&&await submit.nth(i).isEnabled())visible.push(submit.nth(i));
  if(visible.length!==1)return {status:'needs_input',questions:[blockedQuestion('Final application submission','The final submit control could not be identified unambiguously.',scope)]};
  const submitLabel=normalize(await visible[0].evaluate(node=>node.innerText||node.value||node.getAttribute('aria-label')||''));
  if(!['submit','submit application','send application','apply','apply now'].includes(submitLabel))return {status:'needs_input',questions:[blockedQuestion('Final application submission','This form appears to require another step rather than a supported final Submit action.',scope)]};
  if(mode!=='submit')return {status:'ready',questions:[]};
  const previousPhrases=new Set([...(await page.locator('body').innerText()).matchAll(new RegExp(successPattern.source,'gi'))].map(match=>normalize(match[0])));
  await beforeSubmit();
  try {
    await visible[0].click({timeout:15000});
    let proof=null;
    for(let count=0;count<12;count++){proof=await confirmation(page,previousPhrases).catch(()=>null);if(proof)break;await page.waitForTimeout(1000);}
    if(!proof)return {status:'needs_confirmation',questions:[],error:'A submit click occurred, but an employer confirmation could not be established. Do not automatically retry.'};
    const screenshot=await page.screenshot({fullPage:false}).catch(()=>null);
    return {status:'submitted',questions:[],receipt:{source_url:job.source_url,adapter:target.adapter,confirmation_text:proof,confirmed_at:new Date().toISOString(),confirmation_url:page.url(),...(screenshot?{screenshot_sha256:createHash('sha256').update(screenshot).digest('hex')}:{})}};
  }catch{return {status:'needs_confirmation',questions:[],error:'Submission may have started, but confirmation was interrupted. Check directly with the employer before retrying.'};}
}
