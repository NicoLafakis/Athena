import { describe, expect, it } from 'vitest'
import { validateJsonOutput } from '../../src/engine/output-schema.js'

describe('validateJsonOutput', () => {
  const schema = {
    type: 'object',
    required: ['answer'],
    additionalProperties: false,
    properties: {
      answer: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  }

  it('parses and validates a matching JSON value', () => {
    expect(validateJsonOutput('{"answer":"yes","confidence":0.9}', schema)).toMatchObject({
      valid: true,
      value: { answer: 'yes', confidence: 0.9 },
    })
  })

  it('reports parse and schema failures with paths', () => {
    expect(validateJsonOutput('not-json', schema).errors[0]).toMatch(/not valid JSON/)
    const invalid = validateJsonOutput('{"confidence":2,"extra":true}', schema)
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.join('\n')).toMatch(/answer.*required/)
    expect(invalid.errors.join('\n')).toMatch(/confidence.*maximum/)
    expect(invalid.errors.join('\n')).toMatch(/extra.*additional/)
  })
})
