import type { SessionMode } from "../workers/types"

/**
 * SharedArrayBuffer layout (8 bytes total):
 *   byte 0: mode (0=plan, 1=approval, 2=auto)
 *   byte 1: active phase index
 *   byte 2: workers_busy bitmask (6 bits for 6 coordinators)
 *   byte 3: flags (bit 0=pause, bit 1=cancel, bit 2=shutdown)
 *   bytes 4-7: padding/reserved
 */
const BYTE_MODE = 0
const BYTE_PHASE = 1
const BYTE_WORKERS = 2
const BYTE_FLAGS = 3
const SAB_SIZE = 8

const MODE_MAP: Record<SessionMode, number> = { plan: 0, approval: 1, auto: 2 }
const MODE_REVERSE: Record<number, SessionMode> = { 0: "plan", 1: "approval", 2: "auto" }

let sab: SharedArrayBuffer
let view: Int8Array

export function initSessionArray(): void {
  sab = new SharedArrayBuffer(SAB_SIZE)
  view = new Int8Array(sab)
  view[BYTE_MODE] = 0 // default: plan
  view[BYTE_PHASE] = 0
  view[BYTE_WORKERS] = 0
  view[BYTE_FLAGS] = 0
}

export function getSessionArray(): SharedArrayBuffer {
  if (!sab) initSessionArray()
  return sab
}

export function getMode(): SessionMode {
  return MODE_REVERSE[Atomics.load(view, BYTE_MODE)] ?? "plan"
}

export function setMode(mode: SessionMode): void {
  Atomics.store(view, BYTE_MODE, MODE_MAP[mode])
}

export function getPhaseIndex(): number {
  return Atomics.load(view, BYTE_PHASE)
}

export function setPhaseIndex(index: number): void {
  Atomics.store(view, BYTE_PHASE, index)
}

export function getWorkerBitmask(): number {
  return Atomics.load(view, BYTE_WORKERS)
}

export function setWorkerBusy(coordinatorIndex: number, busy: boolean): void {
  if (coordinatorIndex < 0 || coordinatorIndex > 5) return
  const mask = 1 << coordinatorIndex
  if (busy) {
    Atomics.or(view, BYTE_WORKERS, mask)
  } else {
    Atomics.and(view, BYTE_WORKERS, ~mask)
  }
}

export function isWorkerBusy(coordinatorIndex: number): boolean {
  if (coordinatorIndex < 0 || coordinatorIndex > 5) return false
  return (Atomics.load(view, BYTE_WORKERS) & (1 << coordinatorIndex)) !== 0
}

export function isPaused(): boolean {
  return (Atomics.load(view, BYTE_FLAGS) & 1) !== 0
}

export function setPaused(paused: boolean): void {
  if (paused) {
    Atomics.or(view, BYTE_FLAGS, 1)
  } else {
    Atomics.and(view, BYTE_FLAGS, ~1)
  }
}

export function isCancelled(): boolean {
  return (Atomics.load(view, BYTE_FLAGS) & 2) !== 0
}

export function setCancelled(cancelled: boolean): void {
  if (cancelled) {
    Atomics.or(view, BYTE_FLAGS, 2)
  } else {
    Atomics.and(view, BYTE_FLAGS, ~2)
  }
}

export function isShuttingDown(): boolean {
  return (Atomics.load(view, BYTE_FLAGS) & 4) !== 0
}

export function setShuttingDown(): void {
  Atomics.or(view, BYTE_FLAGS, 4)
}
