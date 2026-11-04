'use strict';
(() => {
  const el = id => document.getElementById(id);
  const bridge = window.GMONEY_APPLICATION_BRIDGE;
  if (!bridge || !el('applicationWorkspace')) return;
  let revision = 0, ready = false, busy = false;
  const statuses = {queued:'Queued for Windows',running:'Preparing in Windows',submitting:'Submission in progress',ready:'Prepared · not submitted',needs_input:'Paused · needs answers',needs_confirmation:'Confirmation uncertain · do not retry',submitted:'Confirmed submission',failed:'Failed · not confirmed'};
  function text(parent, tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function button(parent, label, action) {
    const node = text(parent, 'button', label, 'text');
    node.type = 'button'; node.onclick = action;
    return node;
  }
  function displayTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('en-US', {dateStyle:'medium', timeStyle:'short', timeZone:'America/Chicago'}).format(date) + ' Houston time'
      : 'Not reported';
  }
  function displaySchedule(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return '8:00 PM';
    const [hours, minutes] = value.split(':').map(Number);
    if (hours > 23 || minutes > 59) return '8:00 PM';
    return (hours % 12 || 12) + ':' + String(minutes).padStart(2, '0') + (hours >= 12 ? ' PM' : ' AM');
  }
  function clearToken() {
    el('applicationConnectorToken').value = '';
    el('applicationConnectorExpiry').textContent = '';
    el('applicationConnectorSecret').hidden = true;
  }
  function resetAnswer() {
    el('applicationAnswerKey').value = '';
    el('applicationAnswerQuestion').value = '';
    el('applicationAnswerQuestion').readOnly = false;
    el('applicationAnswerValue').value = '';
    el('applicationAnswerScope').value = '';
    el('applicationAnswerScope').required = true;
    el('applicationAnswerScopeField').hidden = false;
  }
  function controls() {
    el('refreshApplicationWorkspace').disabled = !bridge.isReady() || busy;
    for (const node of el('applicationWorkspace').querySelectorAll('button,input,textarea,select')) node.disabled = !ready || busy;
  }
  function clearPrivate() {
    ready = false;
    clearToken(); resetAnswer();
    for (const id of ['applicationAnswerList','applicationConnectorList','applicationJobList','applicationReportList']) el(id).replaceChildren();
    el('applicationAnswerScope').replaceChildren(new Option('Choose an application', ''));
    for (const id of ['applicationHeartbeat','applicationQueueCount','applicationReportSchedule']) el(id).textContent = '';
    el('applicationReportTime').value = '20:00';
    el('applicationReportEnabled').checked = false;
    el('applicationWorkspace').hidden = true;
    el('applicationConfirmedCount').textContent = bridge.isReady() ? 'Confirmations not loaded' : 'Sign in for confirmations';
    for (const id of ['applicationWorkerState','applicationConnectionState','applicationReportConnectionState']) {
      el(id).textContent = bridge.isReady() ? 'Status not loaded' : 'Sign in for status';
      el(id).classList.remove('green');
    }
    controls();
  }
  function sourceLink(parent, url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return;
      const link = text(parent, 'a', 'Employer posting ↗');
      link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    } catch {}
  }
  function validReceipt(job) {
    const receipt = job?.receipt;
    return job?.status === 'submitted' && receipt && ['greenhouse','lever'].includes(receipt.adapter) &&
      typeof receipt.confirmation_text === 'string' && receipt.confirmation_text.trim() &&
      receipt.source_url === job.source_url && Number.isFinite(Date.parse(receipt.confirmed_at));
  }
  async function questionKey(question, jobId) {
    if (!jobId) throw Error('Choose an application.');
    const normalized = String(question).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jobId + '\0' + normalized));
    return 'question_' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('').slice(0, 24);
  }
  async function chooseAnswer(question, key, answer = '', jobId) {
    const version = revision;
    const resolved = key || await questionKey(question, jobId);
    if (!ready || revision !== version || !bridge.isReady()) return;
    el('applicationAnswerKey').value = resolved;
    el('applicationAnswerQuestion').value = question;
    el('applicationAnswerQuestion').readOnly = true;
    el('applicationAnswerValue').value = answer;
    el('applicationAnswerScope').required = false;
    el('applicationAnswerScopeField').hidden = true;
    el('applicationAnswerForm').scrollIntoView({block:'center'});
    el('applicationAnswerValue').focus({preventScroll:true});
  }
  function renderAnswers(answers) {
    const list = el('applicationAnswerList');
    if (!answers.length) text(list, 'p', 'No private answers saved yet.', 'application-empty');
    for (const answer of answers) {
      if (!answer || typeof answer.key !== 'string' || typeof answer.question !== 'string' || typeof answer.answer !== 'string') throw Error('Invalid workspace.');
      const row = text(list, 'div', '', 'application-entry');
      text(row, 'h4', answer.question); text(row, 'p', answer.answer);
      text(row, 'p', answer.key.startsWith('question_') ? 'Saved for a specific application question.' : 'Saved reusable fact.', 'meta');
      button(row, 'Edit saved answer', () => chooseAnswer(answer.question, answer.key, answer.answer));
    }
  }
  function renderConnectors(connectors) {
    const active = connectors.filter(item => item && !item.revoked && Number.isFinite(Date.parse(item.expires_at)) && Date.parse(item.expires_at) > Date.now());
    const heartbeat = Math.max(0, ...active.map(item => Date.parse(item.last_seen_at) || 0));
    const recent = heartbeat > Date.now() - 600000 && heartbeat <= Date.now() + 60000;
    const label = recent ? 'Windows recently active' : active.length ? 'Waiting for Windows' : 'Windows setup needed';
    for (const id of ['applicationWorkerState','applicationConnectionState']) {
      el(id).textContent = label; el(id).classList.toggle('green', recent);
    }
    el('applicationHeartbeat').textContent = heartbeat
      ? 'Last connector contact: ' + displayTime(heartbeat) + '. This does not confirm that a browser task completed. Keep Windows on and the worker running for browser tasks.'
      : 'No Windows connector contact has been reported yet. Creating a key does not install or start the worker.';
    const list = el('applicationConnectorList');
    if (!connectors.length) text(list, 'p', 'No Windows connections created.', 'application-empty');
    for (const connector of connectors) {
      const row = text(list, 'div', '', 'application-entry');
      text(row, 'h4', connector.name || 'Windows connection');
      text(row, 'p', connector.revoked ? 'Revoked' : 'Expires ' + displayTime(connector.expires_at));
      if (!connector.revoked) button(row, 'Revoke connection', () => perform(async () => {
        await bridge.rpc('revoke_application_connector', {p_id:connector.id});
        await loadWorkspace();
      }, 'Windows connection revoked.'));
    }
  }
  function renderJobs(jobs) {
    const confirmed = jobs.filter(validReceipt).length;
    el('applicationConfirmedCount').textContent = 'Confirmed submissions shown: ' + confirmed;
    el('applicationQueueCount').textContent = jobs.length + ' application record' + (jobs.length === 1 ? '' : 's');
    const list = el('applicationJobList');
    if (!jobs.length) text(list, 'p', 'No browser attempts yet. Your prepared drafts are separate from application activity.', 'application-empty');
    for (const job of jobs) {
      if (!job || !statuses[job.status]) throw Error('Invalid workspace.');
      const row = text(list, 'article', '', 'application-entry');
      if (job.job_id) el('applicationAnswerScope').append(new Option([job.company,job.title].filter(Boolean).join(' · ') || 'Application', job.job_id));
      text(row, 'h4', [job.company,job.title].filter(Boolean).join(' · ') || 'Application');
      const confirmedJob = validReceipt(job);
      text(row, 'span', job.status === 'submitted' && !confirmedJob ? 'Confirmation missing · review needed' : statuses[job.status], 'badge' + (confirmedJob ? ' green' : ''));
      sourceLink(text(row, 'p', ''), job.source_url);
      if (confirmedJob) {
        const receipt = text(row, 'div', '', 'application-confirmation');
        text(receipt, 'p', job.receipt.confirmation_text);
        text(receipt, 'p', 'Employer confirmation recorded ' + displayTime(job.receipt.confirmed_at), 'meta');
      }
      if (job.status === 'needs_confirmation') text(row, 'p', 'Check the employer or your email before taking another action. Automatic resubmission is blocked.');
      if (typeof job.error === 'string' && job.error.trim()) text(row, 'p', job.error);
      for (const item of Array.isArray(job.questions) ? job.questions : []) {
        const question = typeof item === 'string' ? item : item?.question || item?.label;
        if (typeof question !== 'string' || !question.trim()) continue;
        const group = text(row, 'div', '', 'application-question');
        text(group, 'p', question);
        if (typeof item?.reason === 'string') text(group, 'p', item.reason, 'meta');
        button(group, 'Answer this question', () => chooseAnswer(question, typeof item?.key === 'string' ? item.key : null, '', job.job_id));
      }
      if (['needs_input','ready','failed'].includes(job.status) && job.draft_id) {
        button(row, 'Queue again after reviewing answers', () => queueDraft(job.draft_id, job.mode === 'prepare' ? 'prepare' : 'submit'));
      }
    }
  }
  function renderReports(reports, preferences) {
    if (!preferences || typeof preferences.enabled !== 'boolean' || preferences.timezone !== 'America/Chicago') throw Error('Invalid workspace.');
    const localTime = preferences.local_time || '20:00';
    el('applicationReportTime').value = localTime.slice(0, 5);
    el('applicationReportEnabled').checked = preferences.enabled;
    const label = displaySchedule(localTime) + ' Houston time';
    el('applicationReportSchedule').textContent = preferences.enabled
      ? 'Nightly dashboard report scheduled for ' + label + '. Confirmed submissions, paused attempts and failures stay separate.'
      : 'Nightly dashboard reports are disabled.';
    el('applicationReportConnectionState').textContent = preferences.enabled ? label + ' · dashboard' : 'Disabled';
    const list = el('applicationReportList');
    if (!reports.length) text(list, 'p', preferences.enabled ? 'Your first nightly report will appear here after the scheduled time.' : 'No nightly reports yet.', 'application-empty');
    for (const report of reports) {
      const row = text(list, 'article', '', 'application-entry');
      text(row, 'h4', 'Nightly report · ' + report.local_date);
      if (typeof report.summary === 'string') text(row, 'p', report.summary);
      text(row, 'p', 'Generated ' + displayTime(report.generated_at), 'meta');
      for (const [name,key] of [['Confirmed submissions','confirmed'],['Paused attempts','blocked'],['Failed attempts','failed']]) {
        const records = Array.isArray(report[key]) ? report[key] : [];
        text(row, 'h4', name + ': ' + records.length);
        if (records.length) {
          const items = text(row, 'ul', '');
          for (const record of records) text(items, 'li', typeof record === 'string' ? record : [record.company,record.title].filter(Boolean).join(' · ') || 'Application record');
        }
      }
      text(row, 'p', report.worker_last_seen_at ? 'Last worker activity in this report: ' + displayTime(report.worker_last_seen_at) : 'No Windows worker activity was reported for this account.', 'meta');
    }
  }
  async function loadWorkspace() {
    const version = ++revision;
    clearPrivate();
    if (!bridge.isReady()) {
      el('applicationAgentStatus').textContent = 'Sign in to connect Windows and see your private application activity.';
      return false;
    }
    el('applicationAgentStatus').textContent = 'Loading private answers, Windows activity and nightly reports…';
    try {
      const data = await bridge.rpc('get_application_workspace');
      if (version !== revision || !bridge.isReady()) return false;
      if (!data || !['answers','connectors','jobs','reports'].every(key => Array.isArray(data[key]))) throw Error('Invalid workspace.');
      renderAnswers(data.answers); renderConnectors(data.connectors); renderJobs(data.jobs); renderReports(data.reports,data.report_preferences);
      ready = true; el('applicationWorkspace').hidden = false;
      el('applicationAgentStatus').textContent = 'Private application activity loaded. Browser tasks run only through your installed Windows worker.';
      controls(); return true;
    } catch {
      if (version !== revision) return false;
      clearPrivate();
      el('applicationAgentStatus').textContent = 'Could not load private application activity. No connection or submission status is assumed. Refresh to retry.';
      return false;
    }
  }
  async function perform(action, success) {
    if (busy || !ready || !bridge.isReady()) return;
    const account = bridge.version();
    busy = true; clearToken(); controls();
    try {
      await action();
      if (bridge.version() === account && ready && success) el('applicationAgentStatus').textContent = success;
    } catch {
      if (bridge.version() !== account) return;
      ++revision; clearPrivate();
      el('applicationAgentStatus').textContent = 'Could not confirm this action. Refresh private application activity before trying again.';
    } finally {
      if (bridge.version() === account) { busy = false; controls(); }
    }
  }
  async function queueDraft(id, mode, card) {
    const status = card?.querySelector('.draft-action-status');
    if (!ready || busy || !bridge.isReady()) {
      if (status) status.textContent = 'Load your private application activity before queueing a Windows task.';
      return;
    }
    const account = bridge.version();
    await perform(async () => {
      const result = await bridge.rpc('queue_application_draft', {p_draft_id:id,p_mode:mode});
      const job = result?.job || result;
      if (!job || !statuses[job.status]) throw Error('Invalid queue result.');
      const loaded = await loadWorkspace();
      if (account === bridge.version() && loaded && status?.isConnected) status.textContent = job.status === 'queued'
        ? 'Queued for Windows. This is not a submission confirmation.'
        : statuses[job.status] + '. Check application activity below.';
    }, 'Application task saved. Check its status in application activity.');
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button[data-application-mode]');
    if (!target) return;
    queueDraft(target.dataset.draftId, target.dataset.applicationMode, target.closest('.application-draft'));
  });
  el('refreshApplicationWorkspace').onclick = async () => {
    if (busy) return;
    const account = bridge.version();
    busy = true; controls();
    try { await loadWorkspace(); } finally { if (account === bridge.version()) { busy = false; controls(); } }
  };
  el('createApplicationConnector').onclick = () => perform(async () => {
    const account = bridge.version();
    const result = await bridge.rpc('create_application_connector', {p_name:'Windows application worker'});
    if (!result || typeof result.token !== 'string' || !result.token || result.token.length > 1000) throw Error('Invalid connector.');
    const loaded = await loadWorkspace();
    if (account !== bridge.version() || !loaded) return;
    el('applicationConnectorToken').value = result.token;
    el('applicationConnectorExpiry').textContent = 'Expires ' + displayTime(result.expires_at) + '. This key is not stored in this browser.';
    el('applicationConnectorSecret').hidden = false;
  }, 'Windows connection key created. Copy it directly into Windows setup; it is shown only here.');
  el('copyApplicationConnectorToken').onclick = async () => {
    const account = bridge.version();
    try {
      if (!ready || !el('applicationConnectorToken').value) return;
      await navigator.clipboard.writeText(el('applicationConnectorToken').value);
      if (account === bridge.version() && ready) el('applicationAgentStatus').textContent = 'Connection key copied. Paste it directly into Windows setup.';
    } catch { if (account === bridge.version() && ready) el('applicationAgentStatus').textContent = 'Select the connection key and copy it manually.'; }
  };
  el('hideApplicationConnectorToken').onclick = clearToken;
  el('newApplicationAnswer').onclick = () => { resetAnswer(); el('applicationAnswerQuestion').focus(); };
  el('applicationAnswerForm').onsubmit = event => {
    event.preventDefault();
    const question = el('applicationAnswerQuestion').value.trim(), answer = el('applicationAnswerValue').value.trim(), key = el('applicationAnswerKey').value, jobId = el('applicationAnswerScope').value;
    const account = bridge.version();
    if (!question || !answer) return;
    perform(async () => {
      const resolved = key || await questionKey(question, jobId);
      if (account !== bridge.version() || !bridge.isReady()) return;
      await bridge.rpc('save_application_answer', {p_key:resolved,p_question:question,p_answer:answer});
      await loadWorkspace();
    }, 'Private answer saved for reuse. Review paused applications before queueing them again.');
  };
  el('applicationReportForm').onsubmit = event => {
    event.preventDefault();
    const time = el('applicationReportTime').value, enabled = el('applicationReportEnabled').checked;
    perform(async () => {
      await bridge.rpc('set_application_report_schedule', {p_local_time:time,p_enabled:enabled});
      await loadWorkspace();
    }, 'Nightly dashboard report schedule saved. Email delivery is not connected.');
  };
  window.addEventListener('gmoney:profile-state', () => {
    ++revision; busy = false; clearPrivate();
    if (bridge.isReady()) loadWorkspace();
    else el('applicationAgentStatus').textContent = 'Sign in to connect Windows and see your private application activity.';
  });
  clearPrivate();
  if (bridge.isReady()) loadWorkspace();
})();
