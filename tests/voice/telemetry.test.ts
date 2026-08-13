import { describe, expect, it } from 'vitest'
import { VoiceTurnLedger } from '../../src/voice/turns.js'
import {
  VOICE_TELEMETRY_SCHEMA_VERSION,
  VoiceTelemetry,
  VoiceTelemetryRecordSchema,
  type VoiceEventLabel,
  type VoiceEventName,
  type VoiceTelemetryEvent,
} from '../../src/voice/telemetry.js'

/** Strings that must never survive into a persisted record, in any field. */
const INCRIMINATING = {
  secret: 'sk-ant-api03-DEADBEEFdeadbeefDEADBEEFdeadbeef',
  path: 'C:\\Users\\nico\\Documents\\quarterly-forecast.xlsx',
  phrase: 'xylophone marmalade seventeen',
}

function ledger(options: { write?: (line: string) => void } = {}) {
  const lines: string[] = []
  const warnings: string[] = []
  const telemetry = new VoiceTelemetry({
    model: 'gpt-realtime-2.1-mini',
    artifact: 'voice-usage.jsonl',
    now: () => 1_700_000_000_000,
    launchedAt: 1_699_999_998_500,
    write: options.write ?? ((line) => lines.push(line)),
    onWarn: (message) => warnings.push(message),
  })
  const records = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  return { telemetry, lines, warnings, records }
}

describe('voice telemetry ledger records', () => {
  it('persists one validated scalar record per event, with the correlation IDs', () => {
    const { telemetry, lines, records } = ledger()
    const voiceTurnId = VoiceTurnLedger.idFor(3, 'inspect the failing tests')
    telemetry.record({ event: 'session.ready', ms: telemetry.sinceLaunch() })
    telemetry.record({ event: 'turn.submitted', voiceTurnId, source: 'audio' })
    telemetry.record({
      event: 'turn.completed',
      voiceTurnId,
      source: 'audio',
      harnessSessionId: '2026-08-13T09-27-11-a1b2c3d4',
      runId: '0f9c8b7a-1234-4abc-8def-0123456789ab',
      ms: 4_321,
    })

    expect(lines).toHaveLength(3)
    expect(records()[0]).toEqual({
      schemaVersion: VOICE_TELEMETRY_SCHEMA_VERSION,
      timestamp: '2023-11-14T22:13:20.000Z',
      model: 'gpt-realtime-2.1-mini',
      event: 'session.ready',
      // The ready-cue budget is measured from command launch, not from the ready line.
      ms: 1_500,
    })
    expect(records()[2]).toMatchObject({
      event: 'turn.completed',
      voiceTurnId,
      harnessSessionId: '2026-08-13T09-27-11-a1b2c3d4',
      runId: '0f9c8b7a-1234-4abc-8def-0123456789ab',
      ms: 4_321,
    })
    // Every line is a legal record, and legality is the thing that bounds the content.
    for (const record of records()) expect(() => VoiceTelemetryRecordSchema.parse(record)).not.toThrow()
    expect(telemetry.counters()).toMatchObject({
      'session.ready': 1,
      'turn.submitted': 1,
      'turn.completed': 1,
    })
  })

  it('accepts the identity shapes the real generators actually produce', () => {
    // Tightening an ID pattern would otherwise drop every record silently; this is the
    // test that turns that into a visible failure.
    for (const utterance of [1, 42, 9_999]) {
      expect(VoiceTurnLedger.idFor(utterance, 'do the thing')).toMatch(/^voice-turn:\d{1,12}:[0-9a-f]{16}$/)
    }
    const { telemetry, records } = ledger()
    telemetry.record({
      event: 'permission.wait',
      // Exactly what `src/engine/loop.ts` builds: `permission:${toolUseBlock.id}`.
      permissionId: 'permission:toolu_01A09q90qw90lq917835lq9',
    })
    expect(records()[0]).toMatchObject({ permissionId: 'permission:toolu_01A09q90qw90lq917835lq9' })
  })

  it('counts by event and by event and label, so a label is never lost in a total', () => {
    const { telemetry } = ledger()
    telemetry.record({ event: 'wake.rejected', label: 'ambient' })
    telemetry.record({ event: 'wake.rejected', label: 'ambient' })
    telemetry.record({ event: 'wake.rejected', label: 'low-confidence' })
    expect(telemetry.counters()).toMatchObject({
      'wake.rejected': 3,
      'wake.rejected/ambient': 2,
      'wake.rejected/low-confidence': 1,
    })
  })
})

describe('voice telemetry cannot persist content', () => {
  it('refuses every record whose fields are not enums, integers, or generator IDs', () => {
    const { telemetry, records } = ledger()
    // Each of these is a way a caller could put content into the ledger by mistake or by
    // a cast. None of them is a matter of the caller remembering: the record fails.
    const attempts: VoiceTelemetryEvent[] = [
      { event: 'turn.submitted', voiceTurnId: INCRIMINATING.phrase },
      { event: 'turn.submitted', voiceTurnId: INCRIMINATING.secret },
      { event: 'permission.wait', permissionId: INCRIMINATING.path },
      { event: 'turn.completed', harnessSessionId: INCRIMINATING.path },
      { event: 'turn.completed', runId: INCRIMINATING.phrase },
      { event: 'turn.feedback', label: INCRIMINATING.phrase as VoiceEventLabel },
      { event: INCRIMINATING.phrase as VoiceEventName },
      { event: 'turn.submitted', source: INCRIMINATING.phrase as 'audio' },
      { event: 'turn.completed', ms: Number.NaN },
      { event: 'turn.completed', ms: -1 },
      // An extra key rides along on a record that is otherwise perfectly valid.
      { event: 'turn.submitted', transcript: INCRIMINATING.phrase } as VoiceTelemetryEvent,
    ]
    for (const attempt of attempts) telemetry.record(attempt)

    const written = records()
    // Nothing but the visible drop reports reached the file.
    expect(written.every((record) => record['event'] === 'ledger.dropped')).toBe(true)
    expect(written).toHaveLength(attempts.length)
    expect(telemetry.counters()['ledger.dropped/invalid-record']).toBe(attempts.length)
    const persisted = JSON.stringify(written)
    for (const value of Object.values(INCRIMINATING)) expect(persisted).not.toContain(value)
  })

  it('reduces provider usage to numbers and drops every string the provider sent', () => {
    const { telemetry, records } = ledger()
    telemetry.record({
      event: 'provider.usage',
      meters: [{
        total_tokens: 812,
        input_token_details: { audio_tokens: 640, text_tokens: 172 },
        // A provider that starts echoing content into usage must not turn the cost
        // ledger into a transcript store.
        request_id: INCRIMINATING.secret,
        transcript: INCRIMINATING.phrase,
        file: INCRIMINATING.path,
      }],
    })
    expect(records()[0]).toMatchObject({
      event: 'provider.usage',
      meters: [{ total_tokens: 812, input_token_details: { audio_tokens: 640, text_tokens: 172 } }],
    })
    const persisted = JSON.stringify(records())
    for (const value of Object.values(INCRIMINATING)) expect(persisted).not.toContain(value)
  })

  it('keeps the event but no meters when the usage payload is nothing but content', () => {
    const { telemetry, records } = ledger()
    telemetry.record({ event: 'provider.usage', meters: INCRIMINATING.phrase })
    // Sanitizing leaves nothing, so the record persists as a usage line with no meters
    // rather than as a line carrying the phrase.
    expect(records()[0]).toEqual({
      schemaVersion: VOICE_TELEMETRY_SCHEMA_VERSION,
      timestamp: '2023-11-14T22:13:20.000Z',
      model: 'gpt-realtime-2.1-mini',
      event: 'provider.usage',
    })
  })
})

describe('voice telemetry is never fatal', () => {
  it('survives a write that always throws, warns once, and names the recovery', () => {
    const { telemetry, warnings } = ledger({
      write: () => {
        throw new Error('EACCES: permission denied, open voice-usage.jsonl')
      },
    })
    expect(() => {
      telemetry.record({ event: 'session.ready', ms: 1_200 })
      telemetry.record({ event: 'turn.submitted', source: 'audio' })
    }).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('voice-usage.jsonl')
    expect(warnings[0]).toContain('Voice is unaffected')
    expect(warnings[0]).toContain('athena doctor')
    // Counting continues even when persisting cannot, so the session still knows what it did.
    expect(telemetry.counters()).toMatchObject({ 'session.ready': 1, 'turn.submitted': 1 })
  })

  it('stops trying after the write budget and says the rest of the session is unrecorded', () => {
    let attempts = 0
    const { telemetry, warnings } = ledger({
      write: () => {
        attempts += 1
        throw new Error('ENOSPC: no space left on device')
      },
    })
    for (let index = 0; index < 10; index++) telemetry.record({ event: 'wake.accepted', label: 'wake-phrase' })
    // Three failures, then it stops hammering a disk that is telling it no.
    expect(attempts).toBe(3)
    expect(telemetry.isDegraded()).toBe(true)
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain('not recorded')
    expect(warnings[1]).toContain('Voice continues normally')
    // A bounded ledger must not read as full coverage.
    expect(telemetry.counters()).toMatchObject({
      'wake.accepted': 10,
      'ledger.dropped/write-failed': 1,
    })
  })
})
