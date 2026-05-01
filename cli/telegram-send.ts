#!/usr/bin/env tsx
/**
 * Tiny CLI: read stdin, send to operator Telegram via lib/telegram-out.ts.
 * Used by scripts/team-stats-telegram.sh + any other digest pipelines.
 *
 * Exit codes:
 *   0 — sent OK
 *   1 — send failed (token missing, HTTP error, etc.)
 *   2 — empty stdin (nothing to send)
 */

import { sendTelegramMessage } from '../lib/telegram-out'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

async function main(): Promise<void> {
  const text = (await readStdin()).trim()
  if (!text) {
    console.error('telegram-send: empty stdin — nothing to send')
    process.exit(2)
  }
  const result = await sendTelegramMessage(text)
  if (!result.ok) {
    console.error(`telegram-send: failed (${result.error})`)
    process.exit(1)
  }
  console.log(`telegram-send: ok (msgId=${result.messageId ?? 'n/a'})`)
}

main().catch(err => {
  console.error('telegram-send: unexpected error:', err)
  process.exit(1)
})
