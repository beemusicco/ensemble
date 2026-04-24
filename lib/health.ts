import fs from 'fs'
import path from 'path'
import { getEnsembleDataDir } from './ensemble-paths'
import { queryMemories } from './memory-store'

const DISK_BYTES_PER_GB = 1_000_000_000

export type ComponentStatus = 'ok' | 'fail'

export interface HealthReport {
  status: 'healthy' | 'degraded'
  version: string
  uptimeS: number
  components: {
    memoryDb: ComponentStatus
    logsWritable: ComponentStatus
    tracesWritable: ComponentStatus
    diskFreeGb: number | null
  }
}

const SERVER_STARTED_AT = Date.now()

export async function buildHealthReport(version: string): Promise<HealthReport> {
  const dataDir = getEnsembleDataDir()
  const logsDir = path.join(dataDir, 'logs')

  let memoryDb: ComponentStatus = 'fail'
  try {
    queryMemories({ scope: 'global', limit: 1 })
    memoryDb = 'ok'
  } catch { /* fail */ }

  const checkWritable = (dir: string): ComponentStatus => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return 'ok'
    } catch { return 'fail' }
  }

  const logsWritable = checkWritable(logsDir)
  // traces share logsDir today; check independently so a future split is observable
  const tracesWritable = checkWritable(logsDir)

  let diskFreeGb: number | null = null
  try {
    const stats = await fs.promises.statfs(dataDir)
    diskFreeGb = Math.round((stats.bavail * stats.bsize / DISK_BYTES_PER_GB) * 10) / 10
  } catch { /* diskFreeGb stays null → treated as degraded */ }

  const degraded =
    memoryDb !== 'ok' ||
    logsWritable !== 'ok' ||
    tracesWritable !== 'ok' ||
    diskFreeGb === null

  return {
    status: degraded ? 'degraded' : 'healthy',
    version,
    uptimeS: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
    components: { memoryDb, logsWritable, tracesWritable, diskFreeGb },
  }
}
