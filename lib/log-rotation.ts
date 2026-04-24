import fs from 'fs'
import path from 'path'

export const LOG_MAX_BYTES = 10 * 1024 * 1024
export const LOG_RETENTION = 30
export const LOG_ROTATE_CHECK_MS = 5 * 60 * 1000

export class RotatingFileWriter {
  private currentPath: string | null = null
  private readonly timer: NodeJS.Timeout | null

  constructor(
    private readonly filePath: () => string,
    private readonly directory: () => string,
    intervalMs = LOG_ROTATE_CHECK_MS,
  ) {
    this.checkRotation()
    this.timer = setInterval(() => this.checkRotation(), intervalMs)
    this.timer.unref()
  }

  write(line: string): void {
    this.checkRotation()
    const nextPath = this.filePath()
    try {
      fs.mkdirSync(this.directory(), { recursive: true })
      fs.appendFileSync(nextPath, line + '\n')
      this.currentPath = nextPath
    } catch { /* logging must not break callers */ }
  }

  getCurrentPath(): string {
    return this.filePath()
  }

  checkRotation(): void {
    const nextPath = this.filePath()
    if (this.currentPath && this.currentPath !== nextPath) {
      this.rotate(this.currentPath)
      return
    }

    const targetPath = this.currentPath ?? nextPath
    try {
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > LOG_MAX_BYTES) {
        this.rotate(targetPath)
      } else {
        this.deleteExpiredRotations(targetPath)
      }
    } catch {
      // Best-effort logging must not break the server.
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private rotate(targetPath: string): void {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      this.deleteExpiredRotations(targetPath)
      for (let i = LOG_RETENTION - 1; i >= 1; i--) {
        const from = `${targetPath}.${i}`
        const to = `${targetPath}.${i + 1}`
        if (fs.existsSync(from)) fs.renameSync(from, to)
      }
      if (fs.existsSync(targetPath)) fs.renameSync(targetPath, `${targetPath}.1`)
    } catch {
      // Ignore rotation failures; next write will try to reopen the base file.
    } finally {
      this.currentPath = null
    }
  }

  private deleteExpiredRotations(targetPath: string): void {
    const dir = path.dirname(targetPath)
    const base = path.basename(targetPath)
    if (!fs.existsSync(dir)) return

    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.`)) continue
      const suffix = name.slice(base.length + 1)
      if (!/^\d+$/.test(suffix)) continue
      if (Number(suffix) > LOG_RETENTION) {
        try { fs.unlinkSync(path.join(dir, name)) } catch { /* ignore */ }
      }
    }
  }
}
