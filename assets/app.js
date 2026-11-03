'use strict';
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : '#'; } catch { return '#'; } };
const names = {
  overview:["Here’s the work so far.", 'Research, decisions and next steps. All in one place.'],
  automation:['Research, with a record.', 'See what ran, what it checked and what it found.'],
  research:['The research record.', 'Every finding has a reason and a source.'],
  applications:['Your application history.', 'Only confirmed actions belong here.'],
  preferences:['Your profile. Your direction.', 'Sign in to save your experience and job preferences.'],
  connections:['The working system.', 'What is live, what is missing, and what happens next.']
};
function show(view) {
  if (!names[view]) view = 'overview';
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== view);
  document.querySelectorAll('[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  });
  $('heading').textContent = names[view][0];
  $('subheading').textContent = names[view][1];
  history.replaceState(null, '', '#' + view);
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-view],[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.view || b.dataset.go)));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));
let report = null;
let selectedFilter = 'all';
let scheduleConfig = null;
function renderRecords(filter = selectedFilter) {
  selectedFilter = filter;
  const records = report.records.filter(r => filter === 'all' || r.category === filter);
  $('records').innerHTML = records.map(r => `<article class="finding"><div class="section-title"><h3>${escapeHTML(r.title)}</h3><span class="badge">${escapeHTML(r.decision)}</span></div><div class="meta">${escapeHTML(r.company)} · ${escapeHTML(r.location)} · Checked ${escapeHTML(r.checkedAt)}</div><h4>Sponsorship evidence</h4><p>${escapeHTML(r.sponsorship)}</p><h4>What I found</h4><p>${escapeHTML(r.finding)}</p><h4>Fit assessment</h4><p>${escapeHTML(r.fit)}</p><h4>Next action</h4><p>${escapeHTML(r.next)}</p><a href="${escapeHTML(safeURL(r.url))}" target="_blank" rel="noopener noreferrer">Employer posting / source ↗</a></article>`).join('') || '<p>No findings in this category.</p>';
}
document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
  if (!report) return;
  document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('selected', x === b));
  renderRecords(b.dataset.filter);
});
const displayCount = value => Number.isInteger(value) && value >= 0 ? value.toLocaleString() : '—';
function displayTime(value) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not reported' : new Intl.DateTimeFormat(undefined, {dateStyle:'medium', timeStyle:'short', timeZoneName:undefined}).format(date);
}
function renderAutomation(data) {
  const run = data.automation;
  $('automationScope').textContent = data.scope || 'No search criteria were included with this report.';
  $('automationFindings').innerHTML = data.records.slice(0, 3).map(r => `<article class="finding"><div class="section-title"><h3>${escapeHTML(r.title)}</h3><span class="badge">${escapeHTML(r.decision)}</span></div><p class="meta">${escapeHTML(r.company)} · ${escapeHTML(r.location)}</p><p>${escapeHTML(r.fit)}</p><p><b>Sponsorship:</b> ${escapeHTML(r.sponsorship)}</p><a href="${escapeHTML(safeURL(r.url))}" target="_blank" rel="noopener noreferrer">View employer posting ↗</a></article>`).join('') || '<p>No findings were recorded in this report. Check the source results and search criteria above.</p>';
  $('automationRunStatus').classList.remove('green');
  if (!run || typeof run !== 'object') {
    $('automationRunStatus').textContent = 'No automated run published';
    $('automationState').textContent = 'This report was published without automated-run evidence. The research below is available, but it does not establish that a worker or recurring search ran.';
    for (const id of ['automationSources','automationFetched','automationSelected']) $(id).textContent = '—';
    for (const id of ['automationFinished','automationRunId','automationTrigger']) $(id).textContent = 'Not reported';
    $('automationSourceList').innerHTML = '<li>No automated source results were included in this report.</li>';
    return;
  }
  const sources = Array.isArray(run.sources) ? run.sources : [];
  const successful = sources.filter(s => s.status === 'ok').length;
  const partial = run.status === 'partial';
  const completed = run.status === 'completed';
  $('automationRunStatus').textContent = partial ? 'Completed with source failures' : completed ? 'Run completed' : 'Run status not established';
  $('automationRunStatus').classList.toggle('green', completed);
  $('automationState').textContent = partial
    ? 'The worker recorded findings from responding feeds. Some sources failed, so this report has incomplete coverage; those failures are listed below.'
    : completed ? 'The worker fetched employer postings and recorded screening results. Source counts and timestamps below describe this run only.'
      : 'Run evidence is available, but its completion status was not recognized. Review the source results before relying on coverage.';
  $('automationSources').textContent = `${successful} / ${sources.length}`;
  $('automationFetched').textContent = displayCount(run.stats?.fetched);
  $('automationSelected').textContent = displayCount(run.stats?.selected);
  $('automationFinished').textContent = displayTime(run.finishedAt);
  $('automationRunId').textContent = run.runId || 'Not reported';
  $('automationTrigger').textContent = run.trigger === 'scheduled' ? 'Schedule-triggered run' : run.trigger === 'manual' ? 'On-demand run' : 'Not reported';
  $('automationSourceList').innerHTML = sources.map(source => {
    const ok = source.status === 'ok';
    const status = ok ? 'Responded' : source.status === 'failed' ? 'Failed' : 'Status unknown';
    const url = safeURL(source.url);
    const name = escapeHTML(source.name || source.id || 'Unnamed source');
    return `<li><div class="section-title"><b>${url === '#' ? name : `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${name} ↗</a>`}</b><span class="badge${ok ? ' green' : ''}">${status}</span></div><p>${ok ? `${displayCount(source.fetched)} postings fetched` : 'This source did not contribute verified coverage.'}${Number.isInteger(source.invalid) && source.invalid > 0 ? ` · ${displayCount(source.invalid)} invalid entries skipped` : ''}</p>${!ok && source.error ? `<p class="source-error">${escapeHTML(source.error)}</p>` : ''}</li>`;
  }).join('') || '<li>No source results were included in this run.</li>';
}
function renderSchedule(config, stale = false) {
  if (!config) {
    $('automationSchedule').textContent = stale ? 'Schedule status unavailable' : 'No recurring schedule reported';
    $('automationScheduleNote').textContent = stale
      ? 'Could not load schedule settings. The research report can still be viewed.'
      : 'No schedule configuration was included. A past scheduled run does not confirm a current schedule.';
    return;
  }
  const expression = typeof config.schedule_expression === 'string' ? config.schedule_expression.trim() : '';
  const everySixHours = /^(?:[0-5]?\d)\s+(?:\*\/6|0,6,12,18)\s+\*\s+\*\s+\*$/.test(expression);
  const description = config.schedule_enabled
    ? everySixHours ? 'Configured every 6 hours' : 'Recurring searches configured'
    : 'Recurring searches disabled';
  $('automationSchedule').textContent = stale ? 'Last reported: ' + description.toLowerCase() : description;
  const updated = displayTime(config.updated_at);
  $('automationScheduleNote').textContent = (stale ? 'Could not refresh schedule settings; this configuration may be stale. ' : '')
    + (updated === 'Not reported' ? 'Configuration date not reported. ' : 'Configuration recorded ' + updated + '. ')
    + 'Check the latest run time for recent activity.';
}
async function refreshSchedule(cfg) {
  try {
    const response = await fetch(cfg.url + '/rest/v1/research_automation_status?slug=eq.current&select=schedule_enabled,schedule_expression,backend,updated_at&limit=1', {
      cache:'no-store', headers:{apikey:cfg.publishableKey}, signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error('Schedule unavailable');
    const rows = await response.json();
    if (!Array.isArray(rows) || (rows[0] && typeof rows[0].schedule_enabled !== 'boolean')) throw Error('Invalid schedule configuration');
    scheduleConfig = rows[0] || null;
    renderSchedule(scheduleConfig);
  } catch {
    renderSchedule(scheduleConfig, true);
  }
}
async function load() {
  const refreshButtons = [$('refreshReport'), $('refreshAutomation')];
  refreshButtons.forEach(b => b.disabled = true);
  $('loadState').hidden = false;
  $('loadState').textContent = 'Loading research from Supabase…';
  $('automationLoadState').textContent = 'Checking the latest published run…';
  let scheduleRefresh = Promise.resolve();
  try {
    const cfg = window.GMONEY_DB;
    if (!cfg?.url || !cfg?.publishableKey) { renderSchedule(scheduleConfig, true); throw Error('Database is not configured'); }
    scheduleRefresh = refreshSchedule(cfg);
    const res = await fetch(cfg.url + '/rest/v1/published_research_reports?slug=eq.current&select=report,published_at&limit=1', {cache:'no-store', headers:{apikey:cfg.publishableKey}, signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw Error('Report unavailable');
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows[0]?.report) throw Error('Report not published');
    const data = rows[0].report;
    if (!Array.isArray(data.records)) throw Error('Invalid report');
    report = data;
    $('checked').textContent = report.records.length;
    $('verification').textContent = report.records.filter(r => r.category === 'verify').length;
    $('summary').textContent = report.summary;
    $('scope').textContent = report.scope;
    $('date').textContent = 'Checked ' + report.updatedAt;
    $('footerDate').textContent = report.updatedAt;
    $('latest').innerHTML = report.records.slice(0, 3).map(r => `<div class="row"><div><b>${escapeHTML(r.company)}</b><p>${escapeHTML(r.title)}</p></div><span class="badge">${escapeHTML(r.decision)}</span></div>`).join('');
    $('sources').innerHTML = (Array.isArray(report.additionalSources) ? report.additionalSources : []).map(s => `<p><a href="${escapeHTML(safeURL(s.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.title)} ↗</a><br><span class="meta">${escapeHTML(s.note)}</span></p>`).join('');
    renderRecords();
    renderAutomation(report);
    $('loadState').hidden = true;
    $('automationLoadState').textContent = '';
    $('databaseStatus').textContent = 'Supabase connected · report loaded';
  } catch {
    $('loadState').textContent = report ? 'Could not refresh from Supabase. The previously loaded report is still shown and may be stale.' : 'Could not load the report from Supabase. Please try Refresh report. No results have been assumed.';
    $('automationLoadState').textContent = report ? 'Refresh failed. Showing the previously loaded report; its run evidence may be stale.' : 'Could not load run evidence from Supabase. No automation results have been assumed.';
    $('databaseStatus').textContent = 'Database could not be reached';
  } finally {
    await scheduleRefresh;
    refreshButtons.forEach(b => b.disabled = false);
  }
}
$('refreshReport').addEventListener('click', load);
$('refreshAutomation').addEventListener('click', load);
load();
