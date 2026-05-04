/**
 * Confabulation guard — verifies file:line citations in agent messages.
 *
 * Agents routinely cite specific lines (`useSSE.jsx:21`, `lib/auth.ts:142`).
 * Some of those citations are real, some are confabulated — the agent picked
 * a plausible-looking number that doesn't actually correspond to anything.
 * This guard scans messages for `<path>:<line>` patterns, resolves the path
 * against the worktree, and verifies the line is in range.
 *
 * Resolution strategy (W2.5 — production-tuned 2026-04-30):
 *   1. Direct resolve against `worktreePath` (full citation path).
 *   2. Direct resolve against each `fallbackPaths` entry (typically agent
 *      worktrees — VERIFY runs BEFORE merge, so files only exist in agent
 *      branches at that moment).
 *   3. Basename fallback — walk all roots, build basename → [paths] index.
 *      Citations like `DashboardPage.jsx:362` (without directory) resolve
 *      to whichever path matches the basename. If multiple matches, take
 *      MAX line count (most permissive — we'd rather miss a fake cite than
 *      cry wolf at a real one).
 *
 * Why this matters: production observation (collab 1781bdca, 2026-04-30)
 * showed claude-1 citing 5 valid file:line refs that all flagged as
 * confabulations because (a) cites were basename-only, (b) the cited files
 * were brand-new in codex-2's worktree, not yet merged into project root
 * scanned by the guard. Trust erodes if guard cries wolf — agents start
 * ignoring it.
 *
 * The guard remains permissive — only flags clear confabulations (basename
 * doesn't appear ANYWHERE, or line exceeds longest match). Doesn't verify
 * cited content matches the agent's claim (that needs LLM semantics).
 */

import fs from 'fs'
import path from 'path'

export interface CitationCheck {
  rawCitation: string  // exact substring matched (e.g. "lib/foo.ts:42")
  filePath: string
  line: number
  exists: boolean
  lineCount: number | null  // null if file doesn't exist OR too big to count
  inRange: boolean
}

const CODE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'rb', 'php',
  'sh', 'bash', 'zsh',
  'vue', 'svelte', 'astro',
  'css', 'scss', 'sass', 'less',
  'json', 'yml', 'yaml', 'toml', 'xml',
  'md', 'mdx', 'rst', 'txt',
  'sql', 'env',
  'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm',
]

// Match `<path>:<line>` where:
//   - path is at least 3 chars, contains code-ish chars only (alphanumerics,
//     /, ., _, -)
//   - path either contains a `/` (relative path) or ends in a known ext
//   - line is 1-99999
// We require either a leading word boundary OR the start of a line/quote so
// we don't capture inside log timestamps like 12:34 or version strings 1.2:3.
const CITATION_RE = /(^|[\s"'`([<])([A-Za-z0-9_./-]{3,256}\.[A-Za-z0-9]{1,8}):(\d{1,5})(?=\b|$|[\s"'`)\]>,.;:?!])/g

function isCodeExt(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase()
  return !!ext && CODE_EXTS.includes(ext)
}

// ───────────────────────────────────────────────────────────────────
// Basename indexing — walks worktree(s) once per scan, builds a
// basename → [paths] map so citations like `Foo.tsx:42` (no directory)
// can be resolved without forcing the agent to type full paths.
// ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.worktrees',
  '__pycache__', '.next', '.cache', '.venv', 'venv',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage',
  '.turbo', '.parcel-cache', 'target', '.gradle', '.idea', '.vscode',
])

const MAX_INDEXED_FILES = 50_000  // hard cap to bound walk cost

export interface SearchIndex {
  byBasename: Map<string, string[]>
  totalIndexed: number
}

export function buildSearchIndex(roots: string[]): SearchIndex {
  const byBasename = new Map<string, string[]>()
  let count = 0
  const seenRoots = new Set<string>()

  function walk(dir: string): void {
    if (count >= MAX_INDEXED_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      if (count >= MAX_INDEXED_FILES) return
      if (SKIP_DIRS.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile()) {
        count++
        const list = byBasename.get(e.name)
        if (list) list.push(full)
        else byBasename.set(e.name, [full])
      }
    }
  }

  for (const r of roots) {
    if (!r) continue
    const abs = path.resolve(r)
    if (seenRoots.has(abs)) continue
    seenRoots.add(abs)
    if (fs.existsSync(abs)) walk(abs)
  }

  return { byBasename, totalIndexed: count }
}

interface ResolveOpts {
  worktreePath: string
  fallbackPaths?: string[]
}

function resolveExistingFile(citationPath: string, opts: ResolveOpts): string | null {
  const candidates = [
    path.resolve(opts.worktreePath, citationPath),
    path.isAbsolute(citationPath) ? citationPath : null,
    ...(opts.fallbackPaths ?? []).map(root => path.resolve(root, citationPath)),
  ].filter((p): p is string => !!p)

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch { /* */ }
  }
  return null
}

function countLines(file: string): number {
  try {
    // Cap reading to avoid loading enormous files (rare for code). 5 MB
    // covers anything we'd realistically cite.
    const stat = fs.statSync(file)
    if (stat.size > 5_000_000) return -1  // signal "too big — trust"
    const content = fs.readFileSync(file, 'utf-8')
    if (!content) return 0
    // Count newlines; a file ending without a trailing \n still has the last line.
    let n = 1
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') n++
    // If the file ends with a \n, the "+1" we just counted is past-the-end.
    if (content[content.length - 1] === '\n') n--
    return n
  } catch {
    return -1
  }
}

export interface ScanCitationsInput {
  text: string
  worktreePath: string
  fallbackPaths?: string[]
  /** Pre-built basename index reused across many scanCitations calls in one VERIFY pass. Built on demand if absent. */
  searchIndex?: SearchIndex
}

export function scanCitations(input: ScanCitationsInput): CitationCheck[] {
  const out: CitationCheck[] = []
  const seen = new Set<string>()  // dedupe identical raw citations
  const re = new RegExp(CITATION_RE.source, CITATION_RE.flags)

  // Build (or reuse) the basename index — used as fallback when direct
  // resolve fails. Production showed agents typically cite by basename
  // (`DashboardPage.jsx:362`) without directory prefix.
  const index = input.searchIndex ?? buildSearchIndex(
    [input.worktreePath, ...(input.fallbackPaths ?? [])],
  )

  let match: RegExpExecArray | null
  while ((match = re.exec(input.text))) {
    const filePath = match[2]
    const line = parseInt(match[3], 10)
    const raw = `${filePath}:${line}`
    if (seen.has(raw)) continue
    seen.add(raw)

    // Filter: path must contain `/` OR have a known code-ish extension.
    if (!filePath.includes('/') && !isCodeExt(filePath)) continue
    // Also skip URLs that slipped through: typical pattern `http://...:port`.
    if (/^https?:\/\//i.test(filePath)) continue

    // Tier 1: direct resolve against worktreePath + fallbackPaths
    const resolved = resolveExistingFile(filePath, {
      worktreePath: input.worktreePath,
      fallbackPaths: input.fallbackPaths,
    })
    if (resolved) {
      const lc = countLines(resolved)
      if (lc === -1) {
        out.push({ rawCitation: raw, filePath, line, exists: true, lineCount: null, inRange: true })
      } else {
        out.push({
          rawCitation: raw, filePath, line,
          exists: true, lineCount: lc,
          inRange: line >= 1 && line <= lc,
        })
      }
      continue
    }

    // Tier 2: basename fallback — look up just the file name in the index
    const basename = path.basename(filePath)
    const candidates = index.byBasename.get(basename) ?? []
    if (candidates.length === 0) {
      // Truly missing — file with this basename doesn't exist anywhere we
      // searched. This is a real confabulation candidate.
      out.push({ rawCitation: raw, filePath, line, exists: false, lineCount: null, inRange: false })
      continue
    }
    // Found by basename — take the MAX line count across matches (most
    // permissive: if any version of the file has enough lines, we accept).
    let maxLineCount = 0
    let anyTooBig = false
    for (const p of candidates) {
      const lc = countLines(p)
      if (lc === -1) { anyTooBig = true; break }
      if (lc > maxLineCount) maxLineCount = lc
    }
    if (anyTooBig) {
      out.push({ rawCitation: raw, filePath, line, exists: true, lineCount: null, inRange: true })
    } else {
      out.push({
        rawCitation: raw, filePath, line,
        exists: true, lineCount: maxLineCount,
        inRange: line >= 1 && line <= maxLineCount,
      })
    }
  }
  return out
}

/**
 * Filter scan results to confabulations only — citations that don't resolve
 * to a real file:line in the worktree.
 */
export function findConfabulations(checks: CitationCheck[]): CitationCheck[] {
  return checks.filter(c => !c.exists || !c.inRange)
}

/**
 * Format a one-line warning for a confabulation. Used to inject into the
 * team feed so agents see it next time they read.
 */
export function formatConfabulationWarning(agentName: string, check: CitationCheck): string {
  if (!check.exists) {
    return `⚠️ confabulation: ${agentName} cited \`${check.rawCitation}\` — file not found in worktree (or any agent branch).`
  }
  return `⚠️ confabulation: ${agentName} cited \`${check.rawCitation}\` — file has ${check.lineCount} line${check.lineCount === 1 ? '' : 's'} in the longest version, line ${check.line} is out of range.`
}
