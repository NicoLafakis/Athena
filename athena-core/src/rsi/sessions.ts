/**
 * Seam 1 — transcript access + shape (ADR 0001, Phase 3).
 *
 * Ares reads `~/.claude/projects/<slug>/*.jsonl` directly. This module is the
 * adapter the ADR calls for: a `getSessions()` / `readSessionSnapshot()` layer
 * over that log format, so the RSI loops (and any capture hook) depend on THIS
 * shape, not the raw CLI transcript format. If the log format moves, only this
 * file changes.
 *
 * It ports the intent of `journal_capture._scan_transcript` (the Ares episodic
 * substrate): stream a transcript once and distill it into a compact, factual
 * snapshot —
 *   { sessionId, project, date, intent, toolCalls, files, commits, lastActive, cwd }
 * — where `intent` is the first real user message (capped), `files` come from the
 * edit tools' `tool_use` inputs, and `commits` come from `git commit -m` in Bash
 * `tool_use` commands.
 *
 * Everything here is filesystem-only: no network, no key, no model turn. Paths
 * reuse `aresConfig.sanitizeCwd` / `resolveMemoryDir` conventions; the projects
 * root is injectable (default the resolved Ares home).
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveAresHome } from '../config/aresConfig.js';

// --- caps (ported from journal_capture.py tunables) -----------------------
/** First-user-message intent is capped to this many chars. */
export const INTENT_MAX = 140;
/** Max distinct edited files retained per snapshot. */
export const MAX_FILES = 60;
/** Max commit messages retained per snapshot. */
export const MAX_COMMITS = 40;
/** Above this transcript size, do a shallow scan (count tool calls only, skip files/commits). */
export const TRANSCRIPT_MAX_BYTES = 25 * 1024 * 1024;
/** Default reflection window (days). */
export const DEFAULT_WINDOW_DAYS = 7;
/** Default cap on sessions returned by {@link getSessions}. */
export const DEFAULT_MAX_SESSIONS = 60;

const MS_PER_DAY = 86_400_000;

/** Tools whose `tool_use.input.file_path` (or `notebook_path`) is a touched file. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * `git ... commit ... -m <quote>msg<quote>` — ported from journal_capture's
 * `_COMMIT_RE`. `git`/`commit`/`-m` stay on one line (`[^\n]*`); the message may
 * span lines (`[\s\S]`) but we keep only its first line. Global + case-insensitive.
 */
const COMMIT_RE = /git\b[^\n]*\bcommit\b[^\n]*?-m\s+(['"])([\s\S]+?)\1/gi;

/** One distilled session — the Seam-1 shape the RSI loops consume. */
export type SessionSnapshot = {
  /** Transcript stem (the CLI session id). */
  sessionId: string;
  /** Project label (from cwd basename, or slug fallback; `hub` for the `.claude` home). */
  project: string;
  /** Human date `YYYY-MM-DD HH:MM` derived from {@link lastActive} (local time). */
  date: string;
  /** First real user message, whitespace-collapsed and capped to {@link INTENT_MAX}. Empty if none. */
  intent: string;
  /** Count of assistant `tool_use` blocks. */
  toolCalls: number;
  /** Absolute paths from edit-tool `tool_use` inputs (deduped, order-preserved, capped). */
  files: string[];
  /** `git commit -m` messages parsed from Bash `tool_use` commands (first line each, capped). */
  commits: string[];
  /** Epoch ms of last activity (the transcript file's mtime). */
  lastActive: number;
  /** Working dir pulled from the transcript (first event that carries one), if any. */
  cwd?: string;
};

/** Format an epoch-ms instant as `YYYY-MM-DD HH:MM` (local), mirroring the Ares digest date. */
export function formatSnapshotDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/**
 * Derive a project label from an encoded `projects/<slug>` dir name, e.g.
 * `C--programming--ProvenLabs-...-ProvenContacts` → `ProvenContacts`. The Ares
 * hub (`~/.claude`, no `programming` segment) collapses to `hub`. Ported from
 * `cross_project_reflect._project_from_slug`.
 */
export function projectFromSlug(slug: string): string {
  const tail = slug.split('-').filter(Boolean).pop() ?? slug;
  const lower = slug.toLowerCase();
  if (lower.includes('claude') && !lower.includes('programming')) return 'hub';
  return tail;
}

/**
 * Derive a project label from a working dir: its last path segment, or `hub` when
 * that segment is `.claude`. Cross-platform (handles `\` and `/`). Mirrors the
 * intent of `journal_capture._project_name` without requiring the dir to exist
 * locally (no git-root probe — the authoring container can't see Windows repos).
 */
export function projectFromCwd(cwd: string): string {
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? cwd;
  return base === '.claude' ? 'hub' : base;
}

/** Extract `git commit -m` messages from a Bash command, dropping heredoc/substitution noise. */
function parseCommitMessages(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(COMMIT_RE)) {
    const msg = (m[2].split('\n')[0] ?? '').trim();
    if (!msg || msg.startsWith('$(') || msg.includes('<<') || msg.includes('EOF') || msg.includes('`')) {
      continue;
    }
    out.push(msg.slice(0, 100));
  }
  return out;
}

/** Pull the text out of a user message's `content` (string or block array). */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join(' ');
  }
  return '';
}

export type ReadSessionSnapshotOptions = {
  /** Override the session id (default: the file's basename without `.jsonl`). */
  sessionId?: string;
  /** Override lastActive (default: the file's mtime). Injectable for deterministic tests. */
  lastActive?: number;
  /** Fallback project label when the transcript carries no cwd (e.g. the slug label). */
  fallbackProject?: string;
};

/**
 * Read one transcript file into a {@link SessionSnapshot}. Streams the JSONL once
 * (readline) so large backlogs don't blow up memory, and never throws — an
 * unreadable/garbage transcript yields a mostly-empty snapshot.
 *
 * Scale guard (ported from journal_capture): above {@link TRANSCRIPT_MAX_BYTES}
 * the scan stays shallow — it still counts tool calls and reads intent/cwd, but
 * skips the per-tool file/commit extraction.
 */
export async function readSessionSnapshot(
  transcriptPath: string,
  opts: ReadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const sessionId = opts.sessionId ?? basename(transcriptPath).replace(/\.jsonl$/i, '');
  let lastActive = opts.lastActive;
  let deep = true;
  if (lastActive === undefined) {
    try {
      const st = statSync(transcriptPath);
      lastActive = st.mtimeMs;
      deep = st.size <= TRANSCRIPT_MAX_BYTES;
    } catch {
      lastActive = Date.now();
    }
  }

  let intent = '';
  let cwd: string | undefined;
  let toolCalls = 0;
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const commits: string[] = [];

  try {
    const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) continue;
        let ev: unknown;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const e = ev as { type?: string; cwd?: string; message?: { content?: unknown } };

        if (cwd === undefined && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;

        const content = e.message?.content;

        // first real user message -> intent (skip tool-result / system-reminder wrappers)
        if (!intent && e.type === 'user') {
          const t = userText(content).replace(/\s+/g, ' ').trim();
          if (t && !t.startsWith('<')) intent = t.slice(0, INTENT_MAX);
        }

        // assistant tool_use blocks -> counts, files, commits
        if (e.type === 'assistant' && Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object' || (b as { type?: string }).type !== 'tool_use') continue;
            toolCalls += 1;
            if (!deep) continue;
            const block = b as { name?: string; input?: Record<string, unknown> };
            const name = block.name ?? '';
            const input = block.input ?? {};
            if (EDIT_TOOLS.has(name)) {
              const fp = (input.file_path ?? input.notebook_path) as string | undefined;
              if (fp && !seenFiles.has(fp)) {
                seenFiles.add(fp);
                files.push(fp);
              }
            } else if (name === 'Bash') {
              const cmd = (input.command as string | undefined) ?? '';
              for (const c of parseCommitMessages(cmd)) commits.push(c);
            }
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    // fall through with whatever we gathered
  }

  const project = cwd ? projectFromCwd(cwd) : opts.fallbackProject ?? 'unknown';

  return {
    sessionId,
    project,
    date: formatSnapshotDate(lastActive),
    intent,
    toolCalls,
    files: files.slice(0, MAX_FILES),
    commits: commits.slice(0, MAX_COMMITS),
    lastActive,
    cwd,
  };
}

export type GetSessionsOptions = {
  /** Ares/`.claude` home whose `projects/` tree holds the transcripts (default {@link resolveAresHome}). */
  root?: string;
  /** Only sessions active within this many days are returned (default {@link DEFAULT_WINDOW_DAYS}). */
  days?: number;
  /** Injectable clock (default `Date.now()`) — drives the window cutoff deterministically. */
  now?: number;
  /** Cap on returned sessions, most-recent first (default {@link DEFAULT_MAX_SESSIONS}). */
  maxSessions?: number;
  /** Skip any slug or project label containing one of these substrings (case-insensitive). */
  exclude?: string[];
};

/**
 * Enumerate `<root>/projects/<slug>/*.jsonl`, distill each recent transcript into
 * a {@link SessionSnapshot}, and return them most-recent-first (capped). Sessions
 * outside the `days` window (by transcript mtime) are skipped, as are empty ones
 * (no intent AND no tool calls) — the "trivial session" filter from
 * `cross_project_reflect._harvest_transcripts`.
 */
export async function getSessions(opts: GetSessionsOptions = {}): Promise<SessionSnapshot[]> {
  const root = opts.root ?? resolveAresHome();
  const days = opts.days ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? Date.now();
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const exclude = (opts.exclude ?? []).map((x) => x.toLowerCase());
  const cutoff = now - days * MS_PER_DAY;

  const projectsDir = join(root, 'projects');
  if (!existsSync(projectsDir)) return [];

  const excluded = (s: string) => exclude.some((x) => s.toLowerCase().includes(x));

  const snapshots: SessionSnapshot[] = [];
  let slugDirs: string[];
  try {
    slugDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const slug of slugDirs) {
    if (excluded(slug)) continue;
    const slugPath = join(projectsDir, slug);
    let isDir = false;
    try {
      isDir = statSync(slugPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    let files: string[];
    try {
      files = readdirSync(slugPath).filter((f) => f.toLowerCase().endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const f of files) {
      const tpath = join(slugPath, f);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(tpath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;

      const snap = await readSessionSnapshot(tpath, {
        lastActive: mtimeMs,
        fallbackProject: projectFromSlug(slug),
      });
      if (!snap.intent && snap.toolCalls === 0) continue; // trivial session
      if (excluded(snap.project)) continue;
      snapshots.push(snap);
    }
  }

  snapshots.sort((a, b) => b.lastActive - a.lastActive);
  return snapshots.slice(0, maxSessions);
}
