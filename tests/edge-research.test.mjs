import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {boundedJson,createHandler,geography,invocationSignature,verifyInvocation,parseFeed,plainText,ResearchError,runResearch,safeUrl,screenJob,sponsorshipEvidence,validateConfig} from '../supabase/functions/gmoney-research/index.ts';

const config=()=>({version:1,criteria:{label:'Business roles',country:'US',entry_level:true,sponsorship_required:true,sponsorship_requirement_note:'Initial work must permit valid OPT/CPT where applicable to the role and dates; future H-1B sponsorship is required.',preferred_locations:['Houston'],role_patterns:['business analyst','operations coordinator','customer success','staff accountant'],start_window:'Available May 1, 2027 onward'},max_records:30,max_excluded:5,sources:[{provider:'greenhouse',board:'example',name:'Example Employer'}]});
const row=(extra={})=>({id:1,title:'Business Analyst',absolute_url:'https://example.com/jobs/1',location:{name:'Houston, TX'},content:'<p>Organize operations with Excel.</p>',...extra});
const feed=rows=>new Response(JSON.stringify({jobs:rows}),{headers:{'Content-Type':'application/json'}});
const env=()=>({SUPABASE_URL:'https://example.supabase.co',GMONEY_PUBLISHABLE_KEY:'public-test-key',GMONEY_RESEARCH_KEY:'publisher-test-key-with-long-random-like-content',GMONEY_RESEARCH_TRIGGER_KEY:'trigger-test-key-with-long-random-like-content',GMONEY_RESEARCH_CONFIG:JSON.stringify(config())});
const invocation=(extra={})=>({nonce:'a'.repeat(64),issuedAt:Math.floor(Date.now()/1000),trigger:'manual',...extra});
const request=async(settings,body=invocation())=>new Request('https://example.supabase.co/functions/v1/gmoney-research',{method:'POST',headers:{'x-gmoney-run-signature':await invocationSignature(settings.GMONEY_RESEARCH_TRIGGER_KEY,body.nonce,body.issuedAt,body.trigger)},body:JSON.stringify(body)});

test('extracts employer descriptions and discards executable URLs',()=>{
 assert.equal(plainText('&lt;p&gt;Business &amp;amp; operations&lt;/p&gt;<script>alert(1)</script>'),'Business & operations');
 assert.equal(safeUrl('javascript:alert(1)'),null);
 assert.equal(safeUrl('https://user:password@example.com/jobs'),null);
 assert.equal(safeUrl('https://example.com/job?gh_jid=2&utm_source=test#section'),'https://example.com/job?gh_jid=2');
 const parsed=parseFeed(config().sources[0],{jobs:[row(),row({id:2,absolute_url:'javascript:alert(1)'})]});
 assert.equal(parsed.jobs.length,1);assert.equal(parsed.invalid,1);
 assert.equal(parsed.jobs[0].description,'Organize operations with Excel.');
});

test('Lever includes qualification lists and additional sponsorship evidence',()=>{
 const source={provider:'lever',board:'example',name:'Example'};
 const parsed=parseFeed(source,[{id:'a',text:'Operations Coordinator',hostedUrl:'https://jobs.lever.co/example/a',country:'US',categories:{location:'Remote',commitment:'Full-time'},descriptionPlain:'Support clients.',lists:[{text:'Qualifications',content:'<li>Salesforce experience</li>'}],additionalPlain:'Visa sponsorship is not available.'}]);
 assert.match(parsed.jobs[0].description,/Salesforce/);
 assert.equal(screenJob(parsed.jobs[0],config().criteria,'2026-11-02T12:00:00Z').category,'excluded');
});

test('sponsorship negatives and contradictions remain conservative',()=>{
 for(const text of ['No employment visa sponsorship is available.','We do not offer visa sponsorship.','We are unable to sponsor work visas.','Must be authorized without the need for visa sponsorship.','Applicants must not require current or future sponsorship.'])assert.equal(sponsorshipEvidence(text).status,'not_offered',text);
 assert.equal(sponsorshipEvidence('We do not offer visa sponsorship, but visa sponsorship is available for a separate role.').status,'unknown');
 assert.equal(sponsorshipEvidence('We offer visa sponsorship for eligible roles.').status,'mentioned');
 assert.equal(sponsorshipEvidence('We evaluate applications fairly.').status,'unknown');
});

test('OPT/CPT acceptance does not establish future H-1B sponsorship',()=>{
 for(const phrase of ['We accept candidates with valid OPT or CPT.','No sponsorship required during OPT.','No visa sponsorship is needed while on STEM OPT.','No sponsorship is required during CPT.']){
  const job=parseFeed(config().sources[0],{jobs:[row({content:phrase})]}).jobs[0];
  const record=screenJob(job,config().criteria,'2026-11-02');
  assert.equal(record.sponsorshipStatus,'unknown',phrase);assert.equal(record.category,'verify');assert.equal(record.verificationRequired,true);
  assert.match(record.next,/verify initial OPT\/CPT acceptance for the role and work dates/);assert.match(record.next,/future H-1B sponsorship/);
 }
});

test('explicit H-1B sponsorship offers still require verification',()=>{
 for(const phrase of ['We offer H-1B sponsorship for eligible roles.','H1B sponsorship is available.','We sponsor H-1B visas.','No sponsorship required during OPT, but we offer H1B sponsorship.']){
  const job=parseFeed(config().sources[0],{jobs:[row({content:phrase})]}).jobs[0];
  const record=screenJob(job,config().criteria,'2026-11-02');
  assert.equal(record.sponsorshipStatus,'mentioned',phrase);assert.equal(record.category,'verify');assert.equal(record.verificationRequired,true);
  assert.deepEqual(record.sponsorshipEvidence,[phrase]);
 }
});

test('explicit H-1B sponsorship denials are excluded',()=>{
 for(const phrase of ['No H-1B sponsorship.','We do not offer H1B sponsorship.','We do not sponsor H-1B visas.','H-1B sponsorship is not available.','No sponsorship required during OPT; future H-1B sponsorship is not available.']){
  const job=parseFeed(config().sources[0],{jobs:[row({content:phrase})]}).jobs[0];
  const record=screenJob(job,config().criteria,'2026-11-02');
  assert.equal(record.sponsorshipStatus,'not_offered',phrase);assert.equal(record.category,'excluded');assert.deepEqual(record.sponsorshipEvidence,[phrase]);
 }
 for(const phrase of ['H-1B sponsorship is not guaranteed.','We do not offer H-1B sponsorship, but H1B sponsorship is available for other roles.'])assert.equal(sponsorshipEvidence(phrase).status,'unknown',phrase);
});

test('business relevance, seniority and location prevent misleading leads',()=>{
 const parse=extra=>parseFeed(config().sources[0],{jobs:[row(extra)]}).jobs[0];
 assert.equal(screenJob(parse({title:'Customer Success Engineer'}),config().criteria,'2026-11-02'),null);
 assert.equal(screenJob(parse({title:'Senior Business Analyst'}),config().criteria,'2026-11-02').category,'excluded');
 assert.equal(screenJob(parse({title:'Staff Accountant'}),config().criteria,'2026-11-02').category,'verify');
 assert.equal(screenJob(parse({title:'Customer Success Manager'}),config().criteria,'2026-11-02').category,'verify');
 assert.equal(screenJob(parse({content:'Minimum of 5 years of relevant experience.'}),config().criteria,'2026-11-02').category,'excluded');
 assert.equal(screenJob(parse({content:'Five years preferred; experience is not required.'}),config().criteria,'2026-11-02').category,'verify');
 assert.equal(geography(parse({location:{name:'London, UK'}})),'outside_us');
 assert.equal(geography(parse({location:{name:'Remote'}})),'unknown');
 assert.equal(geography(parse({location:{name:'New York / London'}})),'unknown');
});

test('rejects malformed feeds, arbitrary source URLs and oversized responses',async()=>{
 assert.throws(()=>parseFeed(config().sources[0],{jobs:[{id:1}]}));
 assert.throws(()=>validateConfig({...config(),sources:[{provider:'greenhouse',board:'../../private',name:'bad'}]}));
 assert.throws(()=>validateConfig({...config(),sources:Array.from({length:7},(_,i)=>({provider:'greenhouse',board:'b'+i,name:'Employer '+i}))}));
 await assert.rejects(boundedJson(new Response('x'.repeat(20)),10),/size limit/);
 await assert.rejects(boundedJson(new Response('not json')),/valid JSON/);
});

test('research deduplicates stable jobs and labels only truly new records',async()=>{
 const c=config();c.sources.push({provider:'greenhouse',board:'other',name:'Other'});
 const result=await runResearch(c,{records:[{id:'greenhouse-example-1'}]},async()=>feed([row(),row({id:2,absolute_url:'https://example.com/jobs/2',title:'Operations Coordinator'})]));
 assert.equal(result.automation.stats.fetched,4);
 assert.equal(result.automation.stats.duplicates,2);
 assert.equal(result.automation.stats.selected,2);
 assert.equal(result.automation.stats.new,1);
 assert.equal(result.records.find(v=>v.id==='greenhouse-example-1').isNew,false);
 assert.equal(result.records[0].verificationRequired,true);
 assert.equal(result.records[0].category,'verify');
 assert.match(result.records[0].fit,/No candidate résumé was evaluated/);
 assert.ok(result.scope.includes(c.criteria.sponsorship_requirement_note));
 assert.equal('sponsorship_requirement_note' in result.records[0],false);
});

test('complete failures and empty partial coverage never yield a replacement report',async()=>{
 await assert.rejects(runResearch(config(),{records:[]},async()=>new Response('{}',{status:503})),error=>error instanceof ResearchError && error.automation.status==='failed');
 const c=config();c.sources.push({provider:'lever',board:'other',name:'Other'});
 await assert.rejects(runResearch(c,{records:[{id:'existing'}]},async url=>url.includes('greenhouse')?feed([]):new Response('{}',{status:503})),error=>error instanceof ResearchError && error.automation.status==='failed');
});

test('nonempty partial coverage is explicitly marked incomplete',async()=>{
 const c=config();c.sources.push({provider:'lever',board:'other',name:'Other'});
 const result=await runResearch(c,{records:[]},async url=>url.includes('greenhouse')?feed([row()]):new Response('{}',{status:503}),'scheduled');
 assert.equal(result.automation.status,'partial');assert.equal(result.automation.trigger,'scheduled');assert.equal(result.automation.sources[1].status,'failed');
});

test('signed invocation protocol matches standard HMAC and rejects stale/tampered bodies',async()=>{
 const secret=env().GMONEY_RESEARCH_TRIGGER_KEY,body=invocation({issuedAt:1800000000});
 const signature=await invocationSignature(secret,body.nonce,body.issuedAt,body.trigger);
 assert.equal(signature,createHmac('sha256',secret).update(`${body.nonce}.${body.issuedAt}.${body.trigger}`).digest('hex'));
 assert.equal(await verifyInvocation(body,signature,secret,1800000000),true);
 assert.equal(await verifyInvocation(body,signature,secret,1800000301),false);
 assert.equal(await verifyInvocation(body,signature,secret,1799999699),false);
 assert.equal(await verifyInvocation({...body,trigger:'scheduled'},signature,secret,1800000000),false);
 assert.equal(await verifyInvocation({...body,nonce:'b'.repeat(64)},signature,secret,1800000000),false);
 assert.equal(await verifyInvocation({...body,extra:true},signature,secret,1800000000),false);
 assert.equal(await verifyInvocation(body,signature.toUpperCase(),secret,1800000000),false);
});

test('handler authenticates before any network access and rejects legacy raw keys',async()=>{
 const settings=env();let fetched=0;const handler=createHandler(settings,async()=>{fetched++;throw Error('Unexpected');});
 assert.equal((await handler(new Request('https://example.com',{method:'POST',body:'{}'}))).status,401);
 assert.equal((await handler(new Request('https://example.com',{method:'POST',headers:{'x-gmoney-run-key':settings.GMONEY_RESEARCH_TRIGGER_KEY},body:'{}'}))).status,401);
 assert.equal((await handler(new Request('https://example.com'))).status,405);
 assert.equal((await handler(await request(settings,invocation({issuedAt:Math.floor(Date.now()/1000)-301})))).status,401);
 const tampered=await request(settings);tampered.headers.set('x-gmoney-run-signature','0'.repeat(64));
 assert.equal((await handler(tampered)).status,401);
 assert.equal(fetched,0);
});

test('successful handler consumes nonce before employer requests and uses restricted publication credential',async()=>{
 const settings=env();let posted,cachedEvidence;const seen=[];
 const handler=createHandler(settings,async(url,options)=>{
  seen.push(url);assert.equal(options.redirect,'error');
  assert.equal(options.headers?.Authorization,undefined);
  assert.equal(JSON.stringify(options).includes(settings.GMONEY_RESEARCH_TRIGGER_KEY),false);
  if(url.includes('/consume_research_invocation')){
   assert.equal(options.headers['x-gmoney-research-key'],settings.GMONEY_RESEARCH_KEY);
   assert.deepEqual(JSON.parse(options.body),{nonce:'a'.repeat(64)});
   return new Response(JSON.stringify({accepted:true}));
  }
  if(url.includes('/published_research_reports'))return new Response(JSON.stringify([{report:{records:[]}}]));
  if(url.includes('boards-api.greenhouse.io'))return feed([row()]);
  if(url.includes('/rpc/publish_automated_research')){
   assert.equal(options.headers['x-gmoney-research-key'],settings.GMONEY_RESEARCH_KEY);
   posted=JSON.parse(options.body).report;
   return new Response(JSON.stringify({published:true,runId:posted.automation.runId}));
  }
  if(url.includes('/rpc/cache_research_job_evidence')){
   assert.equal(options.headers['x-gmoney-research-key'],settings.GMONEY_RESEARCH_KEY);
   cachedEvidence=JSON.parse(options.body).jobs;
   return new Response(JSON.stringify({cached:cachedEvidence.length}));
  }
  throw Error('Unexpected URL');
 });
 const response=await handler(await request(settings));assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.published,true);assert.equal(data.stats.selected,1);assert.equal(seen.length,5);
 assert.equal(data.evidenceCached,true);assert.equal(data.evidenceCount,1);
 assert.match(seen[3],/publish_automated_research$/);assert.match(seen[4],/cache_research_job_evidence$/);
 assert.equal(cachedEvidence[0].id,posted.records[0].id);
 assert.deepEqual(Object.keys(cachedEvidence[0]).sort(),['company','description','id','location','retrievedAt','sourceId','title','url']);
 assert.equal('description' in posted.records[0],false);
 assert.match(seen[0],/consume_research_invocation$/);assert.match(seen[1],/published_research_reports/);
 assert.equal(posted.automation.trigger,'manual');assert.equal('resume_text' in posted,false);
 assert.equal(JSON.stringify(data).includes(settings.GMONEY_RESEARCH_KEY),false);
});

test('consumed and unknown nonces stop replay before baseline or feeds',async()=>{
 const settings=env();let consumed=false;const seen=[];
 const handler=createHandler(settings,async(url,options)=>{
  seen.push(url);
  if(url.includes('/consume_research_invocation')){
   const accepted=!consumed;consumed=true;return new Response(JSON.stringify({accepted}));
  }
  if(url.includes('/published_research_reports'))return new Response(JSON.stringify([{report:{records:[]}}]));
  if(url.includes('greenhouse'))return feed([row()]);
  if(url.includes('/cache_research_job_evidence'))return new Response(JSON.stringify({cached:1}));
  const report=JSON.parse(options.body).report;return new Response(JSON.stringify({published:true,runId:report.automation.runId}));
 });
 assert.equal((await handler(await request(settings))).status,200);
 seen.length=0;
 assert.equal((await handler(await request(settings))).status,401);
 assert.equal(seen.length,1);assert.match(seen[0],/consume_research_invocation$/);
 const denied=createHandler(settings,async()=>new Response('{}',{status:403}));
 assert.equal((await denied(await request(settings))).status,401);
});

test('failed research stops before publication and never returns secrets',async()=>{
 const settings=env();let published=false;
 const handler=createHandler(settings,async url=>{
  if(url.includes('/consume_research_invocation'))return new Response(JSON.stringify({accepted:true}));
  if(url.includes('/published_research_reports'))return new Response(JSON.stringify([{report:{records:[{id:'old'}]}}]));
  if(url.includes('/rpc/')){published=true;throw Error('Unexpected');}
  return new Response('{}',{status:403});
 });
 const response=await handler(await request(settings));const result=await response.json();
 assert.equal(response.status,502);assert.equal(published,false);assert.equal(result.automation.status,'failed');
 assert.equal(JSON.stringify(result).includes(settings.GMONEY_RESEARCH_KEY),false);
});

test('handler rejects missing baseline, invalid bodies and uncertain publication',async()=>{
 const settings=env();
 let handler=createHandler(settings,async url=>new Response(url.includes('/consume_research_invocation')?JSON.stringify({accepted:true}):'[]'));
 assert.equal((await handler(await request(settings))).status,502);
 assert.equal((await handler(await request(settings,invocation({url:'https://evil.example'})))).status,401);
 handler=createHandler(settings,async url=>url.includes('/consume_research_invocation')?new Response(JSON.stringify({accepted:true})):url.includes('/published_research_reports')?new Response(JSON.stringify([{report:{records:[]}}])):url.includes('greenhouse')?feed([row()]):new Response('{}',{status:502}));
 const result=await handler(await request(settings));assert.equal(result.status,502);assert.match((await result.json()).error,/could not be confirmed/);
});


test('evidence callback captures selected jobs only, bounded and separate from the public report',async()=>{
 const c=config();c.max_records=1;
 const marker='EMPLOYER EVIDENCE ONLY '+ 'x'.repeat(25000);
 let evidence;
 const report=await runResearch(c,{records:[]},async()=>feed([row({content:marker}),row({id:2,title:'Software Engineer',absolute_url:'https://example.com/jobs/2',content:'Not a business job'})]),'manual',jobs=>{evidence=jobs;});
 assert.equal(evidence.length,1);assert.equal(evidence[0].id,report.records[0].id);
 assert.equal(evidence[0].description.length,20000);
 assert.equal(JSON.stringify(report).includes('EMPLOYER EVIDENCE ONLY'),false);
 assert.equal(report.records[0].description,undefined);
});

test('evidence-cache failure leaves a confirmed publication successful',async()=>{
 const settings=env();let published=false;
 const handler=createHandler(settings,async(url,options)=>{
  if(url.includes('/consume_research_invocation'))return new Response(JSON.stringify({accepted:true}));
  if(url.includes('/published_research_reports'))return new Response(JSON.stringify([{report:{records:[]}}]));
  if(url.includes('greenhouse'))return feed([row()]);
  if(url.includes('/publish_automated_research')){published=true;const report=JSON.parse(options.body).report;return new Response(JSON.stringify({published:true,runId:report.automation.runId}));}
  assert.equal(published,true);assert.match(url,/cache_research_job_evidence$/);
  return new Response('{}',{status:503});
 });
 const response=await handler(await request(settings));const result=await response.json();
 assert.equal(response.status,200);assert.equal(result.published,true);assert.equal(result.evidenceCached,false);assert.equal(result.evidenceCount,0);
});
