import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { protectedPatchPaths } from '../../src/learning/evaluation.js'
import { EvalSuiteSchema } from '../../src/learning/types.js'

describe('checked-in evaluation assets', () => {
  it('keeps a protected five-case held-out parity suite', () => {
    const suite = EvalSuiteSchema.parse(
      JSON.parse(
        readFileSync(resolve('evals/heldout/athena-parity-v1.json'), 'utf8'),
      ),
    )
    expect(suite.cases).toHaveLength(5)
    expect(suite.cases.every((testCase) => testCase.split === 'heldout')).toBe(true)
    expect(suite.cases.every((testCase) => testCase.safetyInvariant)).toBe(true)
  })

  it('protects evaluator inputs from edits, deletes, and renames', () => {
    const patch = [
      'diff --git a/tests/example.test.ts b/tests/example.test.ts',
      '--- a/tests/example.test.ts',
      '+++ /dev/null',
      'diff --git a/evals/heldout/old.json b/evals/heldout/new.json',
      'rename from evals/heldout/old.json',
      'rename to evals/heldout/new.json',
      'diff --git a/src/runtime.ts b/src/runtime.ts',
      '--- a/src/runtime.ts',
      '+++ b/src/runtime.ts',
    ].join('\n')
    expect(protectedPatchPaths(patch)).toEqual([
      'tests/example.test.ts',
      'evals/heldout/old.json',
      'evals/heldout/new.json',
    ])
  })
})
