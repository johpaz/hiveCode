import { hiveIntro, hiveOutro, hiveSpinner, hiveNote } from "../ui/index.ts"
import { getHiveDir } from "@johpaz/hive-code-core/config/loader"
import { repl } from "./repl"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import * as path from "node:path"

let gatewayChild: ChildProcess | null = null

function cleanup() {
	if (gatewayChild?.pid) {
		try { process.kill(-gatewayChild.pid, "SIGTERM") } catch { gatewayChild.kill("SIGTERM") }
	}
}

process.on("SIGINT", () => { cleanup(); process.exit(0) })
process.on("SIGTERM", () => { cleanup(); process.exit(0) })
process.on("exit", () => { cleanup() })

async function waitForPort(port: number, timeout = 15000): Promise<boolean> {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
			if (r.ok) return true
		} catch {}
		await Bun.sleep(300)
	}
	return false
}

function getGatewayPort(): number {
	try {
		const pidFile = path.join(getHiveDir(), "gateway.pid")
		if (!existsSync(pidFile)) return 18790
	} catch {}
	return 18790
}

async function isGatewayRunning(): Promise<boolean> {
	const pidFile = path.join(getHiveDir(), "gateway.pid")
	if (!existsSync(pidFile)) return false
	try {
		const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
		if (isNaN(pid)) return false
		process.kill(pid, 0)
		return true
	} catch {
		try { unlinkSync(pidFile) } catch {}
		return false
	}
}

export async function dev(): Promise<void> {
	hiveIntro("hive-code · Dev Mode")

	const hiveDir = getHiveDir()
	const spinner = hiveSpinner("default")
	const port = getGatewayPort()

	const alreadyRunning = await isGatewayRunning()

	if (alreadyRunning) {
		spinner.stop("Gateway ya está corriendo")
	} else {
		spinner.start(`Iniciando Gateway (${hiveDir})...`)

		gatewayChild = spawn(
			process.execPath,
			[process.argv[1] || "", "start", "--skip-check", "--dev-internal"],
			{
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, HIVE_DEV: "true", HIVE_GATEWAY_CHILD: "1" },
			}
		)

		gatewayChild.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (line.trim()) console.log(`[Gateway] ${line}`)
			}
		})
		gatewayChild.stderr?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (line.trim()) console.error(`[Gateway] ${line}`)
			}
		})
		gatewayChild.on("error", (err) => {
			console.error(`❌ Gateway error: ${err.message}`)
		})

		const ready = await waitForPort(port)
		if (!ready) {
			spinner.stop("Gateway no respondió a tiempo", "error")
			hiveOutro("Modo dev fallido", "error")
			process.exit(1)
		}
		spinner.stop("Gateway listo")
	}

	hiveNote("Dev Mode", [
		`API: http://127.0.0.1:${port}`,
		`WebSocket: ws://127.0.0.1:${port}ws`,
		"Shift+Tab para cambiar modo",
		"^C para salir",
	])

	await repl()
}
