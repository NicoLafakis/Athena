// Athena Chat UI — Vanilla JS renderer (no build step needed)
(function () {
  const root = document.getElementById('root');

  // ---- State ----
  let messages = [];       // { role, content, id }
  let toolCalls = {};      // { toolId: { name, input, result, status } }
  let isThinking = false;
  let hasApiKey = true;
  let confirmationData = null;
  let expandedTools = {};  // { toolId: boolean }
  let streamingText = '';

  // ---- Helpers ----
  function genId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len = 500) {
    if (!str || str.length <= len) return str;
    return str.slice(0, len) + '...';
  }

  function formatToolResult(result) {
    if (typeof result === 'string') return result;
    if (result?.cancelled) return 'Cancelled by user';
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  // ---- Rendering ----
  function render() {
    root.innerHTML = '';

    const app = el('div', { className: 'app' });

    // Header
    const header = el('div', { className: 'header' });
    header.appendChild(el('div', { className: 'header-title', textContent: 'Athena' }));
    const actions = el('div', { className: 'header-actions' });
    const clearBtn = el('button', {
      className: 'btn-clear',
      textContent: 'Clear Chat',
      onclick: clearChat,
    });
    actions.appendChild(clearBtn);
    header.appendChild(actions);
    app.appendChild(header);

    // API Key Banner
    if (!hasApiKey) {
      const banner = el('div', { className: 'api-banner' });
      banner.innerHTML =
        'API key not configured. Add your key to <code>.env</code> as <code>ANTHROPIC_API_KEY=sk-...</code> and restart.';
      app.appendChild(banner);
    }

    // Messages
    const messagesDiv = el('div', { className: 'messages', id: 'messages-container' });

    if (messages.length === 0 && !isThinking) {
      const welcome = el('div', { className: 'welcome' });
      welcome.appendChild(el('h2', { textContent: 'Athena' }));
      welcome.appendChild(
        el('p', {
          textContent:
            'Your AI-powered desktop assistant. I can control your computer, manage files, run commands, and more. Just ask.',
        }),
      );
      messagesDiv.appendChild(welcome);
    } else {
      // Render messages and tool cards
      for (const msg of messages) {
        if (msg.role === 'user' && typeof msg.content === 'string') {
          const msgDiv = el('div', { className: 'message message-user' });
          const bubble = el('div', {
            className: 'bubble bubble-user',
            textContent: msg.content,
          });
          msgDiv.appendChild(bubble);
          messagesDiv.appendChild(msgDiv);
        } else if (msg.role === 'assistant') {
          // Could have text and tool_use blocks
          if (typeof msg.content === 'string' && msg.content) {
            const msgDiv = el('div', { className: 'message message-assistant' });
            const bubble = el('div', { className: 'bubble bubble-assistant' });
            bubble.textContent = msg.content;
            msgDiv.appendChild(bubble);
            messagesDiv.appendChild(msgDiv);
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                const msgDiv = el('div', { className: 'message message-assistant' });
                const bubble = el('div', { className: 'bubble bubble-assistant' });
                bubble.textContent = block.text;
                msgDiv.appendChild(bubble);
                messagesDiv.appendChild(msgDiv);
              } else if (block.type === 'tool_use') {
                messagesDiv.appendChild(renderToolCard(block.id, block.name, block.input));
              }
            }
          }
        } else if (msg.role === 'tool_results') {
          // Tool result messages rendered inline via toolCalls state
        }
      }

      // Show streaming text
      if (isThinking && streamingText) {
        const msgDiv = el('div', { className: 'message message-assistant' });
        const bubble = el('div', { className: 'bubble bubble-assistant' });
        bubble.textContent = streamingText;
        msgDiv.appendChild(bubble);
        messagesDiv.appendChild(msgDiv);
      }

      // Thinking indicator
      if (isThinking && !streamingText) {
        const thinking = el('div', { className: 'thinking' });
        thinking.textContent = 'Thinking';
        const dots = el('div', { className: 'thinking-dots' });
        dots.appendChild(el('span'));
        dots.appendChild(el('span'));
        dots.appendChild(el('span'));
        thinking.appendChild(dots);
        messagesDiv.appendChild(thinking);
      }
    }

    app.appendChild(messagesDiv);

    // Input area
    const inputArea = el('div', { className: 'input-area' });
    const inputWrapper = el('div', { className: 'input-wrapper' });

    const textarea = el('textarea', {
      id: 'message-input',
      rows: 1,
      placeholder: 'Message Athena...',
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });

    const sendBtn = el('button', { className: 'btn-send', id: 'send-btn' });
    sendBtn.disabled = isThinking;
    sendBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
    sendBtn.addEventListener('click', sendMessage);

    inputWrapper.appendChild(textarea);
    inputWrapper.appendChild(sendBtn);
    inputArea.appendChild(inputWrapper);
    app.appendChild(inputArea);

    root.appendChild(app);

    // Confirmation modal
    if (confirmationData) {
      root.appendChild(renderConfirmationModal());
    }

    // Scroll to bottom
    requestAnimationFrame(() => {
      const container = document.getElementById('messages-container');
      if (container) container.scrollTop = container.scrollHeight;
      // Focus input
      const input = document.getElementById('message-input');
      if (input && !confirmationData) input.focus();
    });
  }

  function renderToolCard(toolId, toolName, toolInput) {
    const tc = toolCalls[toolId] || { name: toolName, input: toolInput, status: 'running' };
    const isOpen = expandedTools[toolId] || false;

    const card = el('div', { className: 'tool-card' });

    const header = el('div', { className: 'tool-header' });
    header.addEventListener('click', () => {
      expandedTools[toolId] = !expandedTools[toolId];
      render();
    });

    const nameSpan = el('span', { className: 'tool-name', textContent: tc.name || toolName });
    const statusClass = tc.status || 'running';
    const statusText =
      statusClass === 'running'
        ? 'Running...'
        : statusClass === 'completed'
          ? 'Completed'
          : statusClass === 'error'
            ? 'Error'
            : 'Cancelled';
    const statusSpan = el('span', {
      className: `tool-status ${statusClass}`,
      textContent: statusText,
    });

    const chevron = el('span', { className: `chevron ${isOpen ? 'open' : ''}`, textContent: '\u25B6' });

    header.appendChild(chevron);
    header.appendChild(nameSpan);
    header.appendChild(statusSpan);
    card.appendChild(header);

    const body = el('div', { className: `tool-body ${isOpen ? 'open' : ''}` });

    // Params
    const paramsSection = el('div', { className: 'tool-params' });
    paramsSection.appendChild(el('div', { className: 'tool-label', textContent: 'Parameters' }));
    const paramsCode = el('div', { className: 'code-block' });
    paramsCode.textContent = truncate(JSON.stringify(toolInput || tc.input, null, 2), 1000);
    paramsSection.appendChild(paramsCode);
    body.appendChild(paramsSection);

    // Result
    if (tc.result !== undefined) {
      const resultSection = el('div', { className: 'tool-result' });
      resultSection.appendChild(el('div', { className: 'tool-label', textContent: 'Result' }));
      const resultCode = el('div', { className: 'code-block' });
      resultCode.textContent = truncate(formatToolResult(tc.result), 1000);
      resultSection.appendChild(resultCode);
      body.appendChild(resultSection);
    }

    card.appendChild(body);
    return card;
  }

  function renderConfirmationModal() {
    const overlay = el('div', { className: 'modal-overlay' });
    const modal = el('div', { className: 'modal' });

    modal.appendChild(el('h3', { textContent: 'Confirmation Required' }));
    modal.appendChild(
      el('div', { className: 'modal-tool', textContent: confirmationData.toolName }),
    );
    const msgDiv = el('div', { className: 'modal-message' });
    msgDiv.textContent = confirmationData.message;
    modal.appendChild(msgDiv);

    // Params
    const paramsCode = el('div', { className: 'code-block' });
    paramsCode.textContent = JSON.stringify(confirmationData.toolInput, null, 2);
    paramsCode.style.marginBottom = '20px';
    modal.appendChild(paramsCode);

    const actions = el('div', { className: 'modal-actions' });
    const cancelBtn = el('button', {
      className: 'btn-cancel',
      textContent: 'Cancel',
      onclick: () => {
        window.athena.sendConfirmationResponse(false);
        confirmationData = null;
        render();
      },
    });
    const confirmBtn = el('button', {
      className: 'btn-confirm',
      textContent: 'Confirm',
      onclick: () => {
        window.athena.sendConfirmationResponse(true);
        confirmationData = null;
        render();
      },
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  function el(tag, props = {}) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className') element.className = value;
      else if (key === 'textContent') element.textContent = value;
      else if (key === 'innerHTML') element.innerHTML = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
      else element.setAttribute(key, value);
    }
    return element;
  }

  // ---- Actions ----
  async function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input?.value?.trim();
    if (!text || isThinking) return;

    messages.push({ role: 'user', content: text, id: genId() });
    isThinking = true;
    streamingText = '';
    render();

    try {
      const result = await window.athena.sendMessage(text);
      if (result?.error) {
        messages.push({
          role: 'assistant',
          content: `Error: ${result.error}`,
          id: genId(),
        });
      }
    } catch (err) {
      messages.push({
        role: 'assistant',
        content: `Error: ${err.message}`,
        id: genId(),
      });
    }

    isThinking = false;
    streamingText = '';

    // Refresh from history
    await refreshFromHistory();
    render();
  }

  async function clearChat() {
    await window.athena.clearHistory();
    messages = [];
    toolCalls = {};
    expandedTools = {};
    streamingText = '';
    render();
  }

  async function refreshFromHistory() {
    try {
      const history = await window.athena.getHistory();
      rebuildFromHistory(history);
    } catch {
      // Ignore
    }
  }

  function rebuildFromHistory(history) {
    messages = [];
    toolCalls = {};

    for (const msg of history) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content, id: genId() });
        }
        // Tool results come as user messages with array content — skip rendering as user messages
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const tc = toolCalls[block.tool_use_id];
              if (tc) {
                tc.status = block.is_error ? 'error' : 'completed';
                try {
                  tc.result = JSON.parse(block.content);
                } catch {
                  tc.result = block.content;
                }
              }
            }
          }
        }
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const msgEntry = { role: 'assistant', content: msg.content, id: genId() };
          messages.push(msgEntry);
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolCalls[block.id] = {
                name: block.name,
                input: block.input,
                status: 'running',
              };
            }
          }
        } else {
          messages.push({ role: 'assistant', content: msg.content, id: genId() });
        }
      }
    }
  }

  // ---- Event Listeners ----
  window.athena.onStreamChunk((chunk) => {
    streamingText += chunk;
    render();
  });

  window.athena.onToolUse(({ toolName, toolInput, toolId }) => {
    toolCalls[toolId] = { name: toolName, input: toolInput, status: 'running' };
    render();
  });

  window.athena.onToolResult(({ toolId, toolName, result }) => {
    if (toolCalls[toolId]) {
      toolCalls[toolId].status = result?.cancelled ? 'cancelled' : 'completed';
      toolCalls[toolId].result = result;
    }
    render();
  });

  window.athena.onAgentError((error) => {
    messages.push({ role: 'assistant', content: `Error: ${error}`, id: genId() });
    isThinking = false;
    render();
  });

  window.athena.onRequestConfirmation((data) => {
    confirmationData = data;
    render();
  });

  window.athena.onApiKeyStatus((keyPresent) => {
    hasApiKey = keyPresent;
    render();
  });

  window.athena.onRestoreHistory((history) => {
    rebuildFromHistory(history);
    render();
  });

  // ---- Init ----
  (async function init() {
    hasApiKey = await window.athena.getApiKeyStatus();
    await refreshFromHistory();
    render();
  })();
})();
