/**
 * Keyboard shortcuts for the CLI.
 *
 * Shift+Tab: cycle mode (Plan → Approval → Auto → Plan)
 *
 * Usage: call listenModeToggle() before starting a task,
 * then stopModeToggle() when done.
 */

import { getMode, setMode } from "../modes/session-array"
import type { SessionMode } from "../workers/types"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const log = logger.child("keyboard")

let modeToggleListener: ((buf: Buffer) => void) | null = null

const MODE_CYCLE: SessionMode[] = ["plan", "approval", "auto"]

function cycleMode(): SessionMode {
  const current = getMode()
  const idx = MODE_CYCLE.indexOf(current)
  const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]
  setMode(next)
  log.info(`[keyboard] Mode toggled: ${current} → ${next}`)
  return next
}

/**
 * Start listening for Shift+Tab (ESC[Z) in raw mode.
 * Returns a callback that reports mode changes.
 */
export function listenModeToggle(onModeChange?: (mode: SessionMode) => void): void {
  if (modeToggleListener) return // already listening

  const stdin = process.stdin
  if (!stdin.isTTY) return

  stdin.setRawMode(true)
  stdin.resume()

  modeToggleListener = (buf: Buffer) => {
    // Shift+Tab sends: ESC [ Z  (0x1B 0x5B 0x5A)
    if (buf.length === 3 && buf[0] === 0x1B && buf[1] === 0x5B && buf[2] === 0x5A) {
      const newMode = cycleMode()
      onModeChange?.(newMode)
    }

    // Ctrl+C to cancel
    if (buf.length === 1 && buf[0] === 0x03) {
      process.emit("SIGINT")
    }
  }

  stdin.on("data", modeToggleListener)
}

/**
 * Stop listening for keyboard shortcuts.
 */
export function stopModeToggle(): void {
  if (!modeToggleListener) return

  const stdin = process.stdin
  stdin.off("data", modeToggleListener)
  stdin.setRawMode(false)
  stdin.pause()
  modeToggleListener = null
}
