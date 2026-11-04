/** Public employer research only. No service-role/admin or private candidate access. */
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DESCRIPTION = 100000;
const TIMEOUT_MS = 20000;
export class ResearchError extends Error {
  constructor(message, automation) { super(message); this.automation = automation; }
}

export function plainText(value) {
  let text = String(value ?? '').slice(0, MAX_DESCRIPTION);
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
    });
  }
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<\/?(?:p|li|div|br|h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')
    .split(/\n+/).map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
}
export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || (url.port && url.port !== '443')) return null;
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || /^(source|ref|referrer|lever-source)$/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.href;
  } catch { return null; }
}
export function sourceUrl(source) {
  return source.provider === 'greenhouse'
    ? `https://boards-api.greenhouse.io/v1/boards/${source.board}/jobs?content=true`
    : `https://api.lever.co/v0/postings/${source.board}?mode=json`;
}
export function validateConfig(config) {
  if (!config || config.version !== 1 || config.criteria?.country !== 'US') throw new Error('Invalid research configuration.');
  const criteria = config.criteria;
  if (!Array.isArray(criteria.role_patterns) || !criteria.role_patterns.length || criteria.role_patterns.some(v=>typeof v !== 'string' || !v.trim() || v.length > 1000)) throw new Error('Invalid role criteria.');
  if (!Array.isArray(criteria.preferred_locations ?? []) || (criteria.preferred_locations ?? []).some(v=>typeof v !== 'string')) throw new Error('Invalid location criteria.');
  if (typeof criteria.entry_level !== 'boolean' || typeof criteria.sponsorship_required !== 'boolean') throw new Error('Invalid screening criteria.');
  if (typeof (criteria.sponsorship_requirement_note ?? '') !== 'string' || (criteria.sponsorship_requirement_note ?? '').length > 500) throw new Error('Invalid sponsorship requirement note.');
  for (const [name, fallback] of [['max_records',30],['max_excluded',5]]) {
    const value = config[name] ?? fallback;
    if (!Number.isInteger(value) || value < (name === 'max_records' ? 1 : 0) || value > 200) throw new Error('Invalid record limit.');
  }
  // Bound the worst-case fetch batches within the hosted runtime deadline.
  if (!Array.isArray(config.sources) || !config.sources.length || config.sources.length > 6) throw new Error('Invalid source list.');
  const seen = new Set();
  for (const source of config.sources) {
    if (!['greenhouse','lever'].includes(source?.provider) || !/^[A-Za-z0-9_-]{1,100}$/.test(source.board ?? '') || typeof source.name !== 'string' || !source.name.trim()) throw new Error('Invalid employer source.');
    const id = `${source.provider}:${source.board}`;
    if (seen.has(id)) throw new Error('Duplicate employer source.');
    seen.add(id);
  }
  return config;
}
export async function boundedJson(response, maxBytes = MAX_BYTES) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) { await response.body?.cancel(); throw new Error('Response size limit exceeded.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body.');
  const chunks = []; let size = 0;
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Response size limit exceeded.'); }
    chunks.push(value);
  }
  const combined = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { combined.set(chunk,at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(combined)); }
  catch { throw new Error('Response did not contain valid JSON.'); }
}
async function jsonRequest(url, options, fetchImpl, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS) {
  return boundedJson(await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)}),maxBytes);
}
export function parseFeed(source, data) {
  const rows = source.provider === 'greenhouse' ? data?.jobs : data;
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Unexpected employer feed schema.');
  let invalid = 0; const jobs = [];
  for (const row of rows) {
    const title = source.provider === 'greenhouse' ? row?.title : row?.text;
    const url = safeUrl(source.provider === 'greenhouse' ? row?.absolute_url : row?.hostedUrl);
    if (!row || !['string','number'].includes(typeof row.id) || !String(row.id) || typeof title !== 'string' || !title.trim() || !url) { invalid++; continue; }
    const categories = row.categories && typeof row.categories === 'object' ? row.categories : {};
    const content = source.provider === 'greenhouse' ? row.content : [row.descriptionPlain || row.description,...(Array.isArray(row.lists) ? row.lists.flatMap(v=>v && typeof v === 'object' ? [v.text,v.content] : []) : []),row.additionalPlain || row.additional].filter(Boolean).join('\n');
    jobs.push({id:`${source.provider}-${source.board}-${row.id}`,company:source.name,title:plainText(title),location:plainText(source.provider === 'greenhouse' ? row.location?.name : categories.location) || 'Not specified by employer feed',description:plainText(content),commitment:plainText(categories.commitment),country:typeof row.country === 'string' ? row.country : '',url,sourceId:`${source.provider}:${source.board}`});
  }
  if (rows.length && !jobs.length) throw new Error('No usable job records found in populated feed.');
  return {jobs,invalid};
}
const negativePatterns = [
  /\b(?:no|without)\s+(?:(?:current|future|or|and|employment|work|visa|immigration)\s+){0,5}sponsorship\b/i,
  /\b(?:do|does|will|can)\s+not\s+(?:currently\s+)?(?:provide|offer|support|sponsor)\b[^\n.;]{0,100}\b(?:visa|sponsorship|work authorization)\b/i,
  /\b(?:cannot|can't|unable to|not able to)\s+(?:(?:provide|offer)\s+)?(?:visa\s+|work\s+|immigration\s+)?sponsor(?:ship)?\b/i,
  /\b(?:visa|immigration|employment|work)\s+sponsorship\s*(?::\s*no\b|(?:is|will be)\s+not\s+(?:available|offered|provided|supported))/i,
  /\b(?:must|should)\s+not\s+require\b[^\n.;]{0,80}\bsponsorship\b/i,
  /\bnot\s+(?:eligible|available)\s+for\s+(?:visa\s+)?sponsorship\b/i,
  /\bwithout\s+(?:the\s+)?(?:need\s+for|requiring)\s+(?:(?:current|future|or|and|visa|work)\s+){0,5}sponsorship\b/i
];
const positivePatterns = [
  /\b(?:visa|immigration|employment|work)\s+sponsorship\s+(?:(?:may|can|will)\s+be\s+|is\s+)?(?:available|offered|provided|supported)\b/gi,
  /\b(?:provide|offer|support)\s+(?:employment\s+|work\s+|immigration\s+|visa\s+){1,3}sponsorship\b/gi,
  /\b(?:we|company)\s+(?:will\s+|can\s+|may\s+)?sponsor\s+(?:work\s+|employment\s+)?visas?\b/gi,
  /\bvisa\s+sponsorship\s*:\s*yes\b/gi
];
const temporarySponsorshipNotNeeded = /\bno\s+(?:(?:employment|work|visa|immigration)\s+)*sponsorship\s+(?:(?:is|will be)\s+)?(?:required|needed)\s+(?:during|on|while(?:\s+on)?)\s+(?:valid\s+|authorized\s+|STEM\s+)*(?:OPT|CPT)\b/gi;
export function sponsorshipEvidence(description) {
  const negative = [], positive = [];
  for (const sentence of String(description).split(/(?<=[.!?])\s+|\n+/)) {
    const text = sentence.trim(); if (!text) continue;
    // Normalize for matching only; preserve the employer's original quotes.
    // Temporary OPT/CPT no-need language does not establish future H-1B support.
    const matchingText = text.replace(/\bh[\s-]?1b(?:\s+visas?)?\b/gi,'visa').replace(temporarySponsorshipNotNeeded,'');
    if (negativePatterns.some(pattern=>pattern.test(matchingText))) negative.push(text.slice(0,600));
    let offered = false;
    for (const pattern of positivePatterns) {
      pattern.lastIndex = 0;
      for (const match of matchingText.matchAll(pattern)) {
        const prefix = matchingText.slice(Math.max(0,match.index-60),match.index);
        if (!/\b(?:not|no|cannot|can't|unable to|without)(?:\s+(?:currently|now|ever|able to|employment|work|immigration|visa)){0,5}\s*$/i.test(prefix)) offered = true;
      }
    }
    if (offered) positive.push(text.slice(0,600));
  }
  if (negative.length && positive.length) return {status:'unknown',label:'Conflicting sponsorship statements; role-specific confirmation required',quotes:[negative[0],positive[0]]};
  if (negative.length) return {status:'not_offered',label:'Employer text states sponsorship is unavailable',quotes:negative.slice(0,2)};
  if (positive.length) return {status:'mentioned',label:'Sponsorship mentioned; H-1B eligibility is not confirmed',quotes:positive.slice(0,2)};
  return {status:'unknown',label:'Sponsorship not established by this posting',quotes:[]};
}
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const startDatePattern = '\\b(?:(?<iso>\\d{4}-\\d{2}-\\d{2})|(?<month>Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s*(?:(?<day>\\d{1,2})(?:st|nd|rd|th)?[,\\s]+)?(?<year>\\d{4}))\\b';
function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(value+'T00:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0,10) === value ? day : null;
}
export function startDateEvidence(description, availableFrom, checkedAt) {
  // Keep this behavior in parity with automation/research_worker.py. No cohort
  // year, graduation date, posting date or deadline supplies a work-start date.
  const available = isoDay(availableFrom), observations = [], quotes = [];
  let ambiguous = false;
  for (const sentence of description.split(/(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])|\n+/)) {
    const text = sentence.trim();
    if (/\b(?:flexible|negotiable|alternative|later)\b[^\n.!?]{0,50}\b(?:start|timing)\b|\b(?:start\s+dates?|start\s+timing)\b[^\n.!?]{0,30}\b(?:flexible|negotiable)\b/i.test(text)) { ambiguous = true; quotes.push(text.slice(0,600)); }
    for (const cue of text.matchAll(/\b(?:start(?:ing)?\s+date|start(?:s|ing)?(?:\s+work)?|(?:employment|work|role|position|program)\s+begins?)\b/gi)) {
      const prefix = text.slice(0,cue.index).split(/[;.!?]/).at(-1);
      if (/\b(?:applications?|deadlines?|postings?|posted|salary|graduat(?:ion|ing|es?)|projects?|benefits|interviews?|recruiting|health|coverage|insurance|pension|retirement|visa|sponsorship|training|orientation|onboarding|semester|classes?|courses?)\b/i.test(prefix)) continue;
      const tail = text.slice(cue.index+cue[0].length);
      const joined = tail.match(/^\s*(?::|[-–])?\s*(?:(?:is|will be|of|on|in|by|from|no later than)\s+)?/i);
      const value = tail.slice(joined[0].length), token = new RegExp(startDatePattern,'i').exec(value);
      const boundToken = token?.index === 0 ? token : null;
      const immediate = /^(?:immediately|ASAP|as soon as possible)\b/i.test(value) || /\bimmediate\s*$/i.test(prefix);
      if (!boundToken && !immediate) {
        if (/\bdate\b/i.test(cue[0])) { ambiguous = true; quotes.push(text.slice(0,600)); }
        continue;
      }
      quotes.push(text.slice(0,600));
      const uncertain = /\b(?:not\s+(?:required|confirmed|guaranteed)|(?:must|need|do|does|should)\s+not|not\s+(?:a\s+)?must|no\s+longer\s+required|cannot\s+confirm|can't\s+confirm|to\s+be\s+(?:confirmed|determined)|TBD|tentative|possible|may\s+(?:start|be|change)|might|(?:other|separate)\s+(?:roles?|positions?|programs?))\b/i.test(text.replace(/as soon as possible/gi,''));
      const dateCount = [...text.matchAll(new RegExp(startDatePattern,'gi'))].length;
      const multiple = dateCount > 1 || (immediate && dateCount > 0);
      const alternative = boundToken && /^\s*(?:[-–—/]|or\b|through\b|until\b|to\b|and\s+(?=\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i.test(value.slice(boundToken[0].length));
      if (uncertain || multiple || alternative) { ambiguous = true; continue; }
      const required = /\b(?:must(?:\s+be\s+(?:available|able|ready)\s+to)?|required(?:\s+to)?)\s*$/i.test(prefix);
      const bound = /\b(?:by|no later than)\b/i.test(joined[0]) ? 'upper' : /\bfrom\b/i.test(joined[0]) ? 'lower' : 'fixed';
      if (immediate) { observations.push(['immediate','immediate',required,'fixed']); continue; }
      let first, last;
      if (boundToken.groups.iso) first = last = isoDay(boundToken.groups.iso);
      else {
        const month = months.findIndex(name=>name.slice(0,3).toLowerCase() === boundToken.groups.month.slice(0,3).toLowerCase())+1;
        const year = Number(boundToken.groups.year), day = boundToken.groups.day;
        const stamp = (dayValue) => `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(dayValue).padStart(2,'0')}`;
        first = isoDay(stamp(day ? Number(day) : 1));
        last = day ? first : isoDay(stamp(new Date(Date.UTC(year,month,0)).getUTCDate()));
      }
      if (!first || !last) { ambiguous = true; continue; }
      observations.push([first.toISOString().slice(0,10),last.toISOString().slice(0,10),required,bound]);
    }
  }
  const bounds = new Map(observations.map(([first,last,,bound])=>[`${first}|${last}|${bound}`,[first,last,bound]]));
  let status = 'unknown', label = 'Employer start date is not established by explicit work-start wording; verify timing.';
  if (ambiguous || bounds.size > 1) label = 'Employer start timing is ambiguous or conflicting; verify the role-specific start constraint.';
  else if (available && observations.length) {
    const [first,last,bound] = bounds.values().next().value, required = observations.some(item=>item[2]);
    const checked = isoDay(checkedAt.slice(0,10));
    const earlier = first === 'immediate' ? checked !== null && checked < available : bound !== 'lower' && last < availableFrom;
    if (earlier) {
      status = required ? 'required_earlier' : 'earlier';
      label = required ? `The employer explicitly requires a start before availability from ${availableFrom}.` : `Employer start timing is earlier than availability from ${availableFrom}; timing needs review and employer flexibility is unverified.`;
    } else if (first !== 'immediate' && bound !== 'upper' && first >= availableFrom) {
      status = 'compatible'; label = `Explicit employer start timing is on or after ${availableFrom}; role-specific compatibility still needs review.`;
    } else label = 'Employer start timing overlaps availability or is undated; verify the role-specific start constraint.';
  }
  return {status,label,quotes:[...new Set(quotes)].slice(0,2)};
}
const usCities = /\b(?:Houston|Austin|Dallas|San Francisco|New York|Boston|Chicago|Seattle|Denver|Atlanta|Los Angeles|San Diego|Phoenix|Miami|Washington|Palo Alto|Mountain View|Menlo Park|Salt Lake City|Charlotte|San Jose|Bellevue|Sunnyvale|Orlando|Tampa|Philadelphia|Nashville|Columbus|Raleigh|Pittsburgh)\b/i;
const nonUs = /\b(?:United Kingdom|UK|Canada|Germany|France|India|Ireland|Australia|Japan|Singapore|Brazil|Mexico|Poland|Netherlands|Spain|Italy|Israel|London|Toronto|Vancouver|Berlin|Paris|Dublin|Bengaluru|Bangalore|Hyderabad|Mumbai|Sydney|Melbourne|Tokyo|Warsaw|Amsterdam|Madrid|Tel Aviv)\b/i;
const usStates = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
export function geography(job) {
  const country = job.country.trim().toUpperCase();
  if (['US','USA','UNITED STATES','UNITED STATES OF AMERICA'].includes(country)) return 'us';
  if (country && (/^[A-Z]{2,3}$/.test(country) || nonUs.test(country))) return 'outside_us';
  if (/\bUnited States\b|\bU\.S\.(?:A\.)?|\bUSA?\b/.test(job.location) || usStates.test(job.location)) return 'us';
  if (nonUs.test(job.location)) return usCities.test(job.location) && /\s[/;|]\s/.test(job.location) ? 'unknown' : 'outside_us';
  return usCities.test(job.location) ? 'us' : 'unknown';
}
export function screenJob(job, criteria, checkedAt) {
  const matched = criteria.role_patterns.filter(phrase=>job.title.toLowerCase().includes(phrase.toLowerCase()));
  if (!matched.length || /\b(?:engineer|developer|scientist|architect)\b/i.test(job.title)) return null;
  let score = 30; const exclusions = [], reasons = [`Title matches the configured '${matched[0]}' role family.`];
  let senior = job.title.match(/\b(?:senior|sr\.?|principal|lead|director|head|vice president|vp|chief)\b/i);
  if (!senior && /\bstaff\b/i.test(job.title) && !/\bstaff accountant\b/i.test(job.title)) senior = job.title.match(/\bstaff\b/i);
  if (!senior) senior = job.title.replace(/\b(?:account|customer success) manager\b/gi,'').match(/\bmanager\b/i);
  if (criteria.entry_level && senior) exclusions.push(`The title signals a ${senior[0]} position rather than an entry-level opening.`);
  if (/\bintern(?:ship)?\b/i.test(job.title+' '+job.commitment)) exclusions.push('The posting is an internship; the configured search is for full-time work.');
  let years;
  for (const sentence of job.description.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\b(?:preferred|not required|does not require|do not require)\b/i.test(sentence)) continue;
    years = sentence.match(/\b(?:at least|minimum(?: of)?|requires?|must have)\s+(\d{1,2})\+?\s+years?\b/i) || sentence.match(/^\s*(?:[-•]\s*)?(\d{1,2})(?:\+|[-–]\d{1,2})?\s+years?\b/i);
    if (years) break;
  }
  if (criteria.entry_level && years && Number(years[1]) > 2) exclusions.push(`The posting explicitly requires at least ${years[1]} years of experience.`);
  const geo = geography(job);
  if (geo === 'outside_us') exclusions.push('The employer feed lists a location outside the configured U.S. search.');
  else if (geo === 'us') { reasons.push('The feed identifies a U.S. location; exact work-location eligibility still needs review.'); score += 20; }
  else reasons.push('U.S. work-location eligibility is not established; remote does not automatically mean U.S.-eligible.');
  const preferred = (criteria.preferred_locations ?? []).find(place=>job.location.toLowerCase().includes(place.toLowerCase()));
  if (preferred) { reasons.push(`Location includes the preferred area: ${preferred}.`); score += 20; }
  if (/\b(?:entry.level|new grad(?:uate)?|junior|early career|associate|analyst i)\b/i.test(job.title)) { reasons.push('The title contains an early-career signal; qualifications still need review.'); score += 10; }
  const sponsorship = sponsorshipEvidence(job.description);
  if (criteria.sponsorship_required && sponsorship.status === 'not_offered') exclusions.push("The posting's no-sponsorship statement conflicts with the configured sponsorship requirement.");
  else if (sponsorship.status === 'mentioned') score += 5;
  const start = startDateEvidence(job.description,criteria.available_from,checkedAt);
  reasons.push(start.label+(start.quotes.length?' Employer text: '+start.quotes.map(quote=>'“'+quote+'”').join(' | '):''));
  if (start.status === 'compatible') score += 40;
  else if (start.status === 'required_earlier') exclusions.push(start.label);
  else if (start.status === 'earlier') score -= 25;
  const available = isoDay(criteria.available_from), cohort = job.title.match(/\b20\d{2}\b/);
  if (start.status === 'unknown' && cohort && /\b(?:new grad(?:uate)?|graduate|early career|rotational|cohort|class of)\b/i.test(job.title)) {
    reasons.push(`Unverified cohort-year signal in title: “${job.title.slice(0,200)}”; it does not establish a start date or graduation eligibility.`);
    if (available && Number(cohort[0]) >= available.getUTCFullYear()) score += 2;
  }
  const disclosure = available ? `full-time availability from ${months[available.getUTCMonth()]} ${available.getUTCDate()}, ${available.getUTCFullYear()}` : 'your earliest available full-time start date';
  const category = exclusions.length ? 'excluded' : 'verify';
  return {id:job.id,company:job.company,title:job.title,location:job.location,decision:exclusions.length?'Ruled out':'Verify first',category,
    sponsorship:sponsorship.label+(sponsorship.quotes.length?' Employer text: '+sponsorship.quotes.map(q=>'“'+q+'”').join(' | '):''),sponsorshipStatus:sponsorship.status,sponsorshipEvidence:sponsorship.quotes,
    finding:'Listed in the employer\'s public job feed at retrieval time. '+(exclusions.length?exclusions.join(' '):'This is a research lead, not a verified application-ready match.'),
    fit:reasons.join(' ')+' No candidate résumé was evaluated. Compensation, qualifications, and employer start-date compatibility are unverified.',
    next:exclusions.length?'Do not apply under the current criteria. Review the stated exclusion and verify initial OPT/CPT acceptance for the role and work dates and future H-1B sponsorship before reconsidering.':`For an otherwise suitable role, you may apply while employer start timing is unconfirmed. When applying, disclose ${disclosure} and your expected graduation. Review the full employer posting and verify initial OPT/CPT acceptance for the role and work dates, future H-1B sponsorship, required experience, pay, graduation requirements, and employer start constraints.`,
    url:job.url,checkedAt:checkedAt.slice(0,10),retrievedAt:checkedAt,sourceType:'employer_feed',sourceId:job.sourceId,matchScore:exclusions.length?0:score,matchReasons:reasons,exclusionReasons:exclusions,verificationRequired:true};
}
export async function runResearch(config, previous, fetchImpl = fetch, trigger = 'manual', captureEvidence = null) {
  validateConfig(config);
  if (!previous || !Array.isArray(previous.records)) throw new Error('Previous report must contain records.');
  if (!['manual','scheduled'].includes(trigger)) throw new Error('Invalid research trigger.');
  const started = new Date().toISOString();
  const automation = {runId:crypto.randomUUID(),status:'completed',startedAt:started,finishedAt:null,execution:'one_shot',trigger,sources:[],stats:{fetched:0,relevant:0,selected:0,duplicates:0,new:0}};
  const jobs = [];
  const readSource = async source => {
    const meta = {id:`${source.provider}:${source.board}`,name:source.name,provider:source.provider,url:sourceUrl(source),status:'ok',fetched:0,invalid:0};
    try {
      const data = await jsonRequest(meta.url,{headers:{Accept:'application/json','User-Agent':'GMoneyResearch/1.0 (public employer listings)'}},fetchImpl);
      const parsed = parseFeed(source,data);meta.fetched=parsed.jobs.length;meta.invalid=parsed.invalid;
      return {jobs:parsed.jobs,meta};
    } catch (error) { meta.status='failed';meta.error=/^HTTP \d{3}$/.test(error?.message ?? '') ? error.message : 'Employer feed could not be read safely.';return {jobs:[],meta}; }
  };
  // Bound simultaneous network work and retained response buffers.
  for (let offset=0;offset<config.sources.length;offset+=3) {
    for (const result of await Promise.all(config.sources.slice(offset,offset+3).map(readSource))) {jobs.push(...result.jobs);automation.sources.push(result.meta);}
  }
  automation.stats.fetched=jobs.length;
  const successful=automation.sources.filter(source=>source.status==='ok').length;
  if (!successful) {automation.status='failed';automation.finishedAt=new Date().toISOString();throw new ResearchError('No employer feed could be read; previous report was preserved.',automation);}
  if (successful!==config.sources.length) automation.status='partial';
  const ids=new Set(),urls=new Set(),selected=[],sourceJobs=new Map();
  for (const job of jobs) {
    if(ids.has(job.id)||urls.has(job.url)){automation.stats.duplicates++;continue;}
    ids.add(job.id);urls.add(job.url);sourceJobs.set(job.id,job);
    const record=screenJob(job,config.criteria,started);if(record)selected.push(record);
  }
  automation.stats.relevant=selected.length;
  selected.sort((a,b)=>(a.category==='verify'?0:1)-(b.category==='verify'?0:1)||b.matchScore-a.matchScore||a.company.localeCompare(b.company)||a.id.localeCompare(b.id));
  const previousIds=new Set(previous.records.filter(v=>v&&typeof v==='object').map(v=>v.id));
  const records=[];let excluded=0;
  for(const record of selected){
    if(record.category==='excluded'&&++excluded>(config.max_excluded??5))continue;
    record.isNew=!previousIds.has(record.id);records.push(record);
    if(records.length===(config.max_records??30))break;
  }
  automation.stats.selected=records.length;automation.stats.new=records.filter(v=>v.isNew).length;automation.finishedAt=new Date().toISOString();
  if(automation.status==='partial'&&!records.length){automation.status='failed';throw new ResearchError('Incomplete source coverage produced no selected findings; previous report was preserved.',automation);}
  const verify=records.filter(v=>v.category==='verify').length;
  const partial=automation.status==='partial'?' Some employer feeds failed; this is a partial search.':'';
  const report = {updatedAt:started.slice(0,10),mode:'Automated employer-feed research; applications require review',
    scope:'Search criteria: '+(config.criteria.label||'configured business title families')+'; U.S. locations with '+((config.criteria.preferred_locations??[]).join(', ')||'no specific city')+' preferred. '+(config.criteria.sponsorship_required?'Sponsorship required. ':'Sponsorship is recorded without being an exclusion. ')+((config.criteria.sponsorship_requirement_note??'').trim()?config.criteria.sponsorship_requirement_note.trim()+' ':'')+(config.criteria.start_window||'Start window is not confirmed.')+'. Employer start-date compatibility still requires verification. This run covers only the configured employer feeds, not LinkedIn or Indeed.',
    summary:`Automatically retrieved ${jobs.length} job records from ${successful} of ${config.sources.length} employer feeds. Selected ${verify} leads for verification and ${records.length-verify} excluded examples; ${automation.stats.relevant} title-relevant records were screened before display limits. No candidate résumé was evaluated and no applications were submitted.`+partial,
    records,additionalSources:automation.sources.map(source=>({title:source.name+' — public '+source.provider+' feed',url:source.url,note:source.status==='ok'?`Retrieved ${source.fetched} records in this run.`:'Could not retrieve this feed: '+source.error})),automation};
  if(typeof captureEvidence==='function') {
    const evidence=records.map(record=>{
      const job=sourceJobs.get(record.id);
      // Never truncate identifiers/URLs into a different job identity.
      if(!job||job.id.length>300||job.url.length>4000)return null;
      return {id:job.id,company:job.company.slice(0,500),title:job.title.slice(0,1000),location:job.location.slice(0,2000),url:job.url,description:job.description.slice(0,20000),sourceId:job.sourceId.slice(0,300),retrievedAt:started};
    }).filter(Boolean);
    captureEvidence(evidence);
  }
  return report;
}
const invocationMessage = (nonce, issuedAt, trigger) => new TextEncoder().encode(`${nonce}.${issuedAt}.${trigger}`);
export async function invocationSignature(secret, nonce, issuedAt, trigger) {
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC',key,invocationMessage(nonce,issuedAt,trigger)));
  return [...signature].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function verifyInvocation(body, signature, secret, nowSeconds = Math.floor(Date.now()/1000)) {
  if(typeof secret!=='string'||secret.length<32||secret.length>256||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))return false;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='issuedAt,nonce,trigger'
    ||typeof body.nonce!=='string'||!/^[a-f0-9]{64}$/.test(body.nonce)||!Number.isSafeInteger(body.issuedAt)
    ||Math.abs(nowSeconds-body.issuedAt)>300||!['manual','scheduled'].includes(body.trigger))return false;
  try {
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const bytes=Uint8Array.from(signature.match(/../g),part=>parseInt(part,16));
    return await crypto.subtle.verify('HMAC',key,bytes,invocationMessage(body.nonce,body.issuedAt,body.trigger));
  } catch { return false; }
}
async function invocationBody(request) {
  if(Number(request.headers.get('content-length'))>1024)throw new Error('Invalid invocation.');
  const reader=request.body?.getReader();if(!reader)throw new Error('Missing invocation.');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();throw new Error('Invalid invocation.');}chunks.push(value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
}
const jsonResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export function createHandler(env, fetchImpl = fetch) {
  let active=false;
  return async request => {
    if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers:{Allow:'POST'}});
    const signature=request.headers.get('x-gmoney-run-signature');
    if(!signature||!/^[a-f0-9]{64}$/.test(signature))return jsonResponse({error:'Not authorized'},401);
    let body;try{body=await invocationBody(request);}catch{return jsonResponse({error:'Not authorized'},401);}
    if(!await verifyInvocation(body,signature,env.GMONEY_RESEARCH_TRIGGER_KEY))return jsonResponse({error:'Not authorized'},401);
    if(active)return jsonResponse({error:'A research run is already active in this worker'},409);
    active=true;
    try {
      const origin=new URL(env.SUPABASE_URL);
      if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname)||(origin.port&&origin.port!=='443'))throw new Error('Invalid Supabase origin.');
      if(!env.GMONEY_PUBLISHABLE_KEY||!env.GMONEY_RESEARCH_KEY||env.GMONEY_RESEARCH_KEY.length<32)throw new Error('Missing worker configuration.');
      const config=validateConfig(JSON.parse(env.GMONEY_RESEARCH_CONFIG));
      const base=origin.origin;
      // The queue carries only a short-lived signature. Consume the private
      // one-use nonce before any employer request, rejecting replay atomically.
      let consumed;
      try {
        consumed=await jsonRequest(base+'/rest/v1/rpc/consume_research_invocation',{method:'POST',headers:{apikey:env.GMONEY_PUBLISHABLE_KEY,'Content-Type':'application/json','x-gmoney-research-key':env.GMONEY_RESEARCH_KEY},body:JSON.stringify({nonce:body.nonce})},fetchImpl,4096);
      } catch {return jsonResponse({error:'Invocation authorization could not be confirmed'},401);}
      if(consumed?.accepted!==true)return jsonResponse({error:'Invocation is unknown or already consumed'},401);
      const baseline=await jsonRequest(base+'/rest/v1/published_research_reports?slug=eq.current&select=report&limit=1',{headers:{apikey:env.GMONEY_PUBLISHABLE_KEY}},fetchImpl,2*1024*1024);
      if(!Array.isArray(baseline)||baseline.length!==1||!Array.isArray(baseline[0]?.report?.records))throw new Error('Could not load the previous report.');
      let evidence=[];
      const report=await runResearch(config,baseline[0].report,fetchImpl,body.trigger,selectedJobs=>{evidence=selectedJobs;});
      const encoded=JSON.stringify({report});if(new TextEncoder().encode(encoded).length>2*1024*1024)throw new Error('Research report exceeds publication limit.');
      const result=await jsonRequest(base+'/rest/v1/rpc/publish_automated_research',{method:'POST',headers:{apikey:env.GMONEY_PUBLISHABLE_KEY,'Content-Type':'application/json','x-gmoney-research-key':env.GMONEY_RESEARCH_KEY},body:encoded},fetchImpl,4096);
      if(typeof result?.published!=='boolean'||result.runId!==report.automation.runId)throw new Error('Publication could not be confirmed.');
      // Publication has already been confirmed. A secondary cache failure must
      // not turn a successful report into an alleged publication failure.
      let evidenceCached=evidence.length===0&&report.records.length===0;
      let evidenceCount=0;
      if(evidence.length) {
        try {
          const cached=await jsonRequest(base+'/rest/v1/rpc/cache_research_job_evidence',{method:'POST',headers:{apikey:env.GMONEY_PUBLISHABLE_KEY,'Content-Type':'application/json','x-gmoney-research-key':env.GMONEY_RESEARCH_KEY},body:JSON.stringify({jobs:evidence})},fetchImpl,4096,10000);
          if(Number.isInteger(cached?.cached)&&cached.cached>=0&&cached.cached<=evidence.length){evidenceCount=cached.cached;evidenceCached=evidenceCount===report.records.length;}
        } catch { /* Leave evidenceCached false; the published report remains. */ }
      }
      return jsonResponse({published:result.published,runId:result.runId,status:report.automation.status,finishedAt:report.automation.finishedAt,stats:report.automation.stats,sources:report.automation.sources,evidenceCached,evidenceCount});
    } catch(error) {
      if(error instanceof ResearchError)return jsonResponse({error:error.message,automation:error.automation},502);
      // Request headers/server bodies can contain credentials; never log them.
      return jsonResponse({error:'Research or publication could not be confirmed. Check source availability and server configuration before retrying.'},502);
    } finally {active=false;}
  };
}
if(typeof Deno!=='undefined') {
  const names=['SUPABASE_URL','GMONEY_PUBLISHABLE_KEY','GMONEY_RESEARCH_KEY','GMONEY_RESEARCH_TRIGGER_KEY','GMONEY_RESEARCH_CONFIG'];
  Deno.serve(createHandler(Object.fromEntries(names.map(name=>[name,Deno.env.get(name)]))));
}
