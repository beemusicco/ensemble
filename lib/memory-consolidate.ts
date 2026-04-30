/**
 * Memory consolidation pass — finds near-duplicate memories and merges them.
 *
 * Why: after several months of running collabs, the global memory store
 * accumulates near-duplicates from auto-extraction (e.g. five lessons all
 * saying "test_minimax_pull stale assertion at line 159, sync with adapter").
 * The top-K semantic match returns whichever one is recent, but the others
 * still take pool slots and dilute IDF weights.
 *
 * Strategy:
 *   1. Group candidates by project (using existing PROJECT_DOMAIN_TAGS rollup
 *      semantics). Memories with no project tag fall into a single bucket.
 *   2. Within a bucket, compute pairwise semantic similarity (same Jaccard +
 *      IDF approach as queryMemoriesSemantic, but applied across the bucket).
 *   3. Build clusters via union-find: any pair with similarity > threshold
 *      forms an edge.
 *   4. For each cluster of size ≥ 2, ask Haiku to merge them into one
 *      canonical entry — preserving citations, picking the most specific
 *      claim, deduping tags.
 *   5. Default: DRY RUN — just emit the proposal report. With `--apply`,
 *      write the merged entry and delete the originals.
 *
 * No silent state changes — this is destructive on `--apply`. Operator-driven
 * by design (cron or manual). The dry-run output is the contract.
 */

import { spawn } from 'child_process'
import { queryMemories, deleteMemory, writeMemory, type MemoryRecord } from './memory-store'

interface BucketKey {
  project: string
}

const SIMILARITY_THRESHOLD = 0.55  // tuned for the existing memory shape — high enough to catch true dups
const MAX_CLUSTER_SIZE = 8         // anything bigger likely conflates topics; better to leave alone
const MAX_BUCKETS_PER_PASS = 50    // hard cap to bound work per cron cycle
const MAX_TOKENS_FROM_BODY = 80
const HAIKU_TIMEOUT_MS = 60_000

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','when','to','of','in','on','at','for','with','by','as',
  'is','are','was','were','be','been','being','have','has','had','do','does','did','done','this','that','these','those',
  'it','its','we','you','they','i','he','she','what','which','who','how','why','where','about','from','into','out','over',
])

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./:-]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 60 && !STOPWORDS.has(t))
}

function memTokens(m: MemoryRecord): Set<string> {
  const tagTokens = m.tags.flatMap(t => tokenize(t))
  const keyTokens = tokenize(m.key)
  const bodyTokens = tokenize(m.value).slice(0, MAX_TOKENS_FROM_BODY)
  return new Set([...keyTokens, ...tagTokens, ...bodyTokens])
}

interface ProjectBucketing {
  buckets: Map<string, MemoryRecord[]>
  totalScanned: number
}

function bucketByProject(records: MemoryRecord[], projectDomainTags: Map<string, Set<string>>): ProjectBucketing {
  // Map every project's domain tag → project name for fast classification.
  const tagToProject = new Map<string, string>()
  for (const [project, tags] of projectDomainTags) {
    for (const t of tags) tagToProject.set(t.toLowerCase(), project)
  }

  const buckets = new Map<string, MemoryRecord[]>()
  for (const r of records) {
    let project = '__unknown__'
    for (const t of r.tags) {
      const hit = tagToProject.get(t.toLowerCase())
      if (hit) { project = hit; break }
    }
    if (!buckets.has(project)) buckets.set(project, [])
    buckets.get(project)!.push(r)
  }
  return { buckets, totalScanned: records.length }
}

interface Cluster {
  project: string
  members: MemoryRecord[]
  averageSimilarity: number
}

function findClusters(bucket: MemoryRecord[], project: string): Cluster[] {
  if (bucket.length < 2) return []
  const tokens = bucket.map(memTokens)
  const docFreq = new Map<string, number>()
  for (const ts of tokens) for (const tok of ts) docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1)
  const N = bucket.length
  const idf = (tok: string): number => Math.log(1 + N / (1 + (docFreq.get(tok) ?? 0)))

  const sim = (i: number, j: number): number => {
    const a = tokens[i], b = tokens[j]
    let inter = 0, union = 0
    for (const tok of a) {
      if (b.has(tok)) inter += idf(tok)
      union += idf(tok)
    }
    for (const tok of b) {
      if (!a.has(tok)) union += idf(tok)
    }
    return union === 0 ? 0 : inter / union
  }

  // Union-find — connect pairs above the threshold; emit clusters.
  const parent = bucket.map((_, i) => i)
  const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]))
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  const edges: Array<{ i: number; j: number; s: number }> = []
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const s = sim(i, j)
      if (s >= SIMILARITY_THRESHOLD) {
        edges.push({ i, j, s })
        union(i, j)
      }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < N; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(i)
  }
  const clusters: Cluster[] = []
  for (const [, idxs] of groups) {
    if (idxs.length < 2 || idxs.length > MAX_CLUSTER_SIZE) continue
    const members = idxs.map(k => bucket[k])
    const pairs: number[] = []
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        pairs.push(sim(idxs[i], idxs[j]))
      }
    }
    const avg = pairs.length > 0 ? pairs.reduce((s, x) => s + x, 0) / pairs.length : 0
    clusters.push({ project, members, averageSimilarity: Number(avg.toFixed(3)) })
  }
  return clusters
}

interface MergedMemory {
  key: string
  value: string
  tags: string[]
}

async function askHaikuToMerge(cluster: Cluster): Promise<MergedMemory | null> {
  const lines = cluster.members.map((m, i) => {
    const tags = m.tags.length ? `[${m.tags.join(',')}]` : '[]'
    return `${i + 1}. key=${m.key} ${tags}\n   ${m.value.slice(0, 500)}`
  }).join('\n')

  const prompt = [
    `You are merging ${cluster.members.length} near-duplicate memories from a multi-agent collab system.`,
    `They appear in project bucket "${cluster.project}".`,
    ``,
    `Output ONLY JSON. Schema: { "key": "...", "value": "...", "tags": ["...", "..."] }`,
    ``,
    `Rules:`,
    `  - "key": snake_case slug, ≤60 chars, more general than any individual key (e.g. avoid one team's id)`,
    `  - "value": ONE merged claim ≤500 chars. Preserve every concrete file path, line number, command, version, and exit code. Drop generic platitudes.`,
    `  - "tags": union of all input tags, deduplicated, plus add "consolidated"`,
    `  - If the inputs disagree on a fact, pick the MOST SPECIFIC one and keep both citations`,
    `  - If they truly are different topics that just share keywords, output { "skip": true }`,
    ``,
    `Memories:`,
    lines,
  ].join('\n')

  let stdout = ''
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', ['--model', 'haiku', '-p', prompt], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      proc.stdout.on('data', d => chunks.push(d as Buffer))
      proc.stderr.on('data', d => errChunks.push(d as Buffer))
      const killer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* */ }
        reject(new Error(`claude haiku timed out after ${HAIKU_TIMEOUT_MS}ms`))
      }, HAIKU_TIMEOUT_MS)
      proc.on('error', err => { clearTimeout(killer); reject(err) })
      proc.on('close', code => {
        clearTimeout(killer)
        if (code !== 0) {
          reject(new Error(`claude haiku exit=${code}: ${Buffer.concat(errChunks).toString('utf-8').slice(0, 200)}`))
          return
        }
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })
      proc.stdin.end()
    })
  } catch (err) {
    console.warn(`[memory-consolidate] Haiku call failed: ${(err as Error).message}`)
    return null
  }

  // Parse — accept JSON-only or JSON inside fenced block.
  const jsonMatch = stdout.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    if (parsed.skip === true) return null
    if (typeof parsed.key !== 'string' || typeof parsed.value !== 'string') return null
    const tags = Array.isArray(parsed.tags) ? (parsed.tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
    return {
      key: parsed.key.slice(0, 80).replace(/\s+/g, '_'),
      value: parsed.value.slice(0, 600),
      tags: [...new Set([...tags, 'consolidated'])].slice(0, 12),
    }
  } catch {
    return null
  }
}

export interface ConsolidationProposal {
  cluster: Cluster
  merged: MergedMemory | null  // null if Haiku declined or call failed
}

export interface ConsolidationReport {
  scannedRecords: number
  bucketsExamined: number
  clustersFound: number
  proposals: ConsolidationProposal[]
  applied: boolean
  applyResults?: Array<{ mergedId: string; deletedIds: string[] }>
}

export interface ConsolidationOptions {
  /** Project domain tags map — same as PROJECT_DOMAIN_TAGS in service. */
  projectDomainTags: Map<string, Set<string>>
  /** Apply the merges (delete originals, write merged). Default: dry-run. */
  apply?: boolean
  /** Cap how many clusters we send to Haiku (cost control). Default 12. */
  maxClusters?: number
}

export async function runConsolidation(
  opts: ConsolidationOptions,
): Promise<ConsolidationReport> {
  // Pull the largest pool memory-store will give us in one query. Most stores
  // are well under 2000 entries; this is a single SQLite scan.
  const records = queryMemories({ scope: 'global', limit: 2000 })
  const { buckets } = bucketByProject(records, opts.projectDomainTags)

  const examined = Math.min(buckets.size, MAX_BUCKETS_PER_PASS)
  const allClusters: Cluster[] = []
  let i = 0
  for (const [project, bucket] of buckets) {
    if (i >= MAX_BUCKETS_PER_PASS) break
    i++
    const clusters = findClusters(bucket, project)
    allClusters.push(...clusters)
  }
  // Sort by average similarity descending — most-confident dups first.
  allClusters.sort((a, b) => b.averageSimilarity - a.averageSimilarity)

  const cap = opts.maxClusters ?? 12
  const examined_clusters = allClusters.slice(0, cap)

  const proposals: ConsolidationProposal[] = []
  for (const cluster of examined_clusters) {
    const merged = await askHaikuToMerge(cluster)
    proposals.push({ cluster, merged })
  }

  const report: ConsolidationReport = {
    scannedRecords: records.length,
    bucketsExamined: examined,
    clustersFound: allClusters.length,
    proposals,
    applied: !!opts.apply,
  }

  if (!opts.apply) return report

  const applyResults: NonNullable<ConsolidationReport['applyResults']> = []
  for (const p of proposals) {
    if (!p.merged) continue
    const written = writeMemory({
      scope: 'global',
      key: p.merged.key,
      value: p.merged.value,
      tags: p.merged.tags,
    })
    const deletedIds: string[] = []
    for (const m of p.cluster.members) {
      if (deleteMemory(m.id)) deletedIds.push(m.id)
    }
    applyResults.push({ mergedId: written.id, deletedIds })
  }
  report.applyResults = applyResults
  return report
}

export function formatConsolidationReport(report: ConsolidationReport): string {
  const lines: string[] = []
  lines.push(`🧹 memory consolidation${report.applied ? ' (APPLIED)' : ' (dry-run)'}`)
  lines.push(`   scanned: ${report.scannedRecords} memories across ${report.bucketsExamined} project bucket(s)`)
  lines.push(`   clusters found: ${report.clustersFound} (proposals returned: ${report.proposals.length})`)
  lines.push('')
  if (report.proposals.length === 0) {
    lines.push('   (no near-duplicate clusters above threshold)')
    return lines.join('\n')
  }
  for (let i = 0; i < report.proposals.length; i++) {
    const p = report.proposals[i]
    lines.push(`── cluster ${i + 1} — project=${p.cluster.project}, avg_sim=${p.cluster.averageSimilarity}, members=${p.cluster.members.length}`)
    for (const m of p.cluster.members) {
      lines.push(`   • ${m.key}  ${m.tags.length ? `[${m.tags.slice(0, 4).join(',')}]` : ''}`)
      lines.push(`       ${m.value.slice(0, 200)}${m.value.length > 200 ? '…' : ''}`)
    }
    if (p.merged) {
      lines.push(`   → merged proposal:`)
      lines.push(`     key:   ${p.merged.key}`)
      lines.push(`     tags:  [${p.merged.tags.join(',')}]`)
      lines.push(`     value: ${p.merged.value.slice(0, 300)}`)
    } else {
      lines.push(`   → Haiku declined (different topics or call failed)`)
    }
  }
  if (report.applied && report.applyResults) {
    lines.push('')
    lines.push(`✅ applied: ${report.applyResults.length} merges, ${report.applyResults.reduce((n, r) => n + r.deletedIds.length, 0)} originals deleted`)
  } else if (!report.applied) {
    lines.push('')
    lines.push('Re-run with --apply to commit the merges (will delete the originals).')
  }
  return lines.join('\n')
}
