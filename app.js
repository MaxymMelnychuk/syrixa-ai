
'use strict';

const messagesEl    = document.getElementById('messages');
const messageInput  = document.getElementById('messageInput');
const sendBtn       = document.getElementById('sendBtn');
const clearBtn      = document.getElementById('clearBtn');
const newChatBtn    = document.getElementById('newChatBtn');
const sidebar       = document.getElementById('sidebar');
const menuBtn       = document.getElementById('menuBtn');
const topbarStatus  = document.getElementById('topbarStatus');
const welcome       = document.getElementById('welcome');
const chatHistory   = document.getElementById('chatHistory');
const welcomeChips  = document.getElementById('welcomeChips');

const fileInput     = document.getElementById('fileInput');
const attachBtn     = document.getElementById('attachBtn');
const fileDisplay   = document.getElementById('fileDisplay');
const fileNameEl    = document.getElementById('fileName');
const removeFileBtn = document.getElementById('removeFileBtn');

let sessions       = [];
let activeSessionId = null;

let pendingDocumentId = null;
let pendingFileName   = null;

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function lightMarkdown(text) {
  let t = escapeHTML(text);
  
  t = t.replace(/```[\s\S]*?```/g, m => {
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

function createSession(title = 'New chat') {
  const id = Date.now().toString();
  const session = { id, title, messages: [] };
  sessions.unshift(session);
  return session;
}

function getActiveSession() {
  return sessions.find(s => s.id === activeSessionId) || null;
}

function setActiveSession(id) {
  activeSessionId = id;
  renderMessages();
  renderSidebar();
}

function renderSidebar() {
  
  const label = chatHistory.querySelector('.history-label');
  chatHistory.innerHTML = '';
  if (label) chatHistory.appendChild(label);

  sessions.forEach(session => {
    const btn = document.createElement('button');
    btn.className = 'history-item' + (session.id === activeSessionId ? ' active' : '');
    btn.innerHTML = `<span class="history-dot"></span><span>${escapeHTML(session.title)}</span>`;
    btn.addEventListener('click', () => setActiveSession(session.id));
    chatHistory.appendChild(btn);
  });
}

function renderMessages() {
  const session = getActiveSession();

  const existingMessages = messagesEl.querySelectorAll('.message');
  existingMessages.forEach(m => m.remove());

  if (!session || session.messages.length === 0) {
    welcome.style.display = 'flex';
    return;
  }

  welcome.style.display = 'none';

  session.messages.forEach(msg => {
    appendMessageDOM(msg.role, msg.content, msg.time, false, msg.attachmentName);
  });

  scrollToBottom();
}

function appendMessageDOM(role, content, time, animate = true, attachmentName = null) {
  welcome.style.display = 'none';

  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (!animate) div.style.animation = 'none';

  const avatarLetter = role === 'user' ? 'U' : '◈';
  const attachmentHTML = role === 'user' && attachmentName
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

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

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
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function setStatus(state) {
  if (!topbarStatus) return;
  if (state === 'thinking') {
    topbarStatus.textContent = '● Thinking…';
    topbarStatus.className   = 'topbar-status thinking';
  } else {
    topbarStatus.textContent = '● Online';
    topbarStatus.className   = 'topbar-status';
  }
}

let toastEl = null;
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

let isBusy = false;

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
      .filter(m => m.role !== 'typing')
      .map(m => ({
        role:    m.role === 'bot' ? 'assistant' : m.role,
        content: m.content,
      }));

    const payload = { messages: apiMessages };
    if (session.documentId) {
      payload.documentId = session.documentId;
    }

    const response = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    const botTime = now();
    const reply   = data.reply || '…';

    hideTyping();
    setStatus('online');

    session.messages.push({ role: 'bot', content: reply, time: botTime });
    appendMessageDOM('bot', reply, botTime);

  } catch (err) {
    hideTyping();
    setStatus('online');
    console.error('[Chat error]', err);
    showToast('⚠ ' + err.message);
  } finally {
    isBusy = false;
    updateSendBtn();
  }
}

function autoResize() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
}

function updateSendBtn() {
  sendBtn.disabled = !messageInput.value.trim() || isBusy;
}

messageInput.addEventListener('input', () => {
  autoResize();
  updateSendBtn();
});

messageInput.addEventListener('keydown', e => {
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
  welcomeChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) sendMessage(chip.dataset.msg);
  });
}

menuBtn.addEventListener('click', () => {
  sidebar.classList.toggle('hidden');
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
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');

    pendingDocumentId = data.documentId;
    pendingFileName = file.name;
    
    fileNameEl.textContent = pendingFileName;
    removeFileBtn.style.display = 'flex';
  } catch (err) {
    console.error(err);
    showToast('Upload failed: ' + err.message);
    clearPendingFile();
  } finally {
    isBusy = false;
    updateSendBtn();
    fileInput.value = ''; 
  }
});

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
  messageInput.focus();
})();
