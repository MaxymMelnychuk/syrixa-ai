'use strict';

/**
 * Syrixa browser client — vanilla JS.
 *
 * Handles chat UI, session list, file upload, and talking to the same-origin API (or a
 * backend URL from `?apiBase=` / localStorage). No build step: this file runs as-is.
 */

/** Milliseconds before we abort chat/upload requests so a hung network does not freeze the UI forever. */
const FETCH_TIMEOUT_MS = 90_000;

// --- DOM roots: everything the script touches in index.html ---
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const newChatBtn = document.getElementById('newChatBtn');
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');
const topbarStatus = document.getElementById('topbarStatus');
const welcome = document.getElementById('welcome');
const chatHistory = document.getElementById('chatHistory');
const welcomeChips = document.getElementById('welcomeChips');

const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const fileDisplay = document.getElementById('fileDisplay');
const fileNameEl = document.getElementById('fileName');
const removeFileBtn = document.getElementById('removeFileBtn');

/** Each session is a sidebar entry with its own message list and optional RAG document id. */
let sessions = [];
let activeSessionId = null;

/** After upload succeeds we hold the server-generated id until the user sends a message. */
let pendingDocumentId = null;
let pendingFileName = null;

/**
 * Figures out which API host to call. Query param wins (and is saved), then localStorage,
 * then an optional global injected before this script. Empty string means same origin.
 *
 * @returns {string} Base URL without trailing slash
 */
function getApiBaseUrl() {
  const queryValue = new URLSearchParams(window.location.search).get('apiBase');
  if (queryValue) {
    const cleaned = queryValue.replace(/\/+$/, '');
    localStorage.setItem('syrixa_api_base', cleaned);
    return cleaned;
  }
  const fromStorage = localStorage.getItem('syrixa_api_base');
  if (fromStorage) return fromStorage.replace(/\/+$/, '');
  if (typeof window.SYRIXA_API_BASE_URL === 'string' && window.SYRIXA_API_BASE_URL.trim()) {
    return window.SYRIXA_API_BASE_URL.trim().replace(/\/+$/, '');
  }
  return '';
}

const API_BASE_URL = getApiBaseUrl();

/**
 * Builds an absolute API path. Leading slash on `path` is normalized.
 *
 * @param {string} path
 * @returns {string}
 */
function apiUrl(path) {
  if (!path.startsWith('/')) path = '/' + path;
  return `${API_BASE_URL}${path}`;
}

/**
 * Short time label shown under each bubble (local clock, user-friendly).
 *
 * @returns {string}
 */
function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Escapes text so we can safely inject user content into `innerHTML` for user bubbles.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Tiny markdown subset for assistant replies: code fences, inline code, bold/italic, newlines.
 * Input is escaped first so markdown cannot inject raw HTML from the model.
 *
 * @param {string} text
 * @returns {string} HTML fragment
 */
function lightMarkdown(text) {
  let t = escapeHTML(text);

  t = t.replace(/```[\s\S]*?```/g, (m) => {
    const inner = m.slice(3, -3).trim();
    return `<pre><code>${inner}</code></pre>`;
  });

  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');

  t = t.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');

  t = t.replace(/\n/g, '<br>');
  return t;
}

/**
 * Creates a new chat session and prepends it to the sidebar order.
 *
 * @param {string} [title]
 * @returns {{ id: string, title: string, messages: object[] }}
 */
function createSession(title = 'New chat') {
  const id = Date.now().toString();
  const session = { id, title, messages: [] };
  sessions.unshift(session);
  return session;
}

/**
 * @returns {{ id: string, title: string, messages: object[], documentId?: string } | null}
 */
function getActiveSession() {
  return sessions.find((s) => s.id === activeSessionId) || null;
}

/**
 * Switches the visible thread and redraws messages + sidebar highlight.
 *
 * @param {string} id
 */
function setActiveSession(id) {
  activeSessionId = id;
  renderMessages();
  renderSidebar();
}

/**
 * Rebuilds the "Recent" list from `sessions`. Preserves the section label if present.
 */
function renderSidebar() {
  const label = chatHistory.querySelector('.history-label');
  chatHistory.innerHTML = '';
  if (label) chatHistory.appendChild(label);

  sessions.forEach((session) => {
    const btn = document.createElement('button');
    btn.className = 'history-item' + (session.id === activeSessionId ? ' active' : '');
    btn.innerHTML = `<span class="history-dot"></span><span>${escapeHTML(session.title)}</span>`;
    btn.addEventListener('click', () => setActiveSession(session.id));
    chatHistory.appendChild(btn);
  });
}

/**
 * Either shows the empty state or replays all messages for the active session (no animation on load).
 */
function renderMessages() {
  const session = getActiveSession();

  const existingMessages = messagesEl.querySelectorAll('.message');
  existingMessages.forEach((m) => m.remove());

  if (!session || session.messages.length === 0) {
    welcome.style.display = 'flex';
    return;
  }

  welcome.style.display = 'none';

  session.messages.forEach((msg) => {
    appendMessageDOM(msg.role, msg.content, msg.time, false, msg.attachmentName);
  });

  scrollToBottom();
}

/**
 * Appends one bubble to the transcript. Assistant content may use light markdown; user does not.
 *
 * @param {'user'|'bot'|'assistant'} role
 * @param {string} content
 * @param {string} time
 * @param {boolean} [animate]
 * @param {string|null} [attachmentName]
 * @returns {HTMLDivElement}
 */
function appendMessageDOM(role, content, time, animate = true, attachmentName = null) {
  welcome.style.display = 'none';

  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (!animate) div.style.animation = 'none';

  const avatarLetter = role === 'user' ? 'U' : '◈';
  const attachmentHTML =
    role === 'user' && attachmentName
      ? `<div class="message-attachment"><span class="message-attachment-icon">📄</span><span class="message-attachment-name">${escapeHTML(attachmentName)}</span></div>`
      : '';
  div.innerHTML = `
    <div class="avatar">${avatarLetter}</div>
    <div>
      ${attachmentHTML}
      <div class="bubble">${role === 'bot' || role === 'assistant' ? lightMarkdown(content) : escapeHTML(content)}</div>
      <p class="msg-time">${time}</p>
    </div>`;

  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

/** Keeps the newest message in view as the thread grows. */
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Singleton typing indicator row (bot role, three dots). */
let typingEl = null;

function showTyping() {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'message bot';
  typingEl.innerHTML = `
    <div class="avatar">◈</div>
    <div>
      <div class="bubble typing-bubble">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>`;
  messagesEl.appendChild(typingEl);
  scrollToBottom();
}

function hideTyping() {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

/**
 * Updates the small status line in the top bar when the model is working.
 *
 * @param {'thinking'|'online'} state
 */
function setStatus(state) {
  if (!topbarStatus) return;
  if (state === 'thinking') {
    topbarStatus.textContent = '● Thinking…';
    topbarStatus.className = 'topbar-status thinking';
  } else {
    topbarStatus.textContent = '● Online';
    topbarStatus.className = 'topbar-status';
  }
}

/** Ephemeral error / info strip at the bottom of the viewport. */
let toastEl = null;

/**
 * @param {string} msg
 */
function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

/** True while a request is in flight — blocks double-send and disables the send button appropriately. */
let isBusy = false;

/**
 * Reads `fetch` response as text, then JSON, with clear errors for 404 and non-JSON HTML error pages.
 *
 * @param {Response} response
 * @returns {Promise<object>}
 */
async function parseJsonResponseSafe(response) {
  const raw = await response.text();
  if (!raw) return {};
  if (response.status === 404) {
    throw new Error(
      `HTTP 404: API route not found (${response.url}). ` +
        `If your frontend and backend are on different hosts, set ?apiBase=https://your-backend-domain`
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    const statusText = response.status ? `HTTP ${response.status}` : 'HTTP error';
    throw new Error(`${statusText}: Expected JSON response, got: ${preview}`);
  }
}

/**
 * Returns an AbortSignal that times out in environments that support `AbortSignal.timeout`.
 *
 * @returns {AbortSignal|undefined}
 */
function fetchTimeoutSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }
  return undefined;
}

/**
 * Sends the current input as a user message, calls `/api/chat`, appends the assistant reply.
 *
 * @param {string} text
 */
async function sendMessage(text) {
  text = text.trim();
  if (!text || isBusy) return;

  if (!activeSessionId) {
    const sess = createSession(text.slice(0, 40));
    activeSessionId = sess.id;
    renderSidebar();
  }

  const session = getActiveSession();
  if (!session) return;

  if (session.messages.length === 0) {
    session.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
    renderSidebar();
  }

  let attachmentNameForMessage = null;
  if (pendingDocumentId) {
    session.documentId = pendingDocumentId;
    attachmentNameForMessage = pendingFileName;
    clearPendingFile();
  }

  isBusy = true;
  sendBtn.disabled = true;
  messageInput.value = '';
  autoResize();

  const userTime = now();
  session.messages.push({ role: 'user', content: text, time: userTime, attachmentName: attachmentNameForMessage });
  appendMessageDOM('user', text, userTime, true, attachmentNameForMessage);

  showTyping();
  setStatus('thinking');

  try {
    const apiMessages = session.messages
      .filter((m) => m.role !== 'typing')
      .map((m) => ({
        role: m.role === 'bot' ? 'assistant' : m.role,
        content: m.content,
      }));

    const payload = { messages: apiMessages };
    if (session.documentId) {
      payload.documentId = session.documentId;
    }

    const response = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: fetchTimeoutSignal(),
    });

    const data = await parseJsonResponseSafe(response);

    if (!response.ok || data.error) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    const botTime = now();
    const reply = data.reply || '…';

    hideTyping();
    setStatus('online');

    session.messages.push({ role: 'bot', content: reply, time: botTime });
    appendMessageDOM('bot', reply, botTime);
  } catch (err) {
    hideTyping();
    setStatus('online');
    console.error('[Chat error]', err);
    const msg = err.name === 'TimeoutError' ? 'Request timed out. Try again.' : err.message;
    showToast('⚠ ' + msg);
  } finally {
    isBusy = false;
    updateSendBtn();
  }
}

/** Textarea grows with content up to a max height so long drafts stay usable. */
function autoResize() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
}

/** Send is only enabled when there is non-empty text and we are not mid-request. */
function updateSendBtn() {
  sendBtn.disabled = !messageInput.value.trim() || isBusy;
}

messageInput.addEventListener('input', () => {
  autoResize();
  updateSendBtn();
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage(messageInput.value);
  }
});

sendBtn.addEventListener('click', () => sendMessage(messageInput.value));

clearBtn.addEventListener('click', () => {
  const session = getActiveSession();
  if (session) {
    session.messages = [];
    renderMessages();
  }
});

newChatBtn.addEventListener('click', () => {
  const sess = createSession('New chat');
  activeSessionId = sess.id;
  renderMessages();
  renderSidebar();
  messageInput.focus();
});

if (welcomeChips) {
  welcomeChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) sendMessage(chip.dataset.msg);
  });
}

menuBtn.addEventListener('click', () => {
  sidebar.classList.toggle('hidden');
  menuBtn.setAttribute('aria-expanded', String(!sidebar.classList.contains('hidden')));
});

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  fileDisplay.style.display = 'flex';
  fileNameEl.textContent = 'Uploading...';
  removeFileBtn.style.display = 'none';
  sendBtn.disabled = true;
  isBusy = true;

  const formData = new FormData();
  formData.append('document', file);

  try {
    const res = await fetch(apiUrl('/api/upload'), {
      method: 'POST',
      body: formData,
      signal: fetchTimeoutSignal(),
    });
    const data = await parseJsonResponseSafe(res);
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');

    pendingDocumentId = data.documentId;
    pendingFileName = file.name;

    fileNameEl.textContent = pendingFileName;
    removeFileBtn.style.display = 'flex';
  } catch (err) {
    console.error(err);
    const msg = err.name === 'TimeoutError' ? 'Upload timed out. Try again.' : err.message;
    showToast('Upload failed: ' + msg);
    clearPendingFile();
  } finally {
    isBusy = false;
    updateSendBtn();
    fileInput.value = '';
  }
});

/** Clears staged upload UI state; does not remove messages already sent with a document. */
function clearPendingFile() {
  pendingDocumentId = null;
  pendingFileName = null;
  fileDisplay.style.display = 'none';
}

removeFileBtn.addEventListener('click', clearPendingFile);

(function init() {
  const sess = createSession('New chat');
  activeSessionId = sess.id;
  renderMessages();
  renderSidebar();
  menuBtn.setAttribute('aria-expanded', String(!sidebar.classList.contains('hidden')));
  messageInput.focus();
})();
