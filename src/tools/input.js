let nut;
try {
  nut = require('@nut-tree-fork/nut-js');
} catch {
  // nut-js may not be available in all environments
  nut = null;
}

async function moveMouse(x, y) {
  if (!nut) throw new Error('nut-js is not available');
  await nut.mouse.setPosition({ x, y });
  return { x, y, moved: true };
}

async function clickMouse(button = 'left') {
  if (!nut) throw new Error('nut-js is not available');
  const Button = nut.Button;
  const btnMap = {
    left: Button.LEFT,
    right: Button.RIGHT,
    middle: Button.MIDDLE,
  };

  if (button === 'double') {
    await nut.mouse.doubleClick(Button.LEFT);
  } else {
    await nut.mouse.click(btnMap[button] || Button.LEFT);
  }
  return { button, clicked: true };
}

async function typeText(text) {
  if (!nut) throw new Error('nut-js is not available');
  await nut.keyboard.type(text);
  return { text, typed: true };
}

async function pressKey(key) {
  if (!nut) throw new Error('nut-js is not available');
  const Key = nut.Key;
  // Map common key names to nut-js Key enum
  const keyName = key.charAt(0).toUpperCase() + key.slice(1);
  const nutKey = Key[keyName] || Key[key.toUpperCase()] || Key[key];
  if (!nutKey) throw new Error(`Unknown key: ${key}`);
  await nut.keyboard.pressKey(nutKey);
  await nut.keyboard.releaseKey(nutKey);
  return { key, pressed: true };
}

async function scrollMouse(x, y, amount) {
  if (!nut) throw new Error('nut-js is not available');
  await nut.mouse.setPosition({ x, y });
  await nut.mouse.scrollDown(amount);
  return { x, y, amount, scrolled: true };
}

const toolDefinitions = [
  {
    name: 'moveMouse',
    description: 'Move the mouse cursor to the specified screen coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'clickMouse',
    description: 'Click the mouse. Supports left, right, middle, or double click.',
    input_schema: {
      type: 'object',
      properties: {
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle', 'double'],
          description: 'Mouse button (default: left)',
        },
      },
      required: [],
    },
  },
  {
    name: 'typeText',
    description: 'Type text using the keyboard as if the user is typing.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
    },
  },
  {
    name: 'pressKey',
    description: 'Press and release a single keyboard key (e.g. Enter, Tab, Escape, F5).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g. Enter, Tab, Escape, F5, Space)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'scrollMouse',
    description: 'Scroll the mouse wheel at the given screen position.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        amount: { type: 'number', description: 'Scroll amount (positive = down)' },
      },
      required: ['x', 'y', 'amount'],
    },
  },
];

const handlers = {
  moveMouse: (input) => moveMouse(input.x, input.y),
  clickMouse: (input) => clickMouse(input.button),
  typeText: (input) => typeText(input.text),
  pressKey: (input) => pressKey(input.key),
  scrollMouse: (input) => scrollMouse(input.x, input.y, input.amount),
};

const confirmationRequired = {};

module.exports = { toolDefinitions, handlers, confirmationRequired };
