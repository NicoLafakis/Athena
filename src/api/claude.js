const Anthropic = require('@anthropic-ai/sdk');
const filesystem = require('../tools/filesystem');
const terminal = require('../tools/terminal');
const screen = require('../tools/screen');
const input = require('../tools/input');
const apps = require('../tools/apps');

// Aggregate all tool modules
const toolModules = [filesystem, terminal, screen, input, apps];

// Build the tools array for Claude API
function getAllTools() {
  const tools = [];
  for (const mod of toolModules) {
    for (const def of mod.toolDefinitions) {
      tools.push(def);
    }
  }
  return tools;
}

// Find the handler for a tool name
function findHandler(toolName) {
  for (const mod of toolModules) {
    if (mod.handlers[toolName]) {
      return { handler: mod.handlers[toolName], module: mod };
    }
  }
  return null;
}

// Check if a tool call needs confirmation
function needsConfirmation(toolName, input) {
  for (const mod of toolModules) {
    if (mod.confirmationRequired && mod.confirmationRequired[toolName]) {
      const msg = mod.confirmationRequired[toolName](input);
      if (msg) return msg; // If returns null (e.g. terminal safe command), no confirmation
    }
  }
  return null;
}

class ClaudeAgent {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.conversationHistory = [];
    this.tools = getAllTools();
    this.model = 'claude-sonnet-4-20250514';
    this.maxTokens = 4096;
    this.systemPrompt = `You are Athena, an AI assistant running as a desktop application on Windows 11. You have full control over the host machine through a comprehensive set of tools.

You can:
- Read, write, delete, and manage files and directories
- Execute shell commands and scripts
- Take screenshots and read text from the screen via OCR
- Control the mouse (move, click, scroll) and keyboard (type, press keys)
- Open, close, focus, minimize, and maximize applications and windows

Always explain what you're about to do before using a tool. Be helpful, precise, and cautious with destructive operations. When a tool requires confirmation, explain why the action needs approval.`;
  }

  async sendMessage(userMessage, callbacks = {}) {
    const { onText, onToolUse, onToolResult, onError, requestConfirmation } = callbacks;

    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    });

    return this._runConversation(callbacks);
  }

  async _runConversation(callbacks) {
    const { onText, onToolUse, onToolResult, onError, requestConfirmation, onStreamData } =
      callbacks;

    let continueLoop = true;

    while (continueLoop) {
      try {
        // Use streaming for real-time text output
        const stream = this.client.messages.stream({
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.systemPrompt,
          tools: this.tools,
          messages: this.conversationHistory,
        });

        // Collect streamed text chunks
        let currentText = '';

        stream.on('text', (text) => {
          currentText += text;
          if (onStreamData) onStreamData(text);
        });

        const response = await stream.finalMessage();

        // Process the response content blocks
        const assistantContent = response.content;
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantContent,
        });

        // Check if we need to handle tool use
        const toolUseBlocks = assistantContent.filter((b) => b.type === 'tool_use');

        if (toolUseBlocks.length === 0) {
          // No tool use — conversation turn complete
          const textBlocks = assistantContent
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          if (onText) onText(textBlocks);
          continueLoop = false;
        } else {
          // Process each tool call
          const toolResults = [];

          for (const toolBlock of toolUseBlocks) {
            if (onToolUse) onToolUse(toolBlock.name, toolBlock.input, toolBlock.id);

            // Check if confirmation is needed
            const confirmMsg = needsConfirmation(toolBlock.name, toolBlock.input);

            if (confirmMsg && requestConfirmation) {
              const confirmed = await requestConfirmation(
                toolBlock.name,
                toolBlock.input,
                confirmMsg,
              );
              if (!confirmed) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolBlock.id,
                  content: 'Action cancelled by user.',
                });
                if (onToolResult)
                  onToolResult(toolBlock.id, toolBlock.name, { cancelled: true });
                continue;
              }
            }

            // Execute the tool
            const found = findHandler(toolBlock.name);
            if (!found) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: `Unknown tool: ${toolBlock.name}`,
                is_error: true,
              });
              continue;
            }

            try {
              // For terminal commands, pass a streaming callback
              let result;
              if (toolBlock.name === 'runCommand' && onStreamData) {
                result = await found.handler(toolBlock.input, (data) => {
                  onStreamData(`\n[${data.stream}] ${data.text}`);
                });
              } else {
                result = await found.handler(toolBlock.input);
              }

              // For screenshot results, include as image content
              if (toolBlock.name === 'captureScreen' && result.image) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolBlock.id,
                  content: [
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: result.image,
                      },
                    },
                  ],
                });
              } else {
                const resultStr =
                  typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolBlock.id,
                  content: resultStr,
                });
              }

              if (onToolResult) onToolResult(toolBlock.id, toolBlock.name, result);
            } catch (err) {
              const errorMsg = `Error executing ${toolBlock.name}: ${err.message}`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: errorMsg,
                is_error: true,
              });
              if (onError) onError(errorMsg);
            }
          }

          // Add tool results to conversation and continue the loop
          this.conversationHistory.push({
            role: 'user',
            content: toolResults,
          });
        }
      } catch (err) {
        if (onError) onError(`API Error: ${err.message}`);
        continueLoop = false;
        throw err;
      }
    }

    return this.conversationHistory;
  }

  getHistory() {
    return this.conversationHistory;
  }

  setHistory(history) {
    this.conversationHistory = history;
  }

  clearHistory() {
    this.conversationHistory = [];
  }
}

module.exports = { ClaudeAgent, getAllTools, needsConfirmation };
