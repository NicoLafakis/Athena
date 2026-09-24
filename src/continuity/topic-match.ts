function terms(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
}

function wordForms(term: string): string[] {
  if (term.length > 4 && term.endsWith('ies')) return [term, term.slice(0, -3) + 'y']
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return [term, term.slice(0, -1)]
  return [term]
}

function matchesTerm(query: string, source: string): boolean {
  return wordForms(query).some((queryForm) =>
    wordForms(source).some((sourceForm) =>
      queryForm === sourceForm || sourceForm.startsWith(queryForm) || queryForm.startsWith(sourceForm),
    ),
  )
}

export function matchingTopicTermCount(queryTerms: string[], fields: string[]): number {
  const fieldTerms = fields.map(terms)
  return queryTerms.filter((term) =>
    fieldTerms.some((tokens) => tokens.some((candidate) => matchesTerm(term, candidate))),
  ).length
}

/** Require more than a lone incidental token before a multi-topic query can select history. */
export function hasSufficientTopicOverlap(queryTerms: string[], fields: string[]): boolean {
  if (queryTerms.length === 0) return false
  const minimumMatches = queryTerms.length === 1
    ? 1
    : Math.max(2, Math.ceil(queryTerms.length / 2))
  return matchingTopicTermCount(queryTerms, fields) >= minimumMatches
}
