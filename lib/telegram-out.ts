/**
 * Outbound Telegram helper.
 *
 * Reads the bot token from env (`ENSEMBLE_TELEGRAM_BOT_TOKEN`) or macOS
 * keychain (matching the priority order used by telegram-collab-listener.py
 * — the existing inbound listener). Reads the operator's chat id from env
 * (`ENSEMBLE_TELEGRAM_OPERATOR_CHAT_ID`) or falls back to the value already
 * embedded in proxy.js (`8535668575` — the operator's user id).
 *
 * If we can't resolve a token, sendMessage is a silent no-op (logs a
 * warning once). This is deliberate: ensemble must keep functioning when
 * Telegram isn't configured — the question watcher just degrades to "no
 * channel; treat as timed out immediately".
 */

import { execFileSync } from 'child_process'

const KEYCHAIN_LOOKUPS: Array<[string | null, string]> = [
  ['openclaw-gateway', 'TELEGRAM_BOT_TOKEN'],
  ['openclaw-telegram-bot-token', process.env.USER ?? ''],
  [null, 'TELEGRAM_BOT_TOKEN'],
]

let cachedToken: string | null = null
let warnedNoToken = false

function lookupKeychain(service: string | null, account: string): string | null {
  if (!account) return null
  try {
    const args = ['find-generic-password']
    if (service) args.push('-s', service)
    args.push('-a', account, '-w')
    const out = execFileSync('security', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out || null
  } catch {
    return null
  }
}

export function getTelegramToken(): string | null {
  if (cachedToken !== null) return cachedToken
  const env = (process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN || '').trim()
  if (env) {
    cachedToken = env
    return env
  }
  for (const [service, account] of KEYCHAIN_LOOKUPS) {
    const tok = lookupKeychain(service, account)
    if (tok) {
      cachedToken = tok
      return tok
    }
  }
  if (!warnedNoToken) {
    console.warn('[Ensemble] No Telegram bot token found (env ENSEMBLE_TELEGRAM_BOT_TOKEN nor keychain) — outbound notifications disabled')
    warnedNoToken = true
  }
  return null
}

export function getOperatorChatId(): string | null {
  const env = (process.env.ENSEMBLE_TELEGRAM_OPERATOR_CHAT_ID || '').trim()
  if (env) return env
  // Default to the operator's chat id baked into proxy.js. If multiple
  // operators ever share this, override via env.
  return '8535668575'
}

export interface SendTelegramResult {
  ok: boolean
  messageId?: number
  error?: string
}

export async function sendTelegramMessage(
  text: string,
  chatId?: string,
): Promise<SendTelegramResult> {
  const token = getTelegramToken()
  if (!token) return { ok: false, error: 'no-token' }
  const target = chatId || getOperatorChatId()
  if (!target) return { ok: false, error: 'no-chat-id' }

  // Telegram caps at 4096 chars/message; we cap at 3500 to leave headroom
  // for formatting.
  const truncated = text.length > 3500
    ? text.slice(0, 3400) + '\n…[truncated]'
    : text

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: target,
        text: truncated,
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const data = await res.json() as { ok: boolean; result?: { message_id: number } }
    if (!data.ok) return { ok: false, error: 'api-not-ok' }
    return { ok: true, messageId: data.result?.message_id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
