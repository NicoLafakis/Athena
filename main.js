const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { ClaudeAgent } = require('./src/api/claude');

const store = new Store({
  defaults: {
    windowBounds: { width: 900, height: 700 },
    windowPosition: null,
    conversationHistory: [],
    minimizeToTray: true,
  },
});

let mainWindow = null;
let tray = null;
let agent = null;

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || '';
}

function createAgent() {
  const apiKey = getApiKey();
  if (apiKey && apiKey !== 'your_key_here') {
    agent = new ClaudeAgent(apiKey);
    // Restore conversation history
    const savedHistory = store.get('conversationHistory', []);
    if (savedHistory.length > 0) {
      agent.setHistory(savedHistory);
    }
  }
}

function createWindow() {
  const { width, height } = store.get('windowBounds');
  const position = store.get('windowPosition');

  mainWindow = new BrowserWindow({
    width,
    height,
    x: position?.x,
    y: position?.y,
    minWidth: 600,
    minHeight: 400,
    title: 'Athena',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'resources', 'icon.png'),
    show: false,
    frame: true,
    autoHideMenuBar: true,
  });

  // Load the React app
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Send API key status to renderer
    const apiKey = getApiKey();
    const hasKey = apiKey && apiKey !== 'your_key_here';
    mainWindow.webContents.send('api-key-status', hasKey);

    // Send saved conversation history to renderer
    if (hasKey && agent) {
      const history = agent.getHistory();
      if (history.length > 0) {
        mainWindow.webContents.send('restore-history', history);
      }
    }
  });

  // Save window bounds on resize/move
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', { width: bounds.width, height: bounds.height });
  });

  mainWindow.on('move', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowPosition', { x: bounds.x, y: bounds.y });
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Create a simple 16x16 tray icon
  const iconPath = path.join(__dirname, 'resources', 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
  } catch {
    // Fallback: create a simple colored icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon.isEmpty() ? createDefaultIcon() : trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Athena',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Athena');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createDefaultIcon() {
  // Create a minimal 16x16 icon programmatically
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = 99;      // R
    canvas[i * 4 + 1] = 102;  // G
    canvas[i * 4 + 2] = 241;  // B (purple-ish)
    canvas[i * 4 + 3] = 255;  // A
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// ---- IPC Handlers ----

ipcMain.handle('send-message', async (event, message) => {
  if (!agent) {
    return { error: 'API key not configured. Add your ANTHROPIC_API_KEY to the .env file.' };
  }

  return new Promise((resolve, reject) => {
    const callbacks = {
      onText: (text) => {
        // Final text (not streamed chunks)
      },
      onStreamData: (chunk) => {
        mainWindow.webContents.send('stream-chunk', chunk);
      },
      onToolUse: (toolName, toolInput, toolId) => {
        mainWindow.webContents.send('tool-use', { toolName, toolInput, toolId });
      },
      onToolResult: (toolId, toolName, result) => {
        mainWindow.webContents.send('tool-result', { toolId, toolName, result });
      },
      onError: (error) => {
        mainWindow.webContents.send('agent-error', error);
      },
      requestConfirmation: (toolName, toolInput, message) => {
        return new Promise((confirmResolve) => {
          mainWindow.webContents.send('request-confirmation', {
            toolName,
            toolInput,
            message,
          });
          ipcMain.once('confirmation-response', (_, confirmed) => {
            confirmResolve(confirmed);
          });
        });
      },
    };

    agent
      .sendMessage(message, callbacks)
      .then((history) => {
        // Save conversation history
        store.set('conversationHistory', history);
        resolve({ success: true });
      })
      .catch((err) => {
        resolve({ error: err.message });
      });
  });
});

ipcMain.handle('get-history', () => {
  if (!agent) return [];
  return agent.getHistory();
});

ipcMain.handle('clear-history', () => {
  if (agent) agent.clearHistory();
  store.set('conversationHistory', []);
  return true;
});

ipcMain.handle('get-api-key-status', () => {
  const apiKey = getApiKey();
  return apiKey && apiKey !== 'your_key_here';
});

// ---- App Lifecycle ----

app.whenReady().then(() => {
  createAgent();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // On Windows, keep the app running in the tray
  if (process.platform !== 'darwin' && !store.get('minimizeToTray')) {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
