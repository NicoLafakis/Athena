import { resolveTrustBootstrap, type TrustBootstrapInput } from './permissions.js'

/** Preview the same bootstrap used at interactive startup, before persisting trust. */
export function describeProjectTrust(input: Omit<TrustBootstrapInput, 'explicitlyTrusted'>): string {
  const effective = resolveTrustBootstrap({ ...input, explicitlyTrusted: true })
  const lines = [
    'Project instructions and extensions will be loaded from this canonical project.',
    `Interactive permission mode: ${effective.permissionMode}; sandbox: ${effective.sandboxMode}.`,
  ]
  if (effective.permissionMode === 'trusted') {
    lines.push('Trusted mode automatically approves mutating tools, including shell commands.')
  }
  if (effective.sandboxMode === 'unrestricted') {
    lines.push((input.platform ?? process.platform) === 'win32'
      ? 'Shell commands run unrestricted with your user account authority; Athena has no Windows OS sandbox.'
      : 'Shell commands run unrestricted with your user account authority.')
  }
  lines.push(
    'Deny rules, protected paths and applicable hooks still apply.',
    'Project settings hooks and MCP configurations require separate approval, invalidated when their configuration changes.',
    'Trust persists for this canonical project until revoked with athena trust --revoke. Headless exec uses its own explicit permission and sandbox options.',
  )
  return lines.join('\n')
}
