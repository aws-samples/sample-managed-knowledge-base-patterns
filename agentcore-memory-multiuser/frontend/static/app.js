const cfg = window.APP_CONFIG;
let idToken = sessionStorage.getItem('idToken');
let me = null, sessionId = null, sending = false;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const authHeaders = () => ({ 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' });

async function cognitoSignIn(username, password) {
  // USER_PASSWORD_AUTH against Cognito directly from the browser; production apps
  // typically use managed login or Amplify. Only the resulting ID token reaches our API.
  const r = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: cfg.clientId, AuthParameters: { USERNAME: username, PASSWORD: password } })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.__type || 'sign-in failed');
  return j.AuthenticationResult.IdToken;
}

async function loadMe() {
  const r = await fetch('/api/me', { headers: authHeaders() });
  if (r.status === 401) { signOut(); return; }
  if (!r.ok) { $('who').textContent = 'could not load your profile'; return; }
  me = await r.json();
  $('who').textContent = `${me.username} · ${me.email}`;
  $('kbs').innerHTML = `<b>${esc(me.knowledgeBase.name)}</b> <span class="hint">${esc(me.knowledgeBase.description)}</span>` +
    `<div class="hint gap-above">Document ACLs let you read: ${esc(me.readableFolders.join(', ') || 'nothing')}. ` +
    `The knowledge base enforces this from your email.</div>`;
  await Promise.all([loadConversations(), loadLtm()]);
}

async function loadConversations() {
  const r = await fetch('/api/conversations', { headers: authHeaders() });
  if (!r.ok) { $('convs').innerHTML = '<span class="hint">could not load conversations</span>'; return; }
  const list = await r.json();
  $('convs').innerHTML = list.map(c =>
    `<div class="conv ${c.sessionId===sessionId?'active':''}" data-id="${esc(c.sessionId)}">${esc(c.sessionId.slice(0,18))}… <span class="hint">${esc(c.createdAt.slice(0,16).replace('T',' '))}</span></div>`).join('') || '<span class="hint">none yet</span>';
  document.querySelectorAll('.conv').forEach(el => el.onclick = () => openConversation(el.dataset.id));
}

async function loadLtm() {
  const r = await fetch('/api/memory', { headers: authHeaders() });
  if (!r.ok) { $('ltm').innerHTML = '<span class="hint">could not load long-term memory</span>'; return; }
  const recs = await r.json();
  $('ltm').innerHTML = recs.length ? recs.map(x => `<div class="memrec"><span class="mono">${esc((x.namespaces||[]).join(' '))}</span>\n${esc((x.text||'').slice(0,400))}</div>`).join('')
    : '<span class="hint">no long-term records yet (extraction is asynchronous)</span>';
}

async function openConversation(id) {
  sessionId = id;
  $('sessionline').textContent = `Conversation ${id} — history restored from short-term memory by the service on each turn`;
  $('messages').innerHTML = '';
  const r = await fetch('/api/conversations/' + encodeURIComponent(id), { headers: authHeaders() });
  if (!r.ok) { addMsg('assistant', `Could not load this conversation (error ${r.status})`, true); return; }
  for (const t of await r.json()) addMsg(t.role, t.text, true);
  $('trace').innerHTML = ''; $('sources').innerHTML = '';
  await loadConversations();
}

function newConversation() {
  sessionId = null;
  $('sessionline').textContent = 'New conversation';
  $('messages').innerHTML = ''; $('trace').innerHTML = ''; $('sources').innerHTML = '';
  document.querySelectorAll('.conv').forEach(el => el.classList.remove('active'));
}

function addMsg(role, text, restored=false) {
  const d = document.createElement('div');
  d.className = `msg ${role} ${restored?'restored':''}`;
  d.textContent = text;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
  return d;
}

function traceRow(ev) {
  const tags = [];
  for (const s of ev.sources || []) tags.push(`<span class="tag ${s==='BedrockAgentCoreMemory'?'mem':'kb'}">${s==='BedrockAgentCoreMemory'?'memory':'knowledge base'}</span>`);
  if (ev.status === 'FAILED') tags.push(`<span class="tag fail">${esc(ev.failures.join('; '))}</span>`);
  let detail = '';
  for (const a of ev.actions || []) {
    if (a.type === 'memoryRetrieve') detail += `<div><span class="tag mem">memoryRetrieve</span> <span class="mono">${esc(a.query)}</span></div>`;
    else if (a.type === 'retrieve') detail += `<div><span class="tag kb">retrieve</span> <span class="mono">${esc(a.query)}</span></div>`;
    else detail += `<div><span class="tag kb">${esc(a.type)}</span></div>`;
  }
  if (ev.memory) detail += `<div class="mono">${esc(JSON.stringify(ev.memory))}</div>`;
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<div class="t">${esc(ev.t)} ms</div><div><b>${esc(ev.step)}</b> <span class="tag ${ev.status==='SUCCEEDED'?'ok':ev.status==='FAILED'?'fail':''}">${esc(ev.status)}</span> ${tags.join('')}${ev.items?` <span class="hint">${esc(ev.items)} item(s)</span>`:''}${detail}</div>`;
  $('trace').appendChild(d);
}

async function send() {
  if (sending) return;
  const question = $('q').value.trim();
  if (!question) return;
  sending = true; $('send').disabled = true; $('q').value = '';
  addMsg('user', question);
  const out = addMsg('assistant', '');
  $('trace').innerHTML = ''; $('sources').innerHTML = '';

  // The body carries only the question and the session to continue. Identity (memory
  // actorId and the email used for document ACLs) is derived by the backend from the token.
  const r = await fetch('/api/chat', { method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ question, sessionId }) });
  if (!r.ok) { out.textContent = `Error ${r.status}: ${await r.text()}`; sending=false; $('send').disabled=false; return; }

  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(frame)?.[1]; const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] || '{}');
      if (ev === 'session') { sessionId = data.sessionId; $('sessionline').textContent = `Conversation ${sessionId}`; }
      else if (ev === 'trace') traceRow(data);
      else if (ev === 'text') { out.textContent += data.text; $('messages').scrollTop = $('messages').scrollHeight; }
      else if (ev === 'result') {
        if (data.answer) out.textContent = data.answer;
        $('sources').innerHTML = data.sources.map(s => `<li><b>${esc(s.document||s.knowledgeBaseId)}</b> <span class="hint">${esc(s.preview)}</span></li>`).join('');
        const t = document.createElement('div'); t.className='hint'; t.textContent = `total ${data.totalMs} ms`; $('trace').appendChild(t);
      }
      else if (ev === 'error') out.textContent += `\n[error] ${data.message} (correlation id ${data.correlationId})`;
    }
  }
  sending = false; $('send').disabled = false;
  loadConversations();
}

function signOut() { sessionStorage.removeItem('idToken'); idToken = null; location.reload(); }

function showApp() { $('login').hidden = true; $('app').hidden = false; $('signout').hidden = false; }

$('signin').onclick = async () => {
  try {
    idToken = await cognitoSignIn($('u').value, $('p').value);
    sessionStorage.setItem('idToken', idToken);
    showApp();
    await loadMe();
  } catch (e) { $('loginmsg').textContent = e.message; }
};
$('signout').onclick = signOut;
$('send').onclick = send;
$('q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('newconv').onclick = newConversation;
$('refreshltm').onclick = loadLtm;

if (idToken) { showApp(); loadMe(); }
