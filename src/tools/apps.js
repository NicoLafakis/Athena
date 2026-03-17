const { execFile, exec } = require('child_process');
const path = require('path');
const os = require('os');
const { promisify } = require('util');

const execAsync = promisify(exec);

function getNircmdPath() {
  // In packaged app, resources are in process.resourcesPath
  // In dev, they're in the project root
  const devPath = path.join(__dirname, '..', '..', 'resources', 'nircmd.exe');
  const prodPath = path.join(process.resourcesPath || '', 'resources', 'nircmd.exe');
  try {
    require('fs').accessSync(devPath);
    return devPath;
  } catch {
    return prodPath;
  }
}

function runNircmd(...args) {
  return new Promise((resolve, reject) => {
    execFile(getNircmdPath(), args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout || 'OK');
    });
  });
}

async function openApp(executablePathOrName) {
  if (process.platform === 'win32') {
    await execAsync(`start "" "${executablePathOrName}"`, { shell: true });
  } else {
    await execAsync(`open "${executablePathOrName}" || xdg-open "${executablePathOrName}"`);
  }
  return { app: executablePathOrName, opened: true };
}

async function closeApp(processName) {
  if (process.platform === 'win32') {
    await execAsync(`taskkill /IM "${processName}" /F`);
  } else {
    await execAsync(`pkill -f "${processName}"`);
  }
  return { process: processName, closed: true };
}

async function focusWindow(windowTitle) {
  if (process.platform === 'win32') {
    await runNircmd('win', 'activate', 'title', windowTitle);
  }
  return { window: windowTitle, focused: true };
}

async function listOpenWindows() {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(
      `powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object MainWindowTitle | ConvertTo-Json"`,
    );
    try {
      let parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) parsed = [parsed];
      return { windows: parsed.map((w) => w.MainWindowTitle) };
    } catch {
      return { windows: [], raw: stdout };
    }
  }
  return { windows: [], error: 'Only supported on Windows' };
}

async function minimizeWindow(windowTitle) {
  if (process.platform === 'win32') {
    await runNircmd('win', 'min', 'title', windowTitle);
  }
  return { window: windowTitle, minimized: true };
}

async function maximizeWindow(windowTitle) {
  if (process.platform === 'win32') {
    await runNircmd('win', 'max', 'title', windowTitle);
  }
  return { window: windowTitle, maximized: true };
}

const toolDefinitions = [
  {
    name: 'openApp',
    description: 'Open an application by executable path or name.',
    input_schema: {
      type: 'object',
      properties: {
        executablePathOrName: { type: 'string', description: 'Path or name of the application' },
      },
      required: ['executablePathOrName'],
    },
  },
  {
    name: 'closeApp',
    description: 'Close/kill an application by process name. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        processName: { type: 'string', description: 'Process name (e.g. notepad.exe)' },
      },
      required: ['processName'],
    },
  },
  {
    name: 'focusWindow',
    description: 'Bring a window to the foreground by its title.',
    input_schema: {
      type: 'object',
      properties: {
        windowTitle: { type: 'string', description: 'Window title to focus' },
      },
      required: ['windowTitle'],
    },
  },
  {
    name: 'listOpenWindows',
    description: 'List all currently open windows with their titles.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'minimizeWindow',
    description: 'Minimize a window by its title.',
    input_schema: {
      type: 'object',
      properties: {
        windowTitle: { type: 'string', description: 'Window title to minimize' },
      },
      required: ['windowTitle'],
    },
  },
  {
    name: 'maximizeWindow',
    description: 'Maximize a window by its title.',
    input_schema: {
      type: 'object',
      properties: {
        windowTitle: { type: 'string', description: 'Window title to maximize' },
      },
      required: ['windowTitle'],
    },
  },
];

const handlers = {
  openApp: (input) => openApp(input.executablePathOrName),
  closeApp: (input) => closeApp(input.processName),
  focusWindow: (input) => focusWindow(input.windowTitle),
  listOpenWindows: () => listOpenWindows(),
  minimizeWindow: (input) => minimizeWindow(input.windowTitle),
  maximizeWindow: (input) => maximizeWindow(input.windowTitle),
};

const confirmationRequired = {
  closeApp: (input) => `Close application "${input.processName}"?`,
};

module.exports = { toolDefinitions, handlers, confirmationRequired };
