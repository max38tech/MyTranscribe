// AutoSupport integration for MyTranscribe.
//
// Loaded as a module, separately from app.js (a classic script), so the two never
// interfere. Everything here is namespaced under `as-` in the DOM and CSS.
//
// buildEnvelope is injected rather than imported by the SDK itself: the SDK's own relative
// path to core only resolves inside the AutoSupport repo layout, not from this app's
// static directory. See loadBuildEnvelope() in the SDK.

import { buildEnvelope } from './autosupport/core/index.js';
import { init, report, getReplies } from './autosupport/sdk/index.js';

// Set this to your deployed Cloudflare Worker. Until it is, the UI stays visible but
// tells the user reporting is unavailable rather than failing with a network error.
const ENDPOINT = window.AUTOSUPPORT_ENDPOINT || '';
const APP_ID = 'mytranscribe';

const configured = Boolean(ENDPOINT);

if (configured) {
  init({
    endpoint: ENDPOINT,
    appId: APP_ID,
    appVersion: window.MYTRANSCRIBE_VERSION || '0.0.0',
    platform: 'web',
    buildEnvelope,
  });
}

// --- diagnostics ------------------------------------------------------------------

// Recent console errors, captured so a report carries something diagnostic without the
// user having to describe a stack trace. Bounded so a long session cannot grow unbounded,
// and redacted by core before it ever leaves the machine.
const recentErrors = [];
const MAX_ERRORS = 20;

function noteError(text) {
  recentErrors.push(`${new Date().toISOString()} ${text}`);
  if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
}

window.addEventListener('error', (e) => noteError(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => noteError(`unhandled rejection: ${e.reason}`));

async function collectContext() {
  const ctx = {
    route: location.pathname,
    device: { os: navigator.platform || 'unknown', screen: `${screen.width}x${screen.height}` },
  };
  if (recentErrors.length) ctx.stack = recentErrors.join('\n');
  return ctx;
}

// /api/info reports the active model, device and compute type -- far more than a user can
// describe, and exactly what most transcription bugs turn on. Best-effort: a failure here
// must never block filing a report.
async function collectServerLog() {
  try {
    const res = await fetch('/api/info', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return { type: 'server_log', redacted: false, inline: (await res.text()).slice(0, 4000) };
  } catch {
    return null;
  }
}

// --- ui ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.append(c);
  return node;
}

function openDialog() {
  const existing = document.getElementById('asDialog');
  if (existing) existing.remove();

  const kind = el('select', { class: 'as-input', id: 'asKind' }, [
    el('option', { value: 'bug' }, 'Something is broken'),
    el('option', { value: 'feature' }, 'I have a suggestion'),
    el('option', { value: 'support' }, 'I need help'),
  ]);
  const title = el('input', { class: 'as-input', id: 'asTitle', placeholder: 'One line: what happened?', maxlength: '200' });
  const body = el('textarea', { class: 'as-input as-textarea', id: 'asBody', placeholder: 'What were you doing? What did you expect?', maxlength: '5000' });
  const status = el('div', { class: 'as-status', id: 'asStatus' });

  const send = el('button', { class: 'as-btn as-btn-primary', id: 'asSend' }, 'Send report');
  const cancel = el('button', { class: 'as-btn', onclick: () => dialog.remove() }, 'Cancel');

  send.addEventListener('click', async () => {
    if (!title.value.trim()) {
      status.textContent = 'Please add a one-line summary.';
      return;
    }
    send.disabled = true;
    status.textContent = 'Sending…';
    try {
      const attachments = [];
      const serverLog = await collectServerLog();
      if (serverLog) attachments.push(serverLog);

      const result = await report({
        kind: kind.value,
        title: title.value.trim(),
        body: body.value.trim() || '(no additional detail)',
        context: await collectContext(),
        attachments,
      });
      status.textContent = result.deduped
        ? 'Thanks — this is already a known issue and we have added your report to it.'
        : 'Thanks. Your report was sent, and any reply will appear here in the app.';
      send.remove();
      cancel.textContent = 'Close';
    } catch (err) {
      // Deliberately not the raw error: it can carry endpoint detail the user cannot act on.
      status.textContent = 'Could not send the report. Please check your connection and try again.';
      send.disabled = false;
      console.error('[autosupport]', err);
    }
  });

  const dialog = el('div', { class: 'as-backdrop', id: 'asDialog', onclick: (e) => { if (e.target === dialog) dialog.remove(); } }, [
    el('div', { class: 'as-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report a problem' }, [
      el('h2', { class: 'as-title' }, 'Report a problem'),
      el('p', { class: 'as-note' }, 'Recent errors and a server health snapshot are attached. Personal details are removed automatically before anything is sent.'),
      kind, title, body, status,
      el('div', { class: 'as-actions' }, [cancel, send]),
    ]),
  ]);
  document.body.append(dialog);
  title.focus();
}

function showReplies(replies) {
  const panel = el('div', { class: 'as-backdrop', onclick: (e) => { if (e.target === panel) panel.remove(); } }, [
    el('div', { class: 'as-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Support replies' }, [
      el('h2', { class: 'as-title' }, replies.length > 1 ? 'Replies to your reports' : 'Reply to your report'),
      ...replies.map((r) => el('div', { class: 'as-reply' }, r.body)),
      el('div', { class: 'as-actions' }, [el('button', { class: 'as-btn as-btn-primary', onclick: () => panel.remove() }, 'Close')]),
    ]),
  ]);
  document.body.append(panel);
}

// --- wiring -----------------------------------------------------------------------

function mount() {
  const button = document.getElementById('btnReportProblem');
  if (!button) return;

  button.addEventListener('click', () => {
    if (!configured) {
      alert('Reporting is not configured yet: no AutoSupport endpoint is set for this build.');
      return;
    }
    openDialog();
  });

  // Poll once on load, and again when the window regains focus. Never on a timer: only a
  // user who has actually filed something has anything to fetch, and the SDK returns
  // immediately without a network call for everyone else.
  if (!configured) return;
  const check = async () => {
    try {
      const replies = await getReplies();
      if (replies.length) {
        showReplies(replies);
        document.getElementById('asReplyBadge')?.classList.add('as-visible');
      }
    } catch (err) {
      console.error('[autosupport] reply check failed', err);
    }
  };
  check();
  window.addEventListener('focus', check);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
