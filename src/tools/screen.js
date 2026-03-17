const screenshot = require('screenshot-desktop');

async function captureScreen() {
  const imgBuffer = await screenshot({ format: 'png' });
  const base64 = imgBuffer.toString('base64');
  return { image: base64, format: 'png' };
}

async function readScreenText() {
  const { createWorker } = require('tesseract.js');
  const screenshotResult = await captureScreen();
  const imgBuffer = Buffer.from(screenshotResult.image, 'base64');

  const worker = await createWorker('eng');
  const { data } = await worker.recognize(imgBuffer);
  await worker.terminate();

  return { text: data.text, confidence: data.confidence };
}

const toolDefinitions = [
  {
    name: 'captureScreen',
    description: 'Take a screenshot of the entire screen. Returns a base64-encoded PNG image.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'readScreenText',
    description:
      'Take a screenshot and extract all visible text using OCR (Tesseract). Returns the extracted text.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

const handlers = {
  captureScreen: () => captureScreen(),
  readScreenText: () => readScreenText(),
};

const confirmationRequired = {};

module.exports = { toolDefinitions, handlers, confirmationRequired };
