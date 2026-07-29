import { describe, expect, it } from 'vitest'
import { WorkAggregationDetector } from '../../src/interaction/detectors/work-aggregation.js'

describe('WorkAggregationDetector', () => {
  it('coalesces duplicate lifecycle events and reports active child/background counts', () => {
    const detector = new WorkAggregationDetector()
    expect(detector.accept({
      type: 'child-status', runId: 'child-1', agent: 'reviewer', status: 'running',
    })).toMatchObject({ activeChildren: 1, activeBackground: 0, total: 1 })
    expect(detector.accept({
      type: 'child-status', runId: 'child-1', agent: 'reviewer', status: 'running',
    })).toBeNull()
    expect(detector.accept({
      type: 'background-status', taskId: 'bg-1', status: 'running', awaited: false,
    })).toMatchObject({ activeChildren: 1, activeBackground: 1, total: 2 })
    expect(detector.accept({
      type: 'child-status', runId: 'child-1', agent: 'reviewer', status: 'completed',
    })).toMatchObject({ activeChildren: 0, activeBackground: 1, total: 1 })
    expect(detector.accept({
      type: 'background-status', taskId: 'bg-1', status: 'completed', awaited: false,
    })).toMatchObject({ activeChildren: 0, activeBackground: 0, total: 0 })
    expect(detector.accept({
      type: 'background-status', taskId: 'bg-1', status: 'completed', awaited: true,
    })).toBeNull()
  })

  it('bounds active identity maps', () => {
    const detector = new WorkAggregationDetector({ maxChildren: 2, maxBackground: 2 })
    for (let index = 0; index < 10; index++) {
      detector.accept({
        type: 'child-status', runId: `child-${index}`, agent: 'worker', status: 'running',
      })
      detector.accept({
        type: 'background-status', taskId: `bg-${index}`, status: 'running', awaited: false,
      })
    }
    expect(detector.stats()).toEqual({ activeChildren: 2, activeBackground: 2 })
  })
})
