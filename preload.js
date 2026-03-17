const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('athena', {
  sendMessage: (message) => ipcRenderer.invoke('send-message', message),
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getApiKeyStatus: () => ipcRenderer.invoke('get-api-key-status'),

  // Event listeners
  onStreamChunk: (callback) => {
    ipcRenderer.on('stream-chunk', (_, chunk) => callback(chunk));
  },
  onToolUse: (callback) => {
    ipcRenderer.on('tool-use', (_, data) => callback(data));
  },
  onToolResult: (callback) => {
    ipcRenderer.on('tool-result', (_, data) => callback(data));
  },
  onAgentError: (callback) => {
    ipcRenderer.on('agent-error', (_, error) => callback(error));
  },
  onRequestConfirmation: (callback) => {
    ipcRenderer.on('request-confirmation', (_, data) => callback(data));
  },
  sendConfirmationResponse: (confirmed) => {
    ipcRenderer.send('confirmation-response', confirmed);
  },
  onApiKeyStatus: (callback) => {
    ipcRenderer.on('api-key-status', (_, hasKey) => callback(hasKey));
  },
  onRestoreHistory: (callback) => {
    ipcRenderer.on('restore-history', (_, history) => callback(history));
  },

  // Cleanup
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
