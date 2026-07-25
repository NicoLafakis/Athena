export interface OutputValidation {
  valid: boolean
  value?: unknown
  errors: string[]
}

export function validateJsonOutput(text: string, schema: unknown): OutputValidation {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { valid: false, errors: [`output is not valid JSON: ${(err as Error).message}`] }
  }
  const errors: string[] = []
  validateNode(value, schema as Record<string, unknown>, '$', errors)
  return errors.length === 0 ? { valid: true, value, errors } : { valid: false, value, errors }
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path}: schema must be an object`)
    return
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((item) => deepEqual(item, value))) {
    errors.push(`${path}: value is not in enum`)
  }
  if ('const' in schema && !deepEqual(schema['const'], value)) errors.push(`${path}: value does not match const`)

  const type = schema['type']
  if (typeof type === 'string' && !matchesType(value, type)) {
    errors.push(`${path}: expected ${type}`)
    return
  }
  if (Array.isArray(type) && !type.some((item) => typeof item === 'string' && matchesType(value, item))) {
    errors.push(`${path}: expected one of ${type.join(', ')}`)
    return
  }

  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      errors.push(`${path}: shorter than minLength`)
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      errors.push(`${path}: longer than maxLength`)
    }
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) {
      errors.push(`${path}: does not match pattern`)
    }
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) errors.push(`${path}: below minimum`)
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) errors.push(`${path}: above maximum`)
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      errors.push(`${path}: fewer than minItems`)
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      errors.push(`${path}: more than maxItems`)
    }
    if (schema['items'] && typeof schema['items'] === 'object') {
      value.forEach((item, index) =>
        validateNode(item, schema['items'] as Record<string, unknown>, `${path}[${index}]`, errors),
      )
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const properties =
      schema['properties'] && typeof schema['properties'] === 'object'
        ? (schema['properties'] as Record<string, Record<string, unknown>>)
        : {}
    const required = Array.isArray(schema['required']) ? schema['required'].map(String) : []
    for (const key of required) {
      if (!(key in object)) errors.push(`${path}.${key}: required property missing`)
    }
    for (const [key, child] of Object.entries(object)) {
      if (properties[key]) validateNode(child, properties[key], `${path}.${key}`, errors)
      else if (schema['additionalProperties'] === false) errors.push(`${path}.${key}: additional property not allowed`)
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    default:
      return typeof value === type
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
