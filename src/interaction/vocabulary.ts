export const VOCABULARY_VERSION = 1 as const

/** Research fixture only. Presentation adapters may adopt these labels after the
 * blind-user vocabulary study; runtime behavior must not depend on this draft. */
export const SEMANTIC_VOCABULARY = Object.freeze({
  status: {
    label: 'Status',
    definition: 'A current summary of what Athena knows, with each claim tied to its source.',
  },
  attention: {
    label: 'Attention',
    definition: 'A material change or problem the user should know about now.',
  },
  permission: {
    label: 'Permission',
    definition: 'A decision only the user can make before a proposed action may continue.',
  },
  advisory: {
    label: 'Advisory',
    definition: 'Evidence-based guidance that may help but cannot make a decision or authorize an action.',
  },
  completed: {
    label: 'Completed',
    definition: 'The requested run ended successfully according to current runtime evidence.',
  },
  failed: {
    label: 'Failed',
    definition: 'The requested run or operation ended unsuccessfully according to runtime evidence.',
  },
  blocked: {
    label: 'Blocked',
    definition: 'Work cannot continue until a named condition changes or the user responds.',
  },
} as const)
