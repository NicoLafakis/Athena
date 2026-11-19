import { PROVIDERS, type ProviderId } from '../brain/models.js'
import { AnthropicClient, type ModelClient } from '../engine/client.js'
import { OpenAIClient } from '../engine/openai-client.js'
import { FixtureModelClient } from '../engine/fixture-client.js'
import type { TelemetryRecorder } from '../engine/telemetry.js'

export function makeClient(
  provider: ProviderId,
  key: string,
  recorder?: TelemetryRecorder,
): ModelClient {
  const fixture = process.env['ATHENA_TEST_MODEL_SCRIPT']
  if (process.env['NODE_ENV'] === 'test' && fixture) return new FixtureModelClient(fixture)
  if (provider === 'openai') {
    return new OpenAIClient(key, PROVIDERS[provider].baseURL ?? undefined, provider, recorder)
  }
  return new AnthropicClient(
    key,
    PROVIDERS[provider].baseURL ?? undefined,
    PROVIDERS[provider].authMode,
    provider,
    recorder,
  )
}
