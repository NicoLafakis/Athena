import type { InvestigationSnapshot, SourceRevision, Verification } from './types.js'

export function verifyInvestigation(snapshot: InvestigationSnapshot, currentRevision: SourceRevision): Verification {
  const result = snapshot.result
  const fresh = currentRevision.id === snapshot.target.revision.id
  const observations = new Map(snapshot.observations.map(o => [o.id, o]))
  const tests: Verification['tests'] = (result?.tests ?? []).map(test => {
    const evidenceIds = test.observationId ? [test.observationId] : []
    if (!fresh) return { id: test.id, status: 'stale', reason: 'Source revision changed; start a new investigation', evidenceIds }
    if (test.provider !== 'source-text') return { id: test.id, status: 'unsupported', reason: `No ${test.provider} verification provider in this source-only MVP`, evidenceIds }
    const observation = observations.get(test.observationId ?? '')
    if (!observation || observation.kind !== 'observed' || !observation.usable) return { id: test.id, status: 'unknown', reason: 'An actual complete, unredacted source selection is required', evidenceIds }
    const present = observation.text.includes(test.contains)
    return {
      id: test.id, status: present === (test.expect === 'present') ? 'passed' : 'failed',
      reason: `Literal ${test.expect} predicate on ${observation.location!.path}:${observation.location!.firstLine}-${observation.location!.lastLine}; static text only`, evidenceIds,
    }
  })
  const claims: Verification['claims'] = (result?.claims ?? []).map(claim => {
    const selected = tests.filter(t => claim.testIds.includes(t.id))
    const observed = claim.evidenceIds.map(id => observations.get(id)!).filter(o => o.kind === 'observed' && o.usable)
    const independentEvidenceCount = new Set(observed.flatMap(o => o.independentIds)).size
    const base = { id: claim.id, independentEvidenceCount }
    if (!fresh) return { ...base, status: 'stale', reason: 'Source revision changed' }
    if (claim.counterevidenceIds.length) return { ...base, status: 'contradicted', reason: 'Linked counterevidence remains unresolved' }
    if (selected.some(t => t.status === 'unsupported')) return { ...base, status: 'unsupported', reason: 'Required verification provider is missing' }
    if (claim.scope !== 'source-text') return { ...base, status: 'unknown', reason: 'Static source text cannot verify behavior, runtime, or external claims' }
    if (!observed.length || selected.some(t => t.evidenceIds.some(id => !claim.evidenceIds.includes(id)))) return { ...base, status: 'unknown', reason: 'Claim needs its own observed source evidence and linked tests' }
    if (selected.some(t => t.status === 'failed')) return { ...base, status: 'failed', reason: 'A required discriminating predicate failed' }
    if (!selected.length || selected.some(t => t.status !== 'passed')) return { ...base, status: 'unknown', reason: 'Required source predicates are not verified' }
    return { ...base, status: 'passed', reason: 'Only the linked literal source predicates passed; the statement remains an authored interpretation' }
  })
  const hypotheses: Verification['hypotheses'] = (result?.hypotheses ?? []).map(hypothesis => {
    const selected = tests.filter(t => result!.tests.find(test => test.id === t.id)!.hypothesisId === hypothesis.id)
    if (!fresh) return { id: hypothesis.id, status: 'stale', reason: 'Source revision changed' }
    if (!selected.length || selected.some(t => t.status !== 'passed' && t.status !== 'failed')) return { id: hypothesis.id, status: 'unresolved', reason: 'A discriminating test remains unknown or unsupported' }
    if (selected.some(t => t.status === 'failed')) return { id: hypothesis.id, status: 'refuted', reason: 'A declared literal prediction failed; this does not refute broader behavioral interpretations' }
    if (hypothesis.counterevidence.length) return { id: hypothesis.id, status: 'unresolved', reason: 'Linked counterevidence conflicts with passing predictions' }
    return { id: hypothesis.id, status: 'supported', reason: 'Declared source predicates passed; the hypothesis remains an authored interpretation' }
  })
  const discriminated = hypotheses.some(h => h.status === 'supported') && hypotheses.some(h => h.status === 'refuted') && hypotheses.every(h => h.status === 'supported' || h.status === 'refuted')
  return {
    complete: !!result && fresh && currentRevision.files.every(file => file.hash !== null) && claims.length > 0 && claims.every(c => c.status === 'passed') && result.unknowns.length === 0 && discriminated,
    currentRevision, hypotheses, tests, claims, remainingUnknowns: result?.unknowns ?? [],
  }
}
