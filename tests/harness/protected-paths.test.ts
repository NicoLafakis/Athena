import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtectedPaths, defaultProtectedRoots } from '../../src/harness/protected-paths.js'

/**
 * A synthetic Windows environment. Every case here injects `platform: 'win32'`
 * and this env rather than reading the host, so the Win32 normalization rules
 * are exercised identically on Linux, macOS, and Windows CI. The real-machine
 * pass lives in the win32-gated block at the bottom.
 */
const WIN_ENV: NodeJS.ProcessEnv = {
  SystemRoot: 'C:\\WINDOWS',
  windir: 'C:\\WINDOWS',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  ProgramData: 'C:\\ProgramData',
  SystemDrive: 'C:',
  USERPROFILE: 'C:\\Users\\owner',
}

const CWD = 'C:\\programming\\Athena'

function winFence(extra: string[] = []): ProtectedPaths {
  return ProtectedPaths.from(extra, { platform: 'win32', env: WIN_ENV })
}

describe('defaultProtectedRoots derivation', () => {
  it('derives every root from the environment, not a hardcoded C:', () => {
    const roots = defaultProtectedRoots({
      platform: 'win32',
      env: {
        SystemRoot: 'D:\\Windows',
        ProgramFiles: 'D:\\Program Files',
        'ProgramFiles(x86)': 'D:\\Program Files (x86)',
        ProgramData: 'D:\\ProgramData',
        SystemDrive: 'D:',
      },
    })
    expect(roots).toContain('D:\\Windows')
    expect(roots).toContain('D:\\System Volume Information')
    expect(roots.every((root) => root.startsWith('D:'))).toBe(true)
  })

  it('recovers the system drive from %SystemRoot% when %SystemDrive% is absent', () => {
    const roots = defaultProtectedRoots({ platform: 'win32', env: { SystemRoot: 'E:\\Windows' } })
    expect(roots).toContain('E:\\Windows')
    expect(roots).toContain('E:\\System Volume Information')
    expect(roots).toContain('E:\\Recovery')
  })

  it('falls back to C: only when the environment names no drive at all', () => {
    const roots = defaultProtectedRoots({ platform: 'win32', env: {} })
    expect(roots).toEqual([
      'C:\\System Volume Information',
      'C:\\Recovery',
      'C:\\Boot',
      'C:\\EFI',
    ])
  })

  it('honours %ProgramW6432% so a 32-bit process still fences the 64-bit tree', () => {
    const roots = defaultProtectedRoots({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' },
    })
    expect(roots).toContain('C:\\Program Files')
    expect(roots).toContain('C:\\Program Files (x86)')
  })

  it('strips trailing separators and de-duplicates', () => {
    const roots = defaultProtectedRoots({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files\\', ProgramW6432: 'C:\\Program Files' },
    })
    expect(roots.filter((root) => root === 'C:\\Program Files')).toHaveLength(1)
  })

  it('fences nothing in the user profile, AppData, ~/.athena, or a work directory', () => {
    const roots = defaultProtectedRoots({ platform: 'win32', env: WIN_ENV })
    for (const pattern of [/users/i, /appdata/i, /\.athena/i, /programming/i, /temp/i, /desktop/i]) {
      expect(roots.some((root) => pattern.test(root))).toBe(false)
    }
  })

  it('uses kernel/firmware surfaces on POSIX and leaves dev prefixes alone', () => {
    expect(defaultProtectedRoots({ platform: 'linux', env: {} })).toEqual(['/boot', '/proc', '/sys'])
    expect(defaultProtectedRoots({ platform: 'darwin', env: {} })).toEqual(['/System'])
    // /usr, /usr/local, and /opt host Homebrew, nvm, and pnpm. Fencing them
    // would break ordinary development for no OS-integrity gain.
    for (const platform of ['linux', 'darwin'] as const) {
      const roots = defaultProtectedRoots({ platform, env: {} })
      expect(roots).not.toContain('/usr')
      expect(roots).not.toContain('/usr/local')
      expect(roots).not.toContain('/opt')
    }
  })
})

describe('filesystem aliases', () => {
  it('matches a protected root supplied through a symlink after target canonicalization', () => {
    const root = mkdtempSync(join(tmpdir(), 'athena-protected-alias-'))
    const target = join(root, 'canonical')
    const alias = join(root, 'protected')
    try {
      mkdirSync(target)
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const canonicalTarget = realpathSync.native(alias)
      const fence = new ProtectedPaths([alias])

      expect(fence.deniedRoot(join(canonicalTarget, 'child'), root)).toBe(alias)
      expect(fence.scanCommand(`rm -rf ${join(alias, 'child')}`, root)?.root).toBe(alias)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ProtectedPaths bypass vectors (win32 semantics)', () => {
  const blocked: Array<[label: string, target: string]> = [
    ['plain system path', 'C:\\Windows\\System32\\drivers\\etc\\hosts'],
    ['the fenced directory itself', 'C:\\Windows'],
    ['lowercase', 'c:\\windows\\system32\\x'],
    ['uppercase', 'C:\\WINDOWS\\SYSTEM32\\X'],
    ['forward slashes', 'C:/Windows/System32/x'],
    ['mixed separators', 'C:\\Windows/System32\\x'],
    ['dot-dot traversal', 'C:\\programming\\..\\Windows\\System32\\x'],
    ['redundant dot segments', 'C:\\Windows\\.\\System32\\.\\x'],
    ['relative traversal from the cwd', '..\\..\\WINDOWS\\notepad.exe'],
    ['relative traversal with forward slashes', '../../WINDOWS/notepad.exe'],
    ['8.3 short name for Program Files', 'C:\\PROGRA~1\\App\\x.dll'],
    ['8.3 short name, lowercase', 'c:\\progra~2\\App\\x.dll'],
    ['8.3 short name for System Volume Information', 'C:\\SYSTEM~1\\x'],
    ['extended-length prefix', '\\\\?\\C:\\Windows\\System32\\x'],
    ['device namespace prefix', '\\\\.\\C:\\Windows\\System32\\x'],
    ['NT object prefix', '\\??\\C:\\Windows\\System32\\x'],
    ['stacked device prefixes', '\\\\?\\\\\\?\\C:\\Windows\\x'],
    ['UNC extended prefix over an admin share', '\\\\?\\UNC\\host\\C$\\Windows\\x'],
    ['administrative share', '\\\\localhost\\C$\\Windows\\System32\\x'],
    ['drive-relative path', 'C:..\\..\\WINDOWS\\System32\\x'],
    ['root-relative path', '\\Windows\\System32\\x'],
    ['trailing dot on a segment', 'C:\\Windows.\\System32\\x'],
    ['trailing space on a segment', 'C:\\Windows \\System32\\x'],
    ['trailing dot and space', 'C:\\Windows. \\System32\\x'],
    ['quoted path', '"C:\\Windows\\System32\\x"'],
    ['Program Files (x86)', 'C:\\Program Files (x86)\\App\\x'],
    ['ProgramData', 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\x'],
    ['System Volume Information', 'C:\\System Volume Information\\x'],
    ['Recovery', 'C:\\Recovery\\WindowsRE\\x'],
    ['Boot', 'C:\\Boot\\BCD'],
    ['EFI', 'C:\\EFI\\Microsoft\\Boot\\x'],
  ]
  it.each(blocked)('blocks %s', (_label, target) => {
    expect(winFence().deniedRoot(target, CWD)).not.toBeNull()
  })

  const allowed: Array<[label: string, target: string]> = [
    // Segment-boundary matching: C:\Windows must not swallow C:\WindowsApps.
    ['a sibling sharing a string prefix', 'C:\\WindowsApps\\pkg\\x'],
    ['another string-prefix sibling', 'C:\\Windows2\\x'],
    ['Program Files without the space', 'C:\\ProgramFiles\\x'],
    ['a longer Program Files sibling', 'C:\\Program Files 2\\x'],
    ['a Recovery sibling', 'C:\\Recovery2\\x'],
    ['a partial 8.3-looking name', 'C:\\progra~1x\\y'],
    ['the work directory', 'C:\\programming\\Athena\\src\\harness\\permissions.ts'],
    ['a relative path in the work directory', 'src\\harness\\permissions.ts'],
    ['the user profile', 'C:\\Users\\owner\\Documents\\notes.md'],
    ['the Athena brain', 'C:\\Users\\owner\\.athena\\settings.json'],
    ['AppData', 'C:\\Users\\owner\\AppData\\Local\\Temp\\scratch.txt'],
    ['a non-system drive', 'D:\\Windows\\System32\\x'],
    ['a non-system drive Program Files', 'D:\\Program Files\\App\\x'],
    ['a UNC share that is not an admin share', '\\\\server\\projects\\Windows\\x'],
  ]
  it.each(allowed)('does not over-fence %s', (_label, target) => {
    expect(winFence().deniedRoot(target, CWD)).toBeNull()
  })

  it('names the root it matched', () => {
    expect(winFence().deniedRoot('C:\\Windows\\System32\\x', CWD)).toBe('C:\\WINDOWS')
    expect(winFence().deniedRoot('C:\\Program Files\\App\\x', CWD)).toBe('C:\\Program Files')
  })

  it('accepts extra directories from settings, additively', () => {
    const fence = winFence(['C:\\programming\\golden'])
    expect(fence.deniedRoot('C:\\programming\\golden\\x', CWD)).toBe('C:\\programming\\golden')
    // Extras never displace the defaults.
    expect(fence.deniedRoot('C:\\Windows\\System32\\x', CWD)).not.toBeNull()
    // ...nor widen to a sibling.
    expect(fence.deniedRoot('C:\\programming\\golden2\\x', CWD)).toBeNull()
  })

  it('is case-SENSITIVE on POSIX, where the filesystem is', () => {
    const fence = new ProtectedPaths(['/boot'], { platform: 'linux', env: {} })
    expect(fence.deniedRoot('/boot/vmlinuz', '/home/o/work')).toBe('/boot')
    expect(fence.deniedRoot('/boot/../boot/grub/x', '/home/o/work')).toBe('/boot')
    expect(fence.deniedRoot('/BOOT/vmlinuz', '/home/o/work')).toBeNull()
    expect(fence.deniedRoot('/bootloader/x', '/home/o/work')).toBeNull()
    expect(fence.deniedRoot('/home/o/work/boot/x', '/home/o/work')).toBeNull()
  })

  it('returns null for an empty fence rather than denying everything', () => {
    const fence = new ProtectedPaths([], { platform: 'win32', env: WIN_ENV })
    expect(fence.deniedRoot('C:\\Windows\\System32\\x', CWD)).toBeNull()
  })
})

describe('ProtectedPaths.scanCommand (best effort, documented as such)', () => {
  const fence = winFence()
  const scan = (command: string): string | null => fence.scanCommand(command, CWD)?.root ?? null

  const caught: Array<[label: string, command: string]> = [
    ['cmd delete', 'del C:\\Windows\\System32\\drivers\\etc\\hosts'],
    ['cmd rd', 'rd /s /q C:\\Windows\\System32'],
    ['posix rm', 'rm -rf C:/Windows/System32'],
    ['posix mv into the fence', 'mv ./payload.dll C:\\Windows\\System32\\payload.dll'],
    ['PowerShell Remove-Item with a quoted space', 'Remove-Item -Recurse -Force "C:\\Program Files\\App"'],
    ['PowerShell Set-Content', 'Set-Content -Path C:\\Windows\\System32\\x.txt -Value y'],
    ['output redirect', 'echo pwned > C:\\Windows\\System32\\x.txt'],
    ['append redirect', 'echo pwned >> C:\\Windows\\System32\\x.txt'],
    ['%VAR% expansion', 'del %SystemRoot%\\System32\\x'],
    ['$env: expansion', 'Remove-Item $env:SystemRoot\\System32\\x'],
    ['${env:} expansion', 'Remove-Item ${env:ProgramFiles}\\App\\x'],
    ['a later segment of a chain', 'git status && del C:\\Windows\\System32\\x'],
    ['a piped segment', 'echo hi | tee C:\\Windows\\System32\\x'],
    ['sudo prefix', 'sudo rm -rf C:/Windows/System32'],
    ['8.3 short name in a command', 'del C:\\PROGRA~1\\App\\x'],
    ['traversal in a command', 'del C:\\programming\\..\\Windows\\System32\\x'],
    ['takeown', 'takeown /f C:\\Windows\\System32\\x'],
  ]
  it.each(caught)('catches %s', (_label, command) => {
    expect(scan(command)).not.toBeNull()
  })

  const passed: Array<[label: string, command: string]> = [
    ['reading inside the fence', 'dir C:\\Windows\\System32'],
    ['PowerShell listing inside the fence', 'Get-ChildItem C:\\Windows\\System32'],
    ['cat inside the fence', 'cat C:\\Windows\\System32\\drivers\\etc\\hosts'],
    ['findstr inside the fence', 'findstr /s hosts C:\\Windows\\System32'],
    ['a fenced path inside an unrelated message', 'git commit -m "handle C:\\Windows\\System32 paths"'],
    ['deleting outside the fence', 'rm -rf C:\\programming\\scratch'],
    ['deleting a bare relative name', 'rm -rf node_modules'],
    ['deleting a relative path', 'rm -rf ./dist'],
    ['deleting in the user profile', 'Remove-Item -Recurse C:\\Users\\owner\\AppData\\Local\\Temp\\x'],
    ['a WindowsApps sibling', 'del C:\\WindowsApps\\pkg\\x'],
    ['an empty command', '   '],
  ]
  it.each(passed)('does not block %s', (_label, command) => {
    expect(scan(command)).toBeNull()
  })

  // These pin the DOCUMENTED holes. They are not aspirations: if one of them
  // starts passing, the doc that calls the scan "best effort, not a guarantee"
  // is what should change, not silently the claim.
  const knownMisses: Array<[label: string, command: string]> = [
    ['cd followed by a relative target', 'cd C:\\Windows\\System32 && del hosts'],
    ['an interpreter given inline source', 'node -e "require(\'fs\').rmSync(\'C:/Windows/System32/x\')"'],
    ['a shell variable resolved at runtime', 'set T=C:\\Windows\\System32 & del %T%\\x'],
    ['a mutating program not on the verb list', 'my-installer --target C:\\Windows\\System32'],
    ['a script file whose contents are never seen', 'powershell -File .\\wipe.ps1'],
  ]
  it.each(knownMisses)('is documented as NOT catching %s', (_label, command) => {
    expect(scan(command)).toBeNull()
  })
})

// One pass against the REAL machine environment. The suite above proves the
// normalization rules; this proves they are wired to the actual system paths on
// the platform that has them.
describe.runIf(process.platform === 'win32')('real Windows environment', () => {
  const fence = ProtectedPaths.defaults()

  it('fences the live %SystemRoot% and %ProgramFiles%', () => {
    const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
    expect(fence.deniedRoot(`${systemRoot}\\System32\\drivers\\etc\\hosts`, process.cwd())).not.toBeNull()
    expect(fence.deniedRoot(`${systemRoot}\\System32`, process.cwd())).not.toBeNull()
    const programFiles = process.env['ProgramFiles']
    if (programFiles) expect(fence.deniedRoot(`${programFiles}\\x`, process.cwd())).not.toBeNull()
  })

  it('leaves this repository and the user profile writable', () => {
    expect(fence.deniedRoot(process.cwd(), process.cwd())).toBeNull()
    expect(fence.deniedRoot('src/harness/permissions.ts', process.cwd())).toBeNull()
    const profile = process.env['USERPROFILE']
    if (profile) {
      expect(fence.deniedRoot(`${profile}\\.athena\\settings.json`, process.cwd())).toBeNull()
      expect(fence.deniedRoot(`${profile}\\Desktop\\notes.md`, process.cwd())).toBeNull()
    }
  })
})
