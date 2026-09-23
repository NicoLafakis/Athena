# Permissions and project trust

Two different knobs with similar names; they are deliberately separate, and one can
never impersonate the other.

## The two concepts

- **`permissionMode`** (`normal` | `acceptEdits` | `plan` | `trusted`) gates which tools
  may run, inside `PermissionEngine.check` (`src/harness/permissions.ts`). Precedence is
  fixed: **protected-paths fence** → resource-policy containment → read-only sandbox deny
  → hard deny rules → plan mode → read-only allow → allow rules/session grants → mode
  default. `trusted` is the only mode whose default auto-approves every mutating tool,
  shell included; the fence, hard deny rules, the resource policy, and
  `PermissionRequest` hooks still fire first at every mode.
- **Project trust** is a per-machine registry record (`src/harness/trust.ts`, keyed by
  the canonical path hash) answering "may this repository influence Athena?" — project
  instructions in the system prompt, project settings, hooks, and MCP servers. It says
  nothing, by itself, about which tools may run.

## The one-way coupling (trust bootstrap)

`resolveTrustBootstrap` (`src/harness/permissions.ts`) runs at composition time
(interactive TUI and `athena voice`; `athena exec` keeps its explicit flag-driven
defaults because it is the headless contract):

- An **explicit registry trust record** for the cwd plus the default `normal` mode →
  the session starts in `trusted` mode. The user's stored trust decision is the only
  thing that can raise the mode this way; a project can never do it for itself —
  `loadSettings` strips project-selected `trusted` mode and `unrestricted` sandbox with
  a warning (`src/brain/settings.ts`).
- The defaulted `trusted=true` a project *without* `.athena/` receives at boot is never
  used here — coupling to that default would make every directory on the machine
  shell-trusted.
- On **win32**, a trusted session with the default `workspace-write` sandbox resolves
  to `unrestricted`: Athena has no Windows sandbox backend, and every other mode makes
  the shell tool fail closed (`resolveSandboxedCommand`, `src/tools/shell.ts`). Linux
  and macOS keep `workspace-write` — bwrap/sandbox-exec provide real containment there.
- An explicit non-`normal` mode or non-default sandbox in the user's own global
  settings is respected unchanged.
- Whenever the bootstrap changes anything it prints one sentence naming the effective
  mode and sandbox (degrade-loudly; silent escalation reads as a bug).

The escape hatches stay in force: `/mode` switches live per session, deny rules still
deny, hooks still intercept, and `athena trust --revoke` removes the record.

## The protected-paths fence

`src/harness/protected-paths.ts`. An unconditional write fence over a small set of
operating-system directories, enforced at two independent points:
`PermissionEngine.check` (tier 0, above every other rule) and
`ResourcePolicy.resolvePath` (before the `unrestricted` early-out, so no sandbox mode
reaches past it). Both default to the environment-derived fence when a call site omits
one — a construction site that forgets the argument is still fenced.

It is a **path** fence, not a capability restriction. Nothing here removes the ability to
delete, move, or overwrite; it names *where* mutation is refused. Everywhere else — the
whole user profile, `~/.athena`, every project root, every scratch directory — is
untouched. Over-fencing is a failure mode, not a safe default: it breaks the
cross-directory workflow the fence exists to make safe.

Two properties are load-bearing:

- **Writes only.** Reads inside a protected directory stay allowed. Reading
  `C:\Windows\System32\drivers\etc\hosts` is harmless and occasionally necessary.
- **Unconditional.** `trusted` mode, an `unrestricted` sandbox, an `allow` rule, and a
  session grant all fail to open it. The guarantee does not depend on a mode being
  configured correctly.

### The default roots, and why each

Derived from the environment, never hardcoded to `C:` — the system drive is not
guaranteed to be `C:`, and a fence that assumes it protects nothing where it is not.

| Source | Root |
| --- | --- |
| `%SystemRoot%` (or `%windir%`) | `C:\Windows` — covers System32, WinSxS, the driver store |
| `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%` | installed application trees |
| `%ProgramData%` | machine-wide application state |
| `%SystemDrive%` (else the drive of `%SystemRoot%`, else `C:`) | `\System Volume Information`, `\Recovery`, `\Boot`, `\EFI` |

On POSIX the defaults are `/boot`, `/proc`, `/sys` (linux) and `/System` (darwin).
`/usr`, `/usr/local`, and `/opt` are deliberately **absent**: Homebrew, nvm, and pnpm live
there, and fencing them would break ordinary development for no OS-integrity gain.

`protectedPaths` in `settings.json` adds directories. It is a list of path prefixes, not
a rule language, and it is **additive only** — entries extend the defaults and can never
shrink them. That is why it concatenates global-then-project like `deny`, instead of
being stripped from project settings the way `trusted`/`unrestricted` are: no shape of
project settings can remove a protected directory, so a project can only harden.

### Normalization: where a naive fence would fail

A `startsWith` check would be security theater. Matching is on whole path **segments**
after normalization, so `C:\Windows` blocks `C:\Windows\System32` and does not touch
`C:\WindowsApps`. Handled and tested (`tests/harness/protected-paths.test.ts`):
case-insensitivity on win32, `/` vs `\`, `..` traversal, drive-relative (`C:..\..\x`) and
root-relative (`\Windows\x`) forms, trailing dots and spaces on a segment, device and
extended-length prefixes (`\\?\`, `\\.\`, `\??\`, including stacked and `\\?\UNC\`),
administrative shares (`\\host\C$\Windows`), 8.3 short names (`C:\PROGRA~1`), and symlinks
or junction aliases on either side of a comparison. Existing configured roots are indexed
under both their lexical and `realpathSync.native` forms; file-write targets are
canonicalized before comparison, and shell targets retain their lexical form. When a
configured root cannot be resolved, its lexical path still provides the fallback fence.
Keeping both root forms covers OS temporary or protected directories exposed through an
alias.

### Shell commands are the honest weak point

`ProtectedPaths.scanCommand` is a **best-effort scan, not a guarantee, and must not be
described as one.** A shell command carries its target inside an opaque string, so the
scan is pattern-matching. It flags a fenced path that is either the target of a `>`/`>>`
redirect or an argument to a command on a fixed mutating-verb list (`rm`, `del`,
`Remove-Item`, `takeown`, …), expanding `%VAR%` / `$env:VAR` first. Reads (`dir`, `cat`,
`Get-ChildItem`) pass through.

It is defeated by, at minimum: `cd` into a protected directory followed by a relative
path, variables resolved at runtime, an interpreter given inline source (`node -e`,
`python -c`), encoded commands, a script file whose contents are never seen, a mutating
program not on the verb list, and any renamed binary. Those specific holes are pinned by
tests so the limitation stays checkable rather than drifting into an implied guarantee.

**The primary defense for `C:\Windows\System32` is the Windows ACL, not this scan.**
Verified against Microsoft documentation: System32, `C:\Program Files`, and
`C:\Program Files (x86)` are owned by `NT SERVICE\TrustedInstaller`; `BUILTIN\Users` holds
only `(RX)`, and an unelevated process — including an administrator's *filtered* token,
where the Administrators SID is marked deny-only — cannot write there. Windows Resource
Protection is the ACL-based successor to Windows File Protection and covers protected
files and registry keys. Three accuracy notes worth keeping straight, because the
convenient version of each is wrong:

- Administrators have `(RX)` on protected **files** but `Modify` on the System32
  **directory** — "read-execute on System32" as a blanket claim is false.
- `C:\ProgramData` is **not** protected the way Program Files is. Its default DACL grants
  `BUILTIN\Users:(CI)(WD,AD,WEA,WA)`, so a standard user *can* create files and folders
  there; hardening comes from specific subdirectories (e.g. `\Microsoft`) blocking that
  inheritance. Athena fences it anyway, which is deliberately stricter than the OS.
- TrustedInstaller ownership is an accident guard, not a security boundary against a local
  admin: `SeTakeOwnershipPrivilege` and `SeRestorePrivilege` both let an elevated
  administrator through.

This fence is defense in depth on top of those ACLs. What it does **not** protect
against: a shell command the scan does not recognize, anything Athena runs elevated,
damage done through a process Athena starts but does not mediate (installers, package
managers, `git` hooks), destruction *outside* the fence — which is intentional and fully
available — and any path reached through an OS interface that is not a file path.

### Checking the posture

`athena doctor` reports two checks so the state is verifiable rather than assumed:
`permission-posture` (the effective `permissionMode`/`sandboxMode` after the trust
bootstrap, and in plain words whether mutating tools prompt) and `protected-paths` (every
fenced directory, and that reads there are still allowed).
