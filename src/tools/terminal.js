const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const DANGEROUS_PATTERNS = /\b(rm\s|del\s|format\s|shutdown|restart|kill\s|taskkill)\b/i;

function resolveCwd(cwd) {
  if (!cwd) return os.homedir();
  if (path.isAbsolute(cwd)) return cwd;
  return path.join(os.homedir(), cwd);
}

function runCommand(command, cwd, onData) {
  return new Promise((resolve, reject) => {
    const resolvedCwd = resolveCwd(cwd);
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: resolvedCwd,
      env: { ...process.env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (onData) onData({ stream: 'stdout', text });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (onData) onData({ stream: 'stderr', text });
    });

    child.on('close', (code) => {
      resolve({
        command,
        cwd: resolvedCwd,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (err) => {
      reject(err);
    });

    // Kill after 60 seconds to prevent hanging
    setTimeout(() => {
      child.kill('SIGTERM');
    }, 60000);
  });
}

const toolDefinitions = [
  {
    name: 'runCommand',
    description:
      'Execute a shell command. Streams stdout/stderr. Requires confirmation for destructive commands (rm, del, format, shutdown, restart, kill, taskkill).',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to home)' },
      },
      required: ['command'],
    },
  },
];

const handlers = {
  runCommand: (input, onData) => runCommand(input.command, input.cwd, onData),
};

const confirmationRequired = {
  runCommand: (input) => {
    if (DANGEROUS_PATTERNS.test(input.command)) {
      return `Run potentially destructive command?\n\n> ${input.command}`;
    }
    return null; // No confirmation needed
  },
};

module.exports = { toolDefinitions, handlers, confirmationRequired };
