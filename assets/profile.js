'use strict';
(() => {
  const el = id => document.getElementById(id);
  const cfg = window.GMONEY_DB;
  const storageKey = 'gmoney_session';
  const linkStorageKey = 'gmoney_email_link';
  const codeMode = cfg.emailMode === 'code';
  const linkRecovery = 'This sign-in link cannot be used. Request a new sign-in link and open it in the same browser and device.';
  const storageRecovery = 'Allow browser storage, then request a new sign-in link.';
  const callback = window.GMONEY_AUTH_CALLBACK;
  delete window.GMONEY_AUTH_CALLBACK;
  let session = null;
  let generation = 0;
  let pendingEmail = '';
  let authAction = null;
  let resendAvailableAt = 0;
  let resendTimer;
  let profileReady = false;
  const fields = ['fullName', 'roles', 'instructions', 'locations', 'salary', 'sponsorship', 'resumeText'];
  const clearFields = () => { for (const id of fields) el(id).value = id === 'sponsorship' ? 'unspecified' : ''; };
  const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function clearPendingLink() {
    try { localStorage.removeItem(linkStorageKey); }
    catch { throw Error(storageRecovery); }
  }
  function readPendingLink() {
    let raw, record;
    try { raw = localStorage.getItem(linkStorageKey); }
    catch { throw Error(storageRecovery); }
    try { record = JSON.parse(raw || 'null'); }
    catch { clearPendingLink(); return null; }
    if (!record) return null;
    const age = Date.now() - record.requestedAt;
    if (record.version !== 1 || typeof record.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(record.email) || record.email.length > 320 ||
      typeof record.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.verifier) ||
      typeof record.requestId !== 'string' || !record.requestId || record.requestId.length > 100 ||
      !Number.isFinite(record.requestedAt) || age < 0 || age > 3600000) {
      clearPendingLink();
      return null;
    }
    return record;
  }
  function linkRecordLock(action) {
    return navigator.locks ? navigator.locks.request(linkStorageKey, action) : Promise.resolve().then(action);
  }
  async function sendEmailLink(email) {
    if (!crypto.subtle) throw Error('Open this site securely to request a sign-in link.');
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const record = {version:1, email, verifier, requestedAt:Date.now(), requestId:base64url(crypto.getRandomValues(new Uint8Array(16)))};
    let previous;
    try {
      await linkRecordLock(() => {
        previous = readPendingLink();
        localStorage.setItem(linkStorageKey, JSON.stringify(record));
        if (localStorage.getItem(linkStorageKey) !== JSON.stringify(record)) throw Error();
      });
    } catch { throw Error(storageRecovery); }
    try {
      const redirect = location.origin + location.pathname;
      await request('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect), {method:'POST', body:JSON.stringify({email, create_user:true, code_challenge:challenge, code_challenge_method:'s256'})});
    } catch (error) {
      try {
        await linkRecordLock(() => {
          if (readPendingLink()?.requestId !== record.requestId) return;
          if (previous) localStorage.setItem(linkStorageKey, JSON.stringify(previous));
          else localStorage.removeItem(linkStorageKey);
        });
      } catch { /* Do not erase another tab's newer request. */ }
      throw error;
    }
  }
  function updateAuthControls() {
    const remaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000));
    const sendButton = el('emailForm').querySelector('button');
    sendButton.disabled = !!authAction || remaining > 0;
    const method = codeMode ? 'code' : 'link';
    sendButton.textContent = remaining > 0 ? 'Send another ' + method + ' in ' + remaining + 's' : pendingEmail ? 'Send another sign-in ' + method : 'Send sign-in ' + method;
    el('accountEmail').disabled = !!authAction;
    el('codeForm').querySelector('button').disabled = !codeMode || !!authAction || !pendingEmail;
    el('loginCode').disabled = !!authAction;
    el('codeDestination').textContent = codeMode && pendingEmail ? 'Enter the code sent to ' + pendingEmail + '.' : '';
    clearTimeout(resendTimer);
    if (remaining > 0) resendTimer = setTimeout(updateAuthControls, 1000);
  }
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
    pendingEmail = '';
    resendAvailableAt = 0;
    el('loginCode').value = '';
    updateAuthControls();
    el('applicationDraftList').replaceChildren();
    el('privateApplicationDrafts').hidden = true;
    el('applicationDraftSignIn').hidden = !!session;
    el('refreshApplicationDrafts').disabled = true;
    el('applicationDraftStatus').textContent = session ? 'Loading your private application drafts…' : 'Sign in to view your private application drafts.';
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory session remains usable. */ }
  }
  async function request(path, options = {}, token) {
    const isOtpRequest = path.split('?')[0] === '/auth/v1/otp';
    const isLinkExchange = path === '/auth/v1/token?grant_type=pkce';
    const isCodeRequest = isOtpRequest || path === '/auth/v1/verify' || isLinkExchange;
    let response;
    try {
      response = await fetch(cfg.url + path, {
        ...options,
        headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}), ...options.headers },
        signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw Error(isLinkExchange ? linkRecovery : 'Could not connect. Check your connection and try again.');
    }
    if (!response.ok) {
      if (response.status === 401 && token && session?.access_token === token) {
        setSession(null);
        el('authStatus').textContent = 'Your session expired. Sign in again.';
      }
      if (isCodeRequest) {
        let code;
        try {
          const body = await response.json();
          code = typeof body?.code === 'string' ? body.code : body?.error_code;
        } catch {}
        if (response.status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(code)) {
          const error = Error(isLinkExchange ? 'Too many attempts. Wait at least a minute, then request a new sign-in link.' : 'Too many attempts. Wait at least a minute before trying again.');
          error.retrySendAfter = isOtpRequest ? 60000 : 0;
          throw error;
        }
        if (isLinkExchange) throw Error(linkRecovery);
        if (path === '/auth/v1/verify' && (['otp_expired', 'otp_disabled', 'validation_failed'].includes(code) || [400, 401, 403].includes(response.status))) {
          throw Error('That sign-in code is invalid or expired. Try the latest code or request a new one.');
        }
        if (code === 'email_address_invalid') throw Error('Enter a valid email address and try again.');
        if (['email_provider_disabled', 'signup_disabled'].includes(code)) throw Error('Email sign-in is temporarily unavailable. Please try again later.');
        throw Error(isOtpRequest
          ? 'Could not send a sign-in ' + (codeMode ? 'code' : 'link') + '. Try again in a minute. If delivery still fails, contact support.'
          : 'Could not verify your code. Please try again.');
      }
      throw Error(response.status === 429 ? 'Too many attempts. Please wait before trying again.' : 'Request failed. Check your connection and try again.');
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw Error(isLinkExchange ? linkRecovery : isCodeRequest ? 'Sign-in response could not be read. Request a new ' + (codeMode ? 'code' : 'link') + '.' : 'Request failed. Please try again.'); }
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
  async function authenticate(action, work) {
    if (authAction || session || (action === 'send' && Date.now() < resendAvailableAt)) return;
    const version = generation;
    authAction = action;
    updateAuthControls();
    try { await work(version); }
    catch (error) {
      if (generation !== version) return;
      if (error.retrySendAfter) resendAvailableAt = Date.now() + error.retrySendAfter;
      el('authStatus').textContent = error.message;
    } finally {
      authAction = null;
      updateAuthControls();
    }
  }
  el('emailForm').onsubmit = event => {
    event.preventDefault();
    const requestedEmail = el('accountEmail').value.trim();
    authenticate('send', async version => {
      if (codeMode) await request('/auth/v1/otp', {method:'POST', body:JSON.stringify({email:requestedEmail, create_user:true})});
      else await sendEmailLink(requestedEmail);
      if (generation !== version) return;
      pendingEmail = requestedEmail;
      resendAvailableAt = Date.now() + 60000;
      el('loginCode').value = '';
      el('codeForm').hidden = !codeMode;
      el('authStatus').textContent = codeMode
        ? 'Check your email for a sign-in code. Use the latest code sent to you.'
        : 'Check your email for a sign-in link. Use the latest link and open it in the same browser and device where you requested it.';
      updateAuthControls();
    }).then(() => {
      if (codeMode && pendingEmail && !session) el('loginCode').focus();
    });
  };
  el('codeForm').onsubmit = event => {
    event.preventDefault();
    if (!codeMode || !pendingEmail) return;
    const email = pendingEmail, token = el('loginCode').value.trim();
    authenticate('verify', async version => {
      const result = await request('/auth/v1/verify', {method:'POST', body:JSON.stringify({email, token, type:'email'})});
      if (generation !== version) return;
      if (!result?.user?.id || !result.access_token || !result.refresh_token) throw Error('Sign-in failed. Request a new code.');
      result.expires_at ||= Math.floor(Date.now()/1000) + result.expires_in;
      setSession(result);
      await readProfile();
    });
  };
  el('signOut').onclick = async () => {
    const token = session?.access_token;
    setSession(null);
    el('authStatus').textContent = 'Signed out on this device.';
    if (!codeMode) {
      try { await linkRecordLock(clearPendingLink); }
      catch { if (!session) el('authStatus').textContent = 'Signed out. Clear this browser’s site data to remove the pending sign-in link.'; }
    }
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
  el('authHelp').textContent = codeMode
    ? 'Sign in with an email code to save your information across devices.'
    : 'Sign in with an email link to save your information across devices. Open the link in the same browser and device where you request it.';
  if (callback && !session) {
    if (codeMode || callback.error || !callback.code) {
      el('authStatus').textContent = codeMode ? 'This sign-in link cannot be used. Request a new sign-in code below.' : linkRecovery;
    } else {
      authenticate('link', async version => {
        const pending = await linkRecordLock(() => {
          const record = readPendingLink();
          if (!record) throw Error(linkRecovery);
          clearPendingLink();
          return record;
        });
        const result = await request('/auth/v1/token?grant_type=pkce', {method:'POST', body:JSON.stringify({auth_code:callback.code, code_verifier:pending.verifier})});
        if (generation !== version) return;
        if (!result?.user?.id || !result.access_token || !result.refresh_token || typeof result.user.email !== 'string' || result.user.email.toLowerCase() !== pending.email.toLowerCase()) throw Error(linkRecovery);
        result.expires_at ||= Math.floor(Date.now()/1000) + result.expires_in;
        setSession(result);
        await readProfile();
      });
    }
  } else if (!codeMode && !session) {
    authenticate('restore', async version => {
      const pending = await linkRecordLock(readPendingLink);
      if (generation !== version) return;
      if (pending) {
        pendingEmail = pending.email;
        el('accountEmail').value = pending.email;
        resendAvailableAt = pending.requestedAt + 60000;
        el('authStatus').textContent = 'Check your email for a sign-in link. Use the latest link and open it in this browser and device.';
      }
    });
  }
  updateAuthControls();
})();
