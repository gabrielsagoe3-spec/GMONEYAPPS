'use strict';
(() => {
  const el = id => document.getElementById(id);
  const cfg = window.GMONEY_DB;
  const storageKey = 'gmoney_session';
  let session = null;
  let generation = 0;
  let email = '';
  let profileReady = false;
  const fields = ['fullName', 'roles', 'instructions', 'locations', 'salary', 'sponsorship', 'resumeText'];
  const clearFields = () => { for (const id of fields) el(id).value = id === 'sponsorship' ? 'unspecified' : ''; };
  function setSession(value) {
    session = value;
    generation++;
    profileReady = false;
    clearFields();
    el('saveStatus').textContent = '';
    el('profileFields').disabled = true;
    el('preferencesForm').hidden = !session;
    el('signOut').hidden = !session;
    el('emailForm').hidden = !!session;
    el('codeForm').hidden = true;
    el('applicationDraftList').replaceChildren();
    el('privateApplicationDrafts').hidden = true;
    el('applicationDraftSignIn').hidden = !!session;
    el('refreshApplicationDrafts').disabled = true;
    el('applicationDraftStatus').textContent = session ? 'Loading your private application drafts…' : 'Sign in to view your private application drafts.';
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory session remains usable. */ }
  }
  async function request(path, options = {}, token) {
    const response = await fetch(cfg.url + path, {
      ...options,
      headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}), ...options.headers },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      if (response.status === 401 && token && session?.access_token === token) {
        setSession(null);
        el('authStatus').textContent = 'Your session expired. Sign in again.';
      }
      throw Error(response.status === 429 ? 'Too many attempts. Please wait before trying again.' : 'Request failed. Check your connection and try again.');
    }
    return response.status === 204 ? null : response.json();
  }
  async function activeSession() {
    if (!session) throw Error('Sign in first.');
    if (session.expires_at * 1000 > Date.now() + 60000) return session;
    const current = session, version = generation;
    const next = await request('/auth/v1/token?grant_type=refresh_token', {method:'POST', body:JSON.stringify({refresh_token:current.refresh_token})});
    if (generation !== version) throw Error('Account changed. Try again.');
    if (!next.user?.id || !next.access_token || !next.refresh_token) throw Error('Please sign in again.');
    session = {...next, expires_at: next.expires_at || Math.floor(Date.now()/1000) + next.expires_in};
    try { sessionStorage.setItem(storageKey, JSON.stringify(session)); } catch {}
    return session;
  }
  function appendText(parent, tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  }
  function renderApplicationDrafts(drafts) {
    el('applicationDraftList').replaceChildren();
    for (const draft of drafts) {
      if (!draft || draft.status !== 'needs_input') throw Error('Invalid application draft.');
      const card = document.createElement('article');
      card.className = 'finding';
      appendText(card, 'h3', draft.title || 'Application draft');
      const meta = appendText(card, 'p', [draft.company, draft.location].filter(Boolean).join(' · '));
      meta.className = 'meta';
      const badge = appendText(card, 'span', 'Needs your answers · Not submitted');
      badge.className = 'badge';
      try {
        const url = new URL(draft.source_url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const source = appendText(card, 'p', '');
          const link = appendText(source, 'a', 'Employer posting ↗');
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        }
      } catch {}
      for (const [title, value] of [['Tailored résumé summary', draft.tailored_summary], ['Cover letter draft', draft.cover_letter]]) {
        const details = document.createElement('details');
        appendText(details, 'summary', title);
        appendText(details, 'p', value || 'No draft text prepared.').style.whiteSpace = 'pre-wrap';
        card.append(details);
      }
      for (const [title, values] of [['Why this role may fit', draft.match_notes], ['Answers and checks still needed', draft.missing_answers]]) {
        appendText(card, 'h4', title);
        const list = document.createElement('ul');
        for (const value of Array.isArray(values) ? values : []) appendText(list, 'li', value);
        if (!list.childElementCount) appendText(list, 'li', 'Review is still required before applying.');
        card.append(list);
      }
      el('applicationDraftList').append(card);
    }
    el('privateApplicationDrafts').hidden = drafts.length === 0;
  }
  async function readApplicationDrafts() {
    const version = generation;
    if (!session || !profileReady) return;
    el('refreshApplicationDrafts').disabled = true;
    el('applicationDraftStatus').textContent = 'Loading your private application drafts…';
    el('applicationDraftList').replaceChildren();
    el('privateApplicationDrafts').hidden = true;
    try {
      const current = await activeSession();
      const drafts = await request('/rest/v1/rpc/list_candidate_application_drafts', {method:'POST', body:'{}'}, current.access_token);
      if (version !== generation) return;
      if (!Array.isArray(drafts)) throw Error('Invalid application drafts.');
      renderApplicationDrafts(drafts);
      el('applicationDraftStatus').textContent = drafts.length
        ? drafts.length + ' private application drafts ready for review. No applications have been submitted.'
        : 'No private application drafts are prepared for this account yet.';
    } catch {
      if (version !== generation) return;
      el('applicationDraftList').replaceChildren();
      el('privateApplicationDrafts').hidden = true;
      el('applicationDraftStatus').textContent = 'Could not load your private drafts. Use Refresh private drafts to retry.';
    } finally {
      if (version === generation && session) el('refreshApplicationDrafts').disabled = false;
    }
  }
  el('refreshApplicationDrafts').onclick = readApplicationDrafts;
  async function readProfile() {
    const version = generation;
    try {
      const current = await activeSession();
      let imported = false, importUnavailable = false;
      try {
        const result = await request('/rest/v1/rpc/claim_candidate_profile', {method:'POST', body:'{}'}, current.access_token);
        imported = result?.imported === true;
      } catch {
        importUnavailable = true;
      }
      if (version !== generation) return;
      const rows = await request('/rest/v1/agent_preferences?user_id=eq.' + encodeURIComponent(current.user.id) + '&select=*&limit=1', {}, current.access_token);
      if (version !== generation) return;
      const p = rows[0] || {};
      el('fullName').value = p.full_name || '';
      el('roles').value = p.preferred_roles || '';
      el('instructions').value = p.instructions || '';
      el('locations').value = (p.locations || []).join('; ');
      el('salary').value = p.minimum_salary ?? '';
      el('sponsorship').value = p.sponsorship_need || 'unspecified';
      el('resumeText').value = p.resume_text || '';
      profileReady = true;
      el('profileFields').disabled = false;
      el('authStatus').textContent = 'Signed in as ' + current.user.email;
      el('saveStatus').textContent = imported
        ? 'Your uploaded résumé is ready in your private profile. Review it before saving changes.'
        : rows.length ? 'Your saved profile is loaded.' : 'Ready for your first profile.';
      if (importUnavailable) el('saveStatus').textContent += ' Uploaded résumé import is unavailable; you can still edit and save this profile.';
      await readApplicationDrafts();
    } catch {
      if (version !== generation) return;
      el('authStatus').textContent = 'Could not load your profile. Reload to retry; editing is disabled to protect saved information.';
      el('applicationDraftStatus').textContent = 'Your profile could not be loaded. Reload to retry loading private application drafts.';
    }
  }
  async function busy(form, action, status) {
    const button = form.querySelector('button'); button.disabled = true;
    try { await action(); } catch (error) { el(status).textContent = error.message; }
    finally { button.disabled = false; }
  }
  el('emailForm').onsubmit = event => {
    event.preventDefault();
    busy(event.currentTarget, async () => {
      email = el('accountEmail').value.trim();
      await request('/auth/v1/otp', {method:'POST', body:JSON.stringify({email, create_user:true})});
      el('codeForm').hidden = false;
      el('authStatus').textContent = 'Check your email for a sign-in code. Enter it below.';
      el('loginCode').focus();
    }, 'authStatus');
  };
  el('codeForm').onsubmit = event => {
    event.preventDefault();
    busy(event.currentTarget, async () => {
      const result = await request('/auth/v1/verify', {method:'POST', body:JSON.stringify({email, token:el('loginCode').value.trim(), type:'email'})});
      if (!result.user?.id || !result.access_token || !result.refresh_token) throw Error('Sign-in failed. Request a new code.');
      result.expires_at ||= Math.floor(Date.now()/1000) + result.expires_in;
      setSession(result);
      el('loginCode').value = '';
      await readProfile();
    }, 'authStatus');
  };
  el('signOut').onclick = () => {
    const token = session?.access_token;
    setSession(null);
    el('authStatus').textContent = 'Signed out on this device.';
    if (token) request('/auth/v1/logout?scope=local', {method:'POST'}, token).catch(() => {
      if (!session) el('authStatus').textContent = 'Signed out locally. Could not revoke the server session; it will expire automatically.';
    });
  };
  el('preferencesForm').onsubmit = event => {
    event.preventDefault();
    if (!profileReady) return;
    const version = generation;
    const values = {
      full_name:el('fullName').value.trim(), preferred_roles:el('roles').value.trim(),
      instructions:el('instructions').value, locations:el('locations').value.split(';').map(s=>s.trim()).filter(Boolean),
      minimum_salary:el('salary').value === '' ? null : Number(el('salary').value),
      sponsorship_need:el('sponsorship').value, resume_text:el('resumeText').value,
      updated_at:new Date().toISOString()
    };
    busy(event.currentTarget, async () => {
      const current = await activeSession();
      if (version !== generation) return;
      await request('/rest/v1/agent_preferences?on_conflict=user_id', {method:'POST', headers:{Prefer:'resolution=merge-duplicates,return=minimal'}, body:JSON.stringify({...values,user_id:current.user.id})}, current.access_token);
      if (version === generation) el('saveStatus').textContent = 'Profile saved to your private account.';
    }, 'saveStatus');
  };
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem('gm_prefs') || 'null'); } catch {}
  if (legacy && typeof legacy === 'object') {
    el('localPreferenceNotice').hidden = false;
    el('importLocal').hidden = false;
    el('importLocal').onclick = () => {
      if (!profileReady) { el('authStatus').textContent = 'Sign in and load your profile before copying old preferences.'; return; }
      if (!confirm('Replace the instructions, locations and salary in this form with your old device preferences? Nothing is saved until you choose Save private profile.')) return;
      for (const id of ['instructions','locations']) el(id).value = typeof legacy[id] === 'string' ? legacy[id] : '';
      el('salary').value = /^\d+$/.test(legacy.salary || '') ? legacy.salary : '';
      el('saveStatus').textContent = 'Old preferences copied. Review them, then save.';
    };
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (stored?.user?.id && stored.access_token && stored.refresh_token) { setSession(stored); readProfile(); }
  } catch { setSession(null); }
})();
