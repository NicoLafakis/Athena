const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');

function resolvePath(p) {
  if (path.isAbsolute(p)) return p;
  return path.join(os.homedir(), p);
}

async function readFile(filePath) {
  const resolved = resolvePath(filePath);
  const content = await fs.readFile(resolved, 'utf-8');
  return { path: resolved, content };
}

async function writeFile(filePath, content) {
  const resolved = resolvePath(filePath);
  await fs.ensureDir(path.dirname(resolved));
  await fs.writeFile(resolved, content, 'utf-8');
  return { path: resolved, success: true };
}

async function deleteFile(filePath) {
  const resolved = resolvePath(filePath);
  await fs.remove(resolved);
  return { path: resolved, deleted: true };
}

async function moveFile(src, dest) {
  const resolvedSrc = resolvePath(src);
  const resolvedDest = resolvePath(dest);
  const destExists = await fs.pathExists(resolvedDest);
  await fs.move(resolvedSrc, resolvedDest, { overwrite: true });
  return { src: resolvedSrc, dest: resolvedDest, overwrote: destExists };
}

async function listDirectory(dirPath) {
  const resolved = resolvePath(dirPath || '.');
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const items = entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'directory' : 'file',
    path: path.join(resolved, e.name),
  }));
  return { path: resolved, entries: items };
}

async function createDirectory(dirPath) {
  const resolved = resolvePath(dirPath);
  await fs.ensureDir(resolved);
  return { path: resolved, created: true };
}

function watchDirectory(dirPath) {
  const resolved = resolvePath(dirPath);
  const events = [];
  const watcher = chokidar.watch(resolved, { ignoreInitial: true });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      watcher.close();
      resolve({ path: resolved, events });
    }, 5000);

    watcher.on('all', (event, filePath) => {
      events.push({ event, path: filePath, time: new Date().toISOString() });
      if (events.length >= 50) {
        clearTimeout(timeout);
        watcher.close();
        resolve({ path: resolved, events });
      }
    });
  });
}

// Tool definitions for Claude API
const toolDefinitions = [
  {
    name: 'readFile',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or home-relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'writeFile',
    description: 'Write content to a file, creating directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or home-relative file path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'deleteFile',
    description: 'Delete a file or directory. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
      },
      required: ['path'],
    },
  },
  {
    name: 'moveFile',
    description: 'Move or rename a file. Requires confirmation if destination exists.',
    input_schema: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'Source path' },
        dest: { type: 'string', description: 'Destination path' },
      },
      required: ['src', 'dest'],
    },
  },
  {
    name: 'listDirectory',
    description: 'List files and directories at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (defaults to home)' },
      },
      required: [],
    },
  },
  {
    name: 'createDirectory',
    description: 'Create a directory (and any parent directories).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create' },
      },
      required: ['path'],
    },
  },
  {
    name: 'watchDirectory',
    description: 'Watch a directory for file changes for up to 5 seconds, returning change events.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to watch' },
      },
      required: ['path'],
    },
  },
];

// Map tool names to handler functions
const handlers = {
  readFile: (input) => readFile(input.path),
  writeFile: (input) => writeFile(input.path, input.content),
  deleteFile: (input) => deleteFile(input.path),
  moveFile: (input) => moveFile(input.src, input.dest),
  listDirectory: (input) => listDirectory(input.path),
  createDirectory: (input) => createDirectory(input.path),
  watchDirectory: (input) => watchDirectory(input.path),
};

// Tools that require confirmation
const confirmationRequired = {
  deleteFile: (input) => `Delete "${input.path}"? This cannot be undone.`,
  moveFile: (input) => `Move "${input.src}" to "${input.dest}"?`,
};

module.exports = { toolDefinitions, handlers, confirmationRequired };
