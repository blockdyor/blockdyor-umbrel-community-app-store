// Shared helpers for Umbrel E2E and Raspberry Pi 5 stress test suites.
import {execFileSync} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import {arch} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'

export const DOCKER_BIN = process.env.DOCKER_BIN ?? '/usr/bin/docker'
export const SUDO_BIN = process.env.SUDO_BIN ?? '/usr/bin/sudo'
export const BASH_BIN = '/bin/bash'
export const CHMOD_BIN = '/bin/chmod'

export const SUBNET_PREFIX = process.env.E2E_SUBNET_PREFIX ?? ['10', '21'].join('.')
export const UMBREL_SUBNET = `${SUBNET_PREFIX}.0.0/16`
export const NETWORK_IP = `${SUBNET_PREFIX}.0.0`
export const TOR_PROXY_IP = process.env.E2E_TOR_PROXY_IP ?? `${SUBNET_PREFIX}.21.11`
export const TOR_PROXY_PORT = '9050'
export const TOR_IMAGE =
	'ghcr.io/getumbrel/tor:0.4.9.11@sha256:e382b8629c0dfef6ceb396b062622d4e4e955b19d6f16b883fd2c0723ad5671a'
export const UMBREL_APPS_BASE = 'https://raw.githubusercontent.com/getumbrel/umbrel-apps/master'

export function run(bin, args, opts = {}) {
	return execFileSync(bin, args, {
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 16 * 1024 * 1024,
		...opts,
	})
}

export async function until(label, check, attempts = 90, intervalMs = 2000) {
	let lastError
	for (let i = 0; i < attempts; i++) {
		try {
			return await check()
		} catch (err) {
			lastError = err
		}
		await delay(intervalMs)
	}
	throw new Error(`Timed out waiting for ${label}: ${lastError?.message ?? lastError}`)
}

export function createSecrets() {
	return {
		umbrelSeed: randomBytes(32).toString('hex'),
		torControlSecret: randomBytes(24).toString('base64'),
	}
}

export async function startSharedTorProxy({workDir, networkName, torContainer, torControlSecret}) {
	const torDataDir = path.join(workDir, 'tor-data')
	await mkdir(torDataDir, {recursive: true, mode: 0o777})
	run(CHMOD_BIN, ['777', torDataDir])
	run(DOCKER_BIN, ['network', 'create', `--subnet=${UMBREL_SUBNET}`, networkName])

	const torHash = run(DOCKER_BIN, [
		'run',
		'--rm',
		'--entrypoint',
		'tor',
		TOR_IMAGE,
		'--hash-password',
		torControlSecret,
	])
		.trim()
		.split('\n')
		.pop()

	const umbrelTorrc = path.join(workDir, 'umbrel-torrc')
	await writeFile(
		umbrelTorrc,
		[
			'DataDirectory /tmp/tor-data',
			'SocksPort 0.0.0.0:9050',
			'ControlPort 0.0.0.0:29051',
			`HashedControlPassword ${torHash}`,
			'Log notice stdout',
		].join('\n') + '\n',
	)
	run(DOCKER_BIN, [
		'run',
		'-d',
		'--name',
		torContainer,
		'--network',
		networkName,
		'--ip',
		TOR_PROXY_IP,
		'-u',
		'1000:1000',
		'-v',
		`${umbrelTorrc}:/etc/tor/torrc:ro`,
		TOR_IMAGE,
		'-f',
		'/etc/tor/torrc',
	])
}

export function sourceUmbrelEnv({workDir, umbrelSeed, torControlSecret, callerApp, appDir, dataRoots, exportsChain}) {
	const script = `
set -euo pipefail
derive_entropy() {
  printf "%s" "$1" | openssl dgst -sha256 -hmac "${umbrelSeed}" | sed 's/^.* //'
}
app_entropy_identifier="app-${callerApp}-seed"
export NETWORK_IP="${NETWORK_IP}"
export DEVICE_HOSTNAME="umbrel"
export DEVICE_DOMAIN_NAME="umbrel.local"
export TOR_PROXY_IP="${TOR_PROXY_IP}"
export TOR_PROXY_PORT="${TOR_PROXY_PORT}"
export TOR_PASSWORD="${torControlSecret}"
export TOR_DATA_DIR="${path.join(workDir, 'tor-data')}"
EXPORTS_TOR_DATA_DIR="${path.join(workDir, 'tor-data')}"
${exportsChain
	.map(
		({id, dir, dataRoot, file}) => `
EXPORTS_APP_ID="${id}"
EXPORTS_APP_DIR="${dir}"
EXPORTS_APP_DATA_DIR="${dataRoot}"
source "${file}"
`,
	)
	.join('\n')}
export APP_DATA_DIR="${appDir}"
export APP_DATA_ROOT="${dataRoots[callerApp]}"
export APP_ID="${callerApp}"
export APP_VERSION="0.11.1"
export APP_PASSWORD="$(derive_entropy "app-${callerApp}-seed-APP_PASSWORD")"
env -0
`
	const raw = run(BASH_BIN, ['-c', script])
	const env = {}
	for (const entry of raw.split('\0')) {
		if (!entry) continue
		const idx = entry.indexOf('=')
		if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1)
	}
	return env
}

export function compose(project, files, env, ...cmd) {
	const args = ['compose', '-p', project, ...files.flatMap((f) => ['-f', f]), ...cmd]
	return run(DOCKER_BIN, args, {env: {...process.env, ...env}})
}

export async function fetchText(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
	return res.text()
}

export function lndRest(method, endpoint, {port = 18081, ca, macaroonHex, body} = {}) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : undefined
		const headers = {'Content-Type': 'application/json'}
		if (macaroonHex) headers['Grpc-Metadata-macaroon'] = macaroonHex
		if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
		const req = https.request(
			{hostname: '127.0.0.1', port, path: endpoint, method, ca, headers, timeout: 15_000},
			(res) => {
				let data = ''
				res.setEncoding('utf8')
				res.on('data', (chunk) => {
					data += chunk
				})
				res.on('end', () => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(`LND ${method} ${endpoint} -> HTTP ${res.statusCode}: ${data}`))
						return
					}
					resolve(JSON.parse(data))
				})
			},
		)
		req.on('error', reject)
		req.on('timeout', () => req.destroy(new Error(`LND ${method} ${endpoint} timed out`)))
		if (payload) req.write(payload)
		req.end()
	})
}

export function testStratumV1(port, payoutAddress) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1')
		sock.setEncoding('utf8')
		sock.setTimeout(25_000, () => sock.destroy(new Error('Stratum v1 timed out')))
		let buf = ''
		let subscribed = false
		let authorized = false
		let jobNotify = null
		sock.on('connect', () => {
			sock.write(JSON.stringify({id: 1, method: 'mining.subscribe', params: ['e2e-miner/1.0']}) + '\n')
			sock.write(JSON.stringify({id: 2, method: 'mining.authorize', params: [`${payoutAddress}.worker1`, 'x']}) + '\n')
		})
		sock.on('data', (chunk) => {
			buf += chunk
			for (let idx = buf.indexOf('\n'); idx >= 0; idx = buf.indexOf('\n')) {
				const line = buf.slice(0, idx).trim()
				buf = buf.slice(idx + 1)
				if (!line) continue
				const msg = JSON.parse(line)
				if (msg.id === 1 && Array.isArray(msg.result) && msg.result.length >= 3) subscribed = true
				if (msg.id === 2 && msg.result === true) authorized = true
				if (msg.method === 'mining.notify' && Array.isArray(msg.params) && msg.params.length >= 8) {
					jobNotify = msg.params
				}
				if (subscribed && authorized && jobNotify) {
					sock.destroy()
					resolve({subscribed, authorized, jobId: jobNotify[0]})
					return
				}
			}
		})
		sock.on('error', reject)
		sock.on('close', () => {
			if (!subscribed || !authorized || !jobNotify) {
				reject(
					new Error(
						`Stratum closed early (subscribed=${subscribed}, authorized=${authorized}, notify=${Boolean(jobNotify)})`,
					),
				)
			}
		})
	})
}

export function electrumRpc(port, method, params = []) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1')
		sock.setEncoding('utf8')
		sock.setTimeout(15_000, () => sock.destroy(new Error(`Electrum ${method} timed out`)))
		let buf = ''
		sock.on('connect', () => {
			sock.write(JSON.stringify({jsonrpc: '2.0', id: 1, method, params}) + '\n')
		})
		sock.on('data', (chunk) => {
			buf += chunk
			const idx = buf.indexOf('\n')
			if (idx >= 0) {
				const line = buf.slice(0, idx).trim()
				sock.destroy()
				const parsed = JSON.parse(line)
				if (parsed.error) reject(new Error(`Electrum ${method} error: ${JSON.stringify(parsed.error)}`))
				else resolve(parsed.result)
			}
		})
		sock.on('error', reject)
	})
}

export function parseMemMiB(memUsage) {
	const first = memUsage.split('/')[0].trim()
	const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/i.exec(first)
	if (!match) return Number.NaN
	const val = Number(match[1])
	const unit = match[2].toLowerCase()
	if (unit === 'gib' || unit === 'gb') return val * 1024
	if (unit === 'mib' || unit === 'mb') return val
	if (unit === 'kib' || unit === 'kb') return val / 1024
	return val / (1024 * 1024)
}

export function snapshotDockerStats(label) {
	const raw = run(DOCKER_BIN, ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'])
	console.log(`\n--- RAM SNAPSHOT (${label}) [arch=${arch()}] ---`)
	const stats = {}
	for (const line of raw.trim().split('\n')) {
		if (!line) continue
		const [name, cpu, mem] = line.split('\t')
		const mib = parseMemMiB(mem)
		stats[name] = {cpu, mem, mib}
		console.log(`  ${name.padEnd(38)} CPU=${cpu.padStart(7)}  MEM=${mem} (${mib.toFixed(1)} MiB)`)
	}
	return stats
}

// Sends a real Bitcoin P2P regtest handshake + 50,000 duplicate MSG_WTX inv entries
// (CVE-2026-117348 attack shape) to verify the node processes it without stalling.
export function sendDuplicateWtxInvBurst(port, duplicateCount = 50_000) {
	const REGTEST_MAGIC = Buffer.from([0xfa, 0xbf, 0xb5, 0xda])
	const buildPacket = (command, payload) => {
		const hdr = Buffer.alloc(24)
		REGTEST_MAGIC.copy(hdr, 0)
		hdr.write(command, 4, 'ascii')
		hdr.writeUInt32LE(payload.length, 16)
		const cksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest()
		cksum.copy(hdr, 20, 0, 4)
		return Buffer.concat([hdr, payload])
	}

	const versionPayload = Buffer.alloc(86)
	versionPayload.writeInt32LE(70016, 0)
	versionPayload.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 12)
	randomBytes(8).copy(versionPayload, 72)
	versionPayload.writeUInt8(1, 85) // relay=1

	// Build inv payload with duplicateCount identical MSG_WTX (type=5) entries
	const invPayload = Buffer.alloc(3 + duplicateCount * 36)
	invPayload.writeUInt8(0xfd, 0)
	invPayload.writeUInt16LE(duplicateCount, 1)
	const wtxid = randomBytes(32)
	for (let i = 0; i < duplicateCount; i++) {
		const off = 3 + i * 36
		invPayload.writeUInt32LE(5, off) // MSG_WTX
		wtxid.copy(invPayload, off + 4)
	}

	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1')
		sock.setTimeout(10_000, () => {
			sock.destroy()
			resolve()
		})
		sock.on('connect', () => {
			sock.write(buildPacket('version', versionPayload))
			sock.write(buildPacket('wtxidrelay', Buffer.alloc(0)))
			sock.write(buildPacket('verack', Buffer.alloc(0)))
			setTimeout(() => {
				if (!sock.destroyed) {
					sock.write(buildPacket('inv', invPayload), () => {
						setTimeout(() => {
							sock.destroy()
							resolve()
						}, 500)
					})
				}
			}, 300)
		})
		sock.on('error', reject)
	})
}
