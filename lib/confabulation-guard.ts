/**
 * Confabulation guard — verifies file:line citations in agent messages.
 *
 * Agents routinely cite specific lines (`useSSE.jsx:21`, `lib/auth.ts:142`).
 * Some of those citations are real, some are confabulated — the agent picked
 * a plausible-looking number that doesn't actually correspond to anything.
 * This guard scans messages for `<path>:<line>` patterns, resolves the path
 * against the worktree, and verifies the line is in range.
 *
 * Strategy:
 *   • Match `path/to/file.ext:NN` patterns where ext is a code-ish extension
 *     (ts, tsx, js, jsx, py, go, rs, java, rb, php, sh, vue, svelte, json,
 *     yml, yaml, md, toml). Avoid matching URLs / version strings / time
 *     stamps by requiring the path token to look filesystem-y (contain `/`
 *     or end in a known ext).
 *   • Resolve relative to worktree root. If absent, also try the parent repo
 *     root (some agents quote relative-to-repo paths even from a worktree).
 *   • If file exists, count lines; flag if cited line > line count.
 *   • If file missing, flag it.
 *
 * The guard is permissive — it only flags clear confabulations (file does not
 * exist or line is out of range). It does NOT verify that the cited content
 * matches the agent's claim — that would require LLM semantics. The point is
 * to catch the easy fabrications (numbers pulled out of the air); deeper
 * citation auditing is a future enhancement.
 */

import fs from 'fs'
import path from 'path'

export interface CitationCheck {
  rawCitation: string  // exact substring matched (e.g. "lib/foo.ts:42")
  filePath: string
  line: number
  exists: boolean
  lineCount: number | null  // null if file doesn't exist
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
const CITATION_RE = /(^|[\s"'`(\[<])([A-Za-z0-9_\-./]{3,256}\.[A-Za-z0-9]{1,8}):(\d{1,5})(?=\b|$|[\s"'`)\]>,.;:?!])/g

function isCodeExt(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase()
  return !!ext && CODE_EXTS.includes(ext)
}

interface ResolveOpts {
  worktreePath: string
  fallbackPaths?: string[]  // additional roots to try (e.g. parent repo)
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
}

export function scanCitations(input: ScanCitationsInput): CitationCheck[] {
  const out: CitationCheck[] = []
  const seen = new Set<string>()  // dedupe identical raw citations
  const re = new RegExp(CITATION_RE.source, CITATION_RE.flags)
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

    const resolved = resolveExistingFile(filePath, {
      worktreePath: input.worktreePath,
      fallbackPaths: input.fallbackPaths,
    })
    if (!resolved) {
      out.push({ rawCitation: raw, filePath, line, exists: false, lineCount: null, inRange: false })
      continue
    }
    const lineCount = countLines(resolved)
    if (lineCount === -1) {
      // File too big or unreadable — assume in range (don't cry wolf).
      out.push({ rawCitation: raw, filePath, line, exists: true, lineCount: null, inRange: true })
      continue
    }
    out.push({
      rawCitation: raw, filePath, line,
      exists: true, lineCount,
      inRange: line >= 1 && line <= lineCount,
    })
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
    return `⚠️ confabulation: ${agentName} cited \`${check.rawCitation}\` — file not found in worktree.`
  }
  return `⚠️ confabulation: ${agentName} cited \`${check.rawCitation}\` — file has ${check.lineCount} line${check.lineCount === 1 ? '' : 's'}, line ${check.line} is out of range.`
}
