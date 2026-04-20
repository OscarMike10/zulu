/* ── Markdown renderer ──────────────────────────────────── */
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text, targetEl) {
  const html = marked.parse(text || '');
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p','br','b','i','em','strong','s','del','a','code','pre',
      'h1','h2','h3','h4','h5','h6','ul','ol','li',
      'blockquote','hr','table','thead','tbody','tr','th','td',
      'span','div','details','summary',
    ],
    ALLOWED_ATTR: ['class','href','target'],
    FORCE_BODY: true,
  });

  targetEl.innerHTML = clean;

  // Syntax-highlight code blocks and add copy buttons
  targetEl.querySelectorAll('pre code').forEach((block) => {
    const langClass = Array.from(block.classList).find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : '';

    hljs.highlightElement(block);

    const pre = block.parentNode;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';

    const header = document.createElement('div');
    header.className = 'code-header';

    const langLabel = document.createElement('span');
    langLabel.className = 'code-lang';
    langLabel.textContent = lang || 'text';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(block.textContent).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 2000);
      });
    });

    header.appendChild(langLabel);
    header.appendChild(copyBtn);
    wrapper.appendChild(header);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
  });
}

/* ── ChatApp ─────────────────────────────────────────────── */
class ChatApp {
  constructor() {
    this.history = []; // Anthropic messages array
    this.isStreaming = false;
    this.serverHasKey = false;
    this.settings = {
      apiKey: '',
      model: 'claude-opus-4-7',
      system: 'You are a helpful AI assistant.',
      theme: 'dark',
      showThinking: false,
    };
  }

  /* ── Init ──────────────────────────────────────────────── */
  async init() {
    this.loadSettings();
    this.applyTheme(this.settings.theme);
    this.bindEvents();
    await this.checkServerStatus();
    document.getElementById('model-select').value = this.settings.model;
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem('cc-settings');
      if (raw) this.settings = { ...this.settings, ...JSON.parse(raw) };
    } catch {}
  }

  saveSettings() {
    localStorage.setItem('cc-settings', JSON.stringify(this.settings));
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  /* ── Events ────────────────────────────────────────────── */
  bindEvents() {
    const input = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      sendBtn.disabled = !input.value.trim() || this.isStreaming;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) this.send();
      }
    });

    sendBtn.addEventListener('click', () => this.send());

    document.getElementById('clear-btn').addEventListener('click', () => {
      if (!this.isStreaming) this.clearConversation();
    });

    document.getElementById('settings-btn').addEventListener('click', () => this.openSettings());
    document.getElementById('model-select').addEventListener('change', (e) => {
      this.settings.model = e.target.value;
      this.saveSettings();
    });

    // Settings modal
    document.getElementById('close-settings').addEventListener('click', () => this.closeSettings());
    document.getElementById('cancel-settings').addEventListener('click', () => this.closeSettings());
    document.getElementById('save-settings').addEventListener('click', () => this.handleSaveSettings());
    document.getElementById('modal-backdrop').addEventListener('click', () => this.closeSettings());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeSettings(); });

    // API key visibility
    document.getElementById('toggle-key-vis').addEventListener('click', () => {
      const inp = document.getElementById('api-key-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    // Theme buttons in settings
    document.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.theme-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.getElementById('add-key-btn')?.addEventListener('click', () => this.openSettings());
  }

  async checkServerStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.serverHasKey = data.serverKeyConfigured;
      if (!this.serverHasKey && !this.settings.apiKey) {
        document.getElementById('no-key-warning').classList.remove('hidden');
      }
    } catch {}
  }

  /* ── Send ──────────────────────────────────────────────── */
  send() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || this.isStreaming) return;

    input.value = '';
    input.style.height = 'auto';
    document.getElementById('send-btn').disabled = true;

    this.streamResponse(text);
  }

  /* ── Streaming ─────────────────────────────────────────── */
  async streamResponse(userText) {
    this.isStreaming = true;

    // Hide welcome screen on first message
    document.getElementById('welcome')?.remove();

    // Add to history and render user bubble
    this.history.push({ role: 'user', content: userText });
    this.addUserBubble(userText);

    const bubble = this.createAssistantBubble();
    const streamingEl = bubble.querySelector('.message-streaming');

    let fullText = '';
    let thinkingText = '';
    let thinkingEl = null;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this.history,
          model: this.settings.model,
          system: this.settings.system || 'You are a helpful AI assistant.',
          apiKey: this.settings.apiKey,
          showThinking: this.settings.showThinking,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          let payload;
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }

          if (payload.type === 'text') {
            fullText += payload.text;
            streamingEl.textContent = fullText;
            this.scrollToBottom();

          } else if (payload.type === 'thinking') {
            thinkingText += payload.text;
            if (!thinkingEl) thinkingEl = this.createThinkingBlock(bubble);
            thinkingEl.querySelector('.thinking-content').textContent = thinkingText;

          } else if (payload.type === 'done') {
            this.finalizeAssistant(bubble, fullText, thinkingText, thinkingEl, payload.usage);
            this.history.push({ role: 'assistant', content: fullText });

          } else if (payload.type === 'error') {
            throw new Error(payload.error);
          }
        }
      }
    } catch (err) {
      this.showMessageError(bubble, err.message || 'Something went wrong.');
      // Remove the partial entry from history if the request failed mid-way
      if (this.history[this.history.length - 1]?.role === 'user') {
        // keep user message so user can see what they sent
      }
    } finally {
      this.isStreaming = false;
      const sendBtn = document.getElementById('send-btn');
      const input = document.getElementById('message-input');
      sendBtn.disabled = !input.value.trim();
    }
  }

  /* ── UI helpers ─────────────────────────────────────────── */
  addUserBubble(text) {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message user-message';

    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    div.innerHTML = `<div class="message-content user-content">${escaped}</div>`;
    messages.appendChild(div);
    this.scrollToBottom();
  }

  createAssistantBubble() {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message assistant-message';
    div.innerHTML = `
      <div class="message-avatar"><span class="avatar-icon">◆</span></div>
      <div class="message-body">
        <div class="message-streaming typing-cursor"></div>
      </div>`;
    messages.appendChild(div);
    this.scrollToBottom();
    return div;
  }

  createThinkingBlock(bubble) {
    const body = bubble.querySelector('.message-body');
    const details = document.createElement('details');
    details.className = 'thinking-block';
    details.open = true;
    details.innerHTML = `
      <summary class="thinking-summary">
        <span class="thinking-icon">🧠</span> Thinking…
      </summary>
      <div class="thinking-content"></div>`;
    body.insertBefore(details, body.firstChild);
    return details;
  }

  finalizeAssistant(bubble, fullText, thinkingText, thinkingEl, usage) {
    const body = bubble.querySelector('.message-body');
    const streamingEl = body.querySelector('.message-streaming');

    // Render main response as markdown
    const contentEl = document.createElement('div');
    contentEl.className = 'markdown-body';
    renderMarkdown(fullText, contentEl);
    if (streamingEl) streamingEl.replaceWith(contentEl);

    // Finalize thinking block
    if (thinkingEl) {
      thinkingEl.open = false;
      thinkingEl.querySelector('.thinking-summary').innerHTML =
        '<span class="thinking-icon">🧠</span> Reasoning';
      const tc = thinkingEl.querySelector('.thinking-content');
      renderMarkdown(thinkingText, tc);
    }

    // Footer with token stats and copy button
    if (usage) {
      const footer = document.createElement('div');
      footer.className = 'message-footer';

      const total = (usage.inputTokens || 0) + (usage.cacheRead || 0);
      const cacheNote = usage.cacheRead > 0 ? ` (${usage.cacheRead} cached)` : '';

      const stat = document.createElement('span');
      stat.className = 'usage-stat';
      stat.textContent = `${total} in${cacheNote} · ${usage.outputTokens} out`;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-msg-btn';
      copyBtn.title = 'Copy message';
      copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(fullText).then(() => {
          copyBtn.style.color = 'var(--success)';
          setTimeout(() => (copyBtn.style.color = ''), 2000);
        });
      });

      footer.appendChild(stat);
      footer.appendChild(copyBtn);
      body.appendChild(footer);
    }

    this.scrollToBottom();
  }

  showMessageError(bubble, message) {
    const body = bubble.querySelector('.message-body');
    const streamingEl = body.querySelector('.message-streaming');
    const errEl = document.createElement('div');
    errEl.className = 'message-error';
    errEl.innerHTML = `<span class="error-icon">⚠</span><span>${message}</span>`;
    if (streamingEl) streamingEl.replaceWith(errEl);
    else body.appendChild(errEl);
    this.scrollToBottom();
  }

  clearConversation() {
    this.history = [];
    document.getElementById('messages').innerHTML = `
      <div class="welcome" id="welcome">
        <div class="welcome-icon">◆</div>
        <h1>Claude Chat</h1>
        <p>Start a conversation with Claude AI.</p>
        <div class="welcome-hints">
          <div class="hint">Ask me anything</div>
          <div class="hint">Write &amp; debug code</div>
          <div class="hint">Summarize &amp; analyze</div>
        </div>
      </div>`;
  }

  scrollToBottom() {
    const main = document.getElementById('chat-main');
    main.scrollTop = main.scrollHeight;
  }

  /* ── Settings modal ─────────────────────────────────────── */
  openSettings() {
    document.getElementById('api-key-input').value = this.settings.apiKey;
    document.getElementById('system-prompt-input').value = this.settings.system;
    document.getElementById('show-thinking-toggle').checked = this.settings.showThinking;

    const keyStatus = document.getElementById('key-status');
    if (this.settings.apiKey) {
      keyStatus.textContent = 'Set';
      keyStatus.className = 'setting-badge badge-success';
    } else if (this.serverHasKey) {
      keyStatus.textContent = 'Server key';
      keyStatus.className = 'setting-badge badge-success';
    } else {
      keyStatus.textContent = 'Not set';
      keyStatus.className = 'setting-badge badge-warning';
    }

    document.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === this.settings.theme);
    });

    const modal = document.getElementById('settings-modal');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('visible'));
    document.getElementById('api-key-input').focus();
  }

  closeSettings() {
    const modal = document.getElementById('settings-modal');
    modal.classList.remove('visible');
    setTimeout(() => modal.classList.add('hidden'), 200);
  }

  handleSaveSettings() {
    const apiKey = document.getElementById('api-key-input').value.trim();
    const system = document.getElementById('system-prompt-input').value.trim();
    const showThinking = document.getElementById('show-thinking-toggle').checked;
    const activeTheme = document.querySelector('.theme-btn.active')?.dataset.theme || 'dark';

    this.settings = {
      ...this.settings,
      apiKey,
      system: system || 'You are a helpful AI assistant.',
      showThinking,
      theme: activeTheme,
    };

    this.saveSettings();
    this.applyTheme(activeTheme);

    const warning = document.getElementById('no-key-warning');
    if (apiKey || this.serverHasKey) warning.classList.add('hidden');
    else warning.classList.remove('hidden');

    this.closeSettings();
  }
}

/* ── Boot ────────────────────────────────────────────────── */
const chat = new ChatApp();
chat.init();
