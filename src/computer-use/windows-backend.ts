import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface ComputerUseProbeResult {
  available: boolean
  backend: string
  detail: string
  recoveryCommand: string
}

export type ComputerAction =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }> }
  | { type: 'scroll'; x: number; y: number; scrollX: number; scrollY: number }
  | { type: 'type'; text: string }
  | { type: 'keypress'; keys: string[] }
  | { type: 'wait'; ms?: number }
  | { type: 'screenshot' }

export interface ComputerBackend {
  captureScreenshot(signal?: AbortSignal): Promise<Buffer>
  executeAction(action: ComputerAction, signal?: AbortSignal): Promise<void>
  getActiveWindowTitle(signal?: AbortSignal): Promise<string>
}

const KEY_MAP: Record<string, string> = {
  CTRL: '^',
  CONTROL: '^',
  ALT: '%',
  SHIFT: '+',
  META: '^{ESC}',
  ENTER: '{ENTER}',
  RETURN: '{ENTER}',
  TAB: '{TAB}',
  BACKSPACE: '{BACKSPACE}',
  DELETE: '{DELETE}',
  ESC: '{ESC}',
  ESCAPE: '{ESC}',
  ARROWLEFT: '{LEFT}',
  ARROWRIGHT: '{RIGHT}',
  ARROWUP: '{UP}',
  ARROWDOWN: '{DOWN}',
  HOME: '{HOME}',
  END: '{END}',
  PAGEUP: '{PGUP}',
  PAGEDOWN: '{PGDN}',
}

export function normalizeCuaKey(key: string): string {
  const upper = key.trim().toUpperCase()
  return KEY_MAP[upper] ?? key
}

let cachedProbe: ComputerUseProbeResult | null = null

function resolvePowerShellExe(): string {
  const candidates = [
    process.env['SystemRoot']
      ? `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : null,
    'powershell.exe',
    'pwsh.exe',
  ].filter((c): c is string => Boolean(c))
  for (const candidate of candidates) {
    if (!candidate.includes('\\') || existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * Prove Windows screen-capture and input-assembly capability by round-tripping
 * a real 1x1 PNG bitmap sentinel through PowerShell System.Drawing (AGENTS.md §4).
 */
export function probeComputerUseBackend(
  platform: NodeJS.Platform = process.platform,
  options: { skipCache?: boolean; timeoutMs?: number } = {},
): ComputerUseProbeResult {
  if (!options.skipCache && cachedProbe && platform === process.platform) {
    return cachedProbe
  }
  if (platform !== 'win32') {
    return {
      available: false,
      backend: 'unsupported',
      detail: `Computer use backend currently targets Windows; platform '${platform}' is unsupported.`,
      recoveryCommand: 'Run Athena on Windows or disable computer use.',
    }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$bmp = New-Object System.Drawing.Bitmap 1, 1',
    '$ms = New-Object System.IO.MemoryStream',
    '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($ms.ToArray())',
    '$ms.Dispose(); $bmp.Dispose()',
  ].join('; ')

  const result = spawnSync(
    resolvePowerShellExe(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs ?? 8_000,
    },
  )

  let probe: ComputerUseProbeResult
  if (result.status !== 0) {
    probe = {
      available: false,
      backend: 'windows-forms-sendinput',
      detail: `Windows capture probe failed: ${(result.stderr || result.error?.message || 'non-zero exit').trim()}`,
      recoveryCommand: 'Verify PowerShell with System.Drawing and System.Windows.Forms is accessible, then re-run `athena doctor`.',
    }
  } else {
    const raw = (result.stdout ?? '').trim()
    const bytes = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0)
    const isPng =
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    probe = isPng
      ? {
          available: true,
          backend: 'windows-forms-sendinput',
          detail: 'Probed System.Drawing PNG capture and System.Windows.Forms input assembly via sentinel round trip.',
          recoveryCommand: 'Run `athena doctor` to re-verify Windows computer-use availability.',
        }
      : {
          available: false,
          backend: 'windows-forms-sendinput',
          detail: 'Windows capture probe did not return valid PNG sentinel bytes.',
          recoveryCommand: 'Verify .NET System.Drawing assembly availability and re-run `athena doctor`.',
        }
  }

  if (platform === process.platform) cachedProbe = probe
  return probe
}
