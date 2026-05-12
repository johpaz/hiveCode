import { describe, test, expect, beforeEach } from "bun:test"
import {
	initSessionArray, getMode, setMode,
	getPhaseIndex, setPhaseIndex,
	getWorkerBitmask, setWorkerBusy, isWorkerBusy,
	isPaused, setPaused,
	isCancelled, setCancelled,
	isShuttingDown, setShuttingDown,
} from "../../src/modes/session-array"

describe("session-array", () => {
	beforeEach(() => {
		initSessionArray()
	})

	describe("mode", () => {
		test("default mode is plan", () => {
			expect(getMode()).toBe("plan")
		})

		test("setMode changes mode atomically", () => {
			setMode("approval")
			expect(getMode()).toBe("approval")

			setMode("auto")
			expect(getMode()).toBe("auto")

			setMode("plan")
			expect(getMode()).toBe("plan")
		})
	})

	describe("phase index", () => {
		test("default phase index is 0", () => {
			expect(getPhaseIndex()).toBe(0)
		})

		test("setPhaseIndex stores value atomically", () => {
			setPhaseIndex(3)
			expect(getPhaseIndex()).toBe(3)

			setPhaseIndex(5)
			expect(getPhaseIndex()).toBe(5)
		})
	})

	describe("worker bitmask", () => {
		test("default bitmask is 0 (no workers busy)", () => {
			expect(getWorkerBitmask()).toBe(0)
		})

		test("setWorkerBusy marks individual coordinator as busy", () => {
			setWorkerBusy(0, true)
			expect(isWorkerBusy(0)).toBe(true)
			expect(getWorkerBitmask()).toBe(0b000001)

			setWorkerBusy(2, true)
			expect(isWorkerBusy(2)).toBe(true)
			expect(getWorkerBitmask()).toBe(0b000101)
		})

		test("setWorkerBusy(false) clears individual bit", () => {
			setWorkerBusy(0, true)
			setWorkerBusy(2, true)
			setWorkerBusy(0, false)
			expect(isWorkerBusy(0)).toBe(false)
			expect(isWorkerBusy(2)).toBe(true)
			expect(getWorkerBitmask()).toBe(0b000100)
		})

		test("multiple workers can be busy simultaneously", () => {
			setWorkerBusy(0, true)
			setWorkerBusy(1, true)
			setWorkerBusy(5, true)
			expect(isWorkerBusy(0)).toBe(true)
			expect(isWorkerBusy(1)).toBe(true)
			expect(isWorkerBusy(5)).toBe(true)
			expect(isWorkerBusy(2)).toBe(false)
			expect(getWorkerBitmask()).toBe(0b100011)
		})

		test("invalid coordinatorIndex is ignored", () => {
			setWorkerBusy(-1, true)
			setWorkerBusy(6, true)
			expect(getWorkerBitmask()).toBe(0)
			expect(isWorkerBusy(-1)).toBe(false)
			expect(isWorkerBusy(6)).toBe(false)
		})
	})

	describe("flags — pause", () => {
		test("default is not paused", () => {
			expect(isPaused()).toBe(false)
		})

		test("setPaused(true) sets pause flag", () => {
			setPaused(true)
			expect(isPaused()).toBe(true)
		})

		test("setPaused(false) clears pause flag", () => {
			setPaused(true)
			setPaused(false)
			expect(isPaused()).toBe(false)
		})
	})

	describe("flags — cancel", () => {
		test("default is not cancelled", () => {
			expect(isCancelled()).toBe(false)
		})

		test("setCancelled(true) sets cancel flag", () => {
			setCancelled(true)
			expect(isCancelled()).toBe(true)
		})

		test("setCancelled(false) clears cancel flag", () => {
			setCancelled(true)
			setCancelled(false)
			expect(isCancelled()).toBe(false)
		})
	})

	describe("flags — shutdown", () => {
		test("default is not shutting down", () => {
			expect(isShuttingDown()).toBe(false)
		})

		test("setShuttingDown sets shutdown flag", () => {
			setShuttingDown()
			expect(isShuttingDown()).toBe(true)
		})
	})

	describe("flags — independence", () => {
		test("pause and cancel are independent bits", () => {
			setPaused(true)
			setCancelled(true)
			expect(isPaused()).toBe(true)
			expect(isCancelled()).toBe(true)
			expect(isShuttingDown()).toBe(false)

			setPaused(false)
			expect(isCancelled()).toBe(true)

			setCancelled(false)
			expect(isPaused()).toBe(false)
		})

		test("shutdown does not affect other flags", () => {
			setPaused(true)
			setShuttingDown()
			expect(isPaused()).toBe(true)
			expect(isShuttingDown()).toBe(true)
		})
	})
})
