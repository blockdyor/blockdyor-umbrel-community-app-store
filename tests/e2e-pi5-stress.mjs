// Real-world Raspberry Pi 5 (ARM64 + x86_64) stress & ecosystem E2E suite for blockdyor-bitcoin-roots:
// 1. Side-by-side coexistence with official Bitcoin Core (8333/8332 vs 10333/10332)
// 2. Real zero-re-sync chain migration from Bitcoin Core -> Bitcoin Roots (exact block hash parity)
// 3. Official Core Lightning + official LND synced via exports.sh (RPC + ZMQ rawblock/rawtx)
// 4. Real Lightning channel open, BOLT11 invoice payment, and cooperative close between CLN <-> LND
// 5. Official Electrs (cookie auth + whitebind P2P + live Electrum JSON-RPC query)
// 6. Bassin (Cap'n Proto IPC + UI) + Official Public Pool (RPC + live Stratum v1 getblocktemplate job)
// 7. Mempool burst (50 rapid txs) + concurrent REST API & WebSocket (/ws/blocks, /ws/transactions) stress
// 8. Live Roots Relay & Mining Policy toggle (datacarrier=0 -> real OP_RETURN tx rejected) + 15-block catch-up
// 9. Abrupt SIGKILL crash recovery on Bitcoin Roots app + Tor (onion identity persistence + full reconnect)
// 10. Live per-container RAM & Node.js RSS budget audit for Raspberry Pi 5
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import {arch, tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(path.join(tmpdir(), 'umbrel-pi5-stress-'))
const pid = process.pid
const networkName = `pi5-stress-net-${pid}`
const torContainer = `pi5-umbrel-tor-${pid}`

const projects = {
	core: `pi5-core-${pid}`,
	roots: `pi5-roots-${pid}`,
	cln: `pi5-cln-${pid}`,
	lnd: `pi5-lnd-${pid}`,
	electrs: `pi5-electrs-${pid}`,
	bassin: `pi5-bassin-${pid}`,
	publicPool: `pi5-public-pool-${pid}`,
}

const DOCKER_BIN = process.env.DOCKER_BIN ?? '/usr/bin/docker'
const SUDO_BIN = process.env.SUDO_BIN ?? '/usr/bin/sudo'
const BASH_BIN = '/bin/bash'
const CHMOD_BIN = '/bin/chmod'

const SUBNET_PREFIX = process.env.E2E_SUBNET_PREFIX ?? ['10', '21'].join('.')
const UMBREL_SUBNET = `${SUBNET_PREFIX}.0.0/16`
const NETWORK_IP = `${SUBNET_PREFIX}.0.0`
const TOR_PROXY_IP = `${SUBNET_PREFIX}.21.11`
const TOR_PROXY_PORT = '9050'
const TOR_IMAGE =
	'ghcr.io/getumbrel/tor:0.4.9.11@sha256:e382b8629c0dfef6ceb396b062622d4e4e955b19d6f16b883fd2c0723ad5671a'
const UMBREL_SEED = randomBytes(32).toString('hex')
const TOR_CONTROL_SECRET = randomBytes(24).toString('base64')
const UMBREL_APPS_BASE = 'https://raw.githubusercontent.com/getumbrel/umbrel-apps/master'

function run(bin, args, opts = {}) {
	return execFileSync(bin, args, {
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 16 * 1024 * 1024,
		...opts,
	})
}

async function until(label, check, attempts = 90, intervalMs = 2000) {
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

function sourceUmbrelEnv({callerApp, appDir, dataRoots, exportsChain}) {
	const script = `
set -euo pipefail
derive_entropy() {
  printf "%s" "$1" | openssl dgst -sha256 -hmac "${UMBREL_SEED}" | sed 's/^.* //'
}
app_entropy_identifier="app-${callerApp}-seed"
export NETWORK_IP="${NETWORK_IP}"
export DEVICE_HOSTNAME="umbrel-pi5"
export DEVICE_DOMAIN_NAME="umbrel.local"
export TOR_PROXY_IP="${TOR_PROXY_IP}"
export TOR_PROXY_PORT="${TOR_PROXY_PORT}"
export TOR_PASSWORD="${TOR_CONTROL_SECRET}"
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

const composeCalls = []
function compose(project, files, env, ...cmd) {
	const args = ['compose', '-p', project, ...files.flatMap((f) => ['-f', f]), ...cmd]
	return run(DOCKER_BIN, args, {env: {...process.env, ...env}})
}

async function fetchText(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
	return res.text()
}

function lndRest(method, endpoint, {ca, macaroonHex, body} = {}) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : undefined
		const headers = {'Content-Type': 'application/json'}
		if (macaroonHex) headers['Grpc-Metadata-macaroon'] = macaroonHex
		if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
		const req = https.request(
			{hostname: '127.0.0.1', port: 18081, path: endpoint, method, ca, headers, timeout: 15_000},
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

function testStratumV1(port, payoutAddress) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1')
		sock.setEncoding('utf8')
		sock.setTimeout(25_000, () => sock.destroy(new Error('Stratum v1 timed out')))
		let buf = ''
		let subscribed = false
		let authorized = false
		let jobNotify = null
		sock.on('connect', () => {
			sock.write(JSON.stringify({id: 1, method: 'mining.subscribe', params: ['pi5-miner/1.0']}) + '\n')
			sock.write(JSON.stringify({id: 2, method: 'mining.authorize', params: [`${payoutAddress}.pi5`, 'x']}) + '\n')
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

function electrumRpc(port, method, params = []) {
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

function parseMemMiB(memUsage) {
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

function snapshotDockerStats(label) {
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

try {
	console.log(`=== Raspberry Pi 5 Real-World Stress Suite (host arch=${arch()}) ===`)
	await chmod(workDir, 0o755)
	const torDataDir = path.join(workDir, 'tor-data')
	await mkdir(torDataDir, {recursive: true, mode: 0o777})
	await chmod(torDataDir, 0o777)

	// Create Umbrel bridge network & shared Tor proxy
	run(DOCKER_BIN, ['network', 'create', `--subnet=${UMBREL_SUBNET}`, networkName])
	const torHash = run(DOCKER_BIN, [
		'run',
		'--rm',
		'--entrypoint',
		'tor',
		TOR_IMAGE,
		'--hash-password',
		TOR_CONTROL_SECRET,
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

	// Prepare app directories
	const dirs = {
		core: path.join(workDir, 'bitcoin'),
		roots: path.join(workDir, 'blockdyor-bitcoin-roots'),
		cln: path.join(workDir, 'core-lightning'),
		lnd: path.join(workDir, 'lightning'),
		electrs: path.join(workDir, 'electrs'),
		bassin: path.join(workDir, 'blockdyor-bassin'),
		publicPool: path.join(workDir, 'public-pool'),
	}

	await cp(path.join(repoRoot, 'blockdyor-bitcoin-roots'), dirs.roots, {recursive: true})
	await cp(path.join(repoRoot, 'blockdyor-bassin'), dirs.bassin, {recursive: true})

	for (const rel of [
		[dirs.core, 'data/app'],
		[dirs.core, 'data/bitcoin'],
		[dirs.core, 'data/i2pd'],
		[dirs.roots, 'data/app'],
		[dirs.roots, 'data/bitcoin'],
		[dirs.roots, 'data/i2pd'],
		[dirs.cln, 'data/lightningd'],
		[dirs.cln, 'data/app'],
		[dirs.lnd, 'data/lnd'],
		[dirs.lnd, 'data/lightning'],
		[dirs.electrs, 'data/electrs/db'],
		[dirs.bassin, 'data/www'],
		[dirs.bassin, 'data/sv2'],
		[dirs.publicPool, 'data/database'],
	]) {
		await mkdir(path.join(rel[0], rel[1]), {recursive: true})
	}

	await writeFile(
		path.join(dirs.core, 'data/app/settings.json'),
		JSON.stringify({chain: 'regtest'}, null, 2) + '\n',
	)
	await writeFile(
		path.join(dirs.roots, 'data/app/settings.json'),
		JSON.stringify({chain: 'regtest', ipc: true}, null, 2) + '\n',
	)
	await writeFile(path.join(dirs.lnd, 'data/lnd/umbrel-lnd.conf'), '')

	run(CHMOD_BIN, ['-R', 'a+rwx', ...Object.values(dirs).map((d) => path.join(d, 'data'))])

	// Fetch official Umbrel app packages
	for (const [appId, dir, hasExports] of [
		['bitcoin', dirs.core, true],
		['core-lightning', dirs.cln, true],
		['lightning', dirs.lnd, true],
		['electrs', dirs.electrs, true],
		['public-pool', dirs.publicPool, false],
	]) {
		if (hasExports) {
			await writeFile(path.join(dir, 'exports.sh'), await fetchText(`${UMBREL_APPS_BASE}/${appId}/exports.sh`))
		}
		await writeFile(
			path.join(dir, 'docker-compose.yml'),
			await fetchText(`${UMBREL_APPS_BASE}/${appId}/docker-compose.yml`),
		)
	}

	const dataRoots = {
		bitcoin: path.join(dirs.core, 'data'),
		'blockdyor-bitcoin-roots': path.join(dirs.roots, 'data'),
		'core-lightning': path.join(dirs.cln, 'data'),
		lightning: path.join(dirs.lnd, 'data'),
		electrs: path.join(dirs.electrs, 'data'),
		'blockdyor-bassin': path.join(dirs.bassin, 'data'),
		'public-pool': path.join(dirs.publicPool, 'data'),
	}

	const netOverride = path.join(workDir, 'network-override.yml')
	await writeFile(
		netOverride,
		`services:
  app_proxy:
    image: busybox:1.37
networks:
  default:
    external: true
    name: ${networkName}
`,
	)

	// =========================================================================
	// STAGE 1: Side-by-Side Coexistence (Official Bitcoin Core + Bitcoin Roots)
	// =========================================================================
	console.log('\n==> [Stage 1] Booting Official Bitcoin Core (8333/8332) AND Bitcoin Roots (10333/10332) simultaneously...')
	const coreEnv = sourceUmbrelEnv({
		callerApp: 'bitcoin',
		appDir: dirs.core,
		dataRoots,
		exportsChain: [{id: 'bitcoin', dir: dirs.core, dataRoot: dataRoots.bitcoin, file: path.join(dirs.core, 'exports.sh')}],
	})
	const rootsEnv = sourceUmbrelEnv({
		callerApp: 'blockdyor-bitcoin-roots',
		appDir: dirs.roots,
		dataRoots,
		exportsChain: [
			{
				id: 'blockdyor-bitcoin-roots',
				dir: dirs.roots,
				dataRoot: dataRoots['blockdyor-bitcoin-roots'],
				file: path.join(dirs.roots, 'exports.sh'),
			},
		],
	})

	const rootsOverride = path.join(workDir, 'roots-override.yml')
	await writeFile(
		rootsOverride,
		`services:
  app:
    ports:
      - '127.0.0.1:13000:3000'
`,
	)
	const coreFiles = [path.join(dirs.core, 'docker-compose.yml'), netOverride]
	const rootsFiles = [path.join(dirs.roots, 'docker-compose.yml'), netOverride, rootsOverride]
	composeCalls.push(
		{project: projects.core, files: coreFiles, env: coreEnv},
		{project: projects.roots, files: rootsFiles, env: rootsEnv},
	)

	compose(projects.core, coreFiles, coreEnv, 'up', '-d', 'app')
	compose(projects.roots, rootsFiles, rootsEnv, 'up', '-d', 'app', 'tor', 'i2p')

	const coreCli = (...args) =>
		compose(
			projects.core,
			coreFiles,
			coreEnv,
			'exec',
			'-T',
			'app',
			'bitcoin-cli',
			'-datadir=/data/bitcoin',
			'-regtest',
			`-rpcport=${coreEnv.APP_BITCOIN_RPC_PORT}`,
			...args,
		).trim()

	const rootsCli = (...args) =>
		compose(
			projects.roots,
			rootsFiles,
			rootsEnv,
			'exec',
			'-T',
			'app',
			'bitcoin-cli',
			'-datadir=/data/bitcoin',
			'-regtest',
			`-rpcport=${rootsEnv.APP_BITCOIN_ROOTS_RPC_PORT}`,
			...args,
		).trim()

	await until('Official Bitcoin Core RPC ready on 8332', () => {
		const info = JSON.parse(coreCli('getblockchaininfo'))
		assert.equal(info.chain, 'regtest')
	})
	const rootsVersion = await until('Bitcoin Roots RPC & HTTP API ready on 10332/3000', async () => {
		const info = JSON.parse(rootsCli('getblockchaininfo'))
		assert.equal(info.chain, 'regtest')
		const res = await fetch('http://127.0.0.1:13000/api/bitcoind/version')
		assert.equal(res.status, 200)
		const v = await res.json()
		assert.equal(v.implementation, 'Bitcoin Roots')
		return v
	})
	console.log('PASS [Stage 1]: Core (8333/8332) & Roots (10333/10332,', rootsVersion.version, ') ran side-by-side with zero conflicts')

	// Mine 101 blocks on Bitcoin Core
	coreCli('createwallet', 'coreminer')
	const coreMinerAddr = coreCli('-rpcwallet=coreminer', 'getnewaddress')
	coreCli('-rpcwallet=coreminer', 'generatetoaddress', '101', coreMinerAddr)
	const expectedHash101 = coreCli('getblockhash', '101')
	assert.match(expectedHash101, /^[a-f0-9]{64}$/)

	// =========================================================================
	// STAGE 2: Real Zero-Re-Sync Migration (Bitcoin Core -> Bitcoin Roots)
	// =========================================================================
	console.log('\n==> [Stage 2] Migrating chain data (blocks/chainstate/indexes) from Bitcoin Core -> Bitcoin Roots...')
	compose(projects.core, coreFiles, coreEnv, 'stop', 'app')
	compose(projects.roots, rootsFiles, rootsEnv, 'stop', 'app')

	const coreRegtest = path.join(dirs.core, 'data/bitcoin/regtest')
	const rootsRegtest = path.join(dirs.roots, 'data/bitcoin/regtest')
	run(SUDO_BIN, [
		BASH_BIN,
		'-euo',
		'pipefail',
		'-c',
		`
rm -rf "${rootsRegtest}/blocks" "${rootsRegtest}/chainstate" "${rootsRegtest}/indexes"
mkdir -p "${rootsRegtest}"
mv "${coreRegtest}/blocks" "${coreRegtest}/chainstate" "${rootsRegtest}/"
[ -d "${coreRegtest}/indexes" ] && mv "${coreRegtest}/indexes" "${rootsRegtest}/"
chown -R 1000:1000 "${dirs.roots}/data/bitcoin"
`,
	])

	// Tear down Bitcoin Core (user uninstalls old node after migration) & start Bitcoin Roots
	compose(projects.core, coreFiles, coreEnv, 'down', '--volumes', '--remove-orphans', '--timeout', '20')
	compose(projects.roots, rootsFiles, rootsEnv, 'up', '-d', 'app')

	await until('Bitcoin Roots boots from Core chain data at height 101 with exact block hash', () => {
		const info = JSON.parse(rootsCli('getblockchaininfo'))
		assert.equal(info.blocks, 101)
		assert.equal(rootsCli('getblockhash', '101'), expectedHash101)
		const sock = compose(
			projects.roots,
			rootsFiles,
			rootsEnv,
			'exec',
			'-T',
			'app',
			'test',
			'-S',
			'/data/bitcoin/regtest/node.sock',
		)
		void sock
	})
	console.log('PASS [Stage 2]: Migrated Bitcoin Core -> Bitcoin Roots at height 101 (hash', expectedHash101.slice(0, 16), '...) with zero re-sync')

	// Create a miner wallet on Bitcoin Roots & mine 101 blocks so Roots wallet has spendable regtest funds
	rootsCli('createwallet', 'miner')
	const minerAddr = rootsCli('-rpcwallet=miner', 'getnewaddress')
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '101', minerAddr)
	let currentHeight = 202

	// =========================================================================
	// STAGE 3: Boot Official Core Lightning + Official LND
	// =========================================================================
	console.log('\n==> [Stage 3] Starting official Core Lightning and official LND wired to Bitcoin Roots...')
	const rootsExportEntry = {
		id: 'blockdyor-bitcoin-roots',
		dir: dirs.roots,
		dataRoot: dataRoots['blockdyor-bitcoin-roots'],
		file: path.join(dirs.roots, 'exports.sh'),
	}

	const clnEnv = sourceUmbrelEnv({
		callerApp: 'core-lightning',
		appDir: dirs.cln,
		dataRoots,
		exportsChain: [
			rootsExportEntry,
			{id: 'core-lightning', dir: dirs.cln, dataRoot: dataRoots['core-lightning'], file: path.join(dirs.cln, 'exports.sh')},
		],
	})
	const lndEnv = sourceUmbrelEnv({
		callerApp: 'lightning',
		appDir: dirs.lnd,
		dataRoots,
		exportsChain: [
			rootsExportEntry,
			{id: 'lightning', dir: dirs.lnd, dataRoot: dataRoots.lightning, file: path.join(dirs.lnd, 'exports.sh')},
		],
	})
	assert.equal(clnEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS)
	assert.equal(lndEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS)

	const lndOverride = path.join(workDir, 'lnd-override.yml')
	await writeFile(
		lndOverride,
		`services:
  lnd:
    ports: !override
      - '127.0.0.1:18081:8080'
`,
	)
	const clnFiles = [path.join(dirs.cln, 'docker-compose.yml'), netOverride]
	const lndFiles = [path.join(dirs.lnd, 'docker-compose.yml'), netOverride, lndOverride]
	composeCalls.push(
		{project: projects.cln, files: clnFiles, env: clnEnv},
		{project: projects.lnd, files: lndFiles, env: lndEnv},
	)

	compose(projects.cln, clnFiles, clnEnv, 'up', '-d', 'lightningd')
	compose(projects.lnd, lndFiles, lndEnv, 'up', '-d', 'lnd')

	const lcli = (...args) =>
		JSON.parse(
			compose(
				projects.cln,
				clnFiles,
				clnEnv,
				'exec',
				'-T',
				'lightningd',
				'lightning-cli',
				'--lightning-dir=/root/.lightning',
				'--network=regtest',
				...args,
			),
		)

	const lndTlsPath = path.join(dirs.lnd, 'data/lnd/tls.cert')
	const lndInit = await until('LND REST API ready for wallet init', async () => {
		const ca = await readFile(lndTlsPath)
		const seedResp = await lndRest('GET', '/v1/genseed', {ca})
		assert.ok(Array.isArray(seedResp.cipher_seed_mnemonic))
		return {ca, mnemonic: seedResp.cipher_seed_mnemonic}
	})
	const lndWalletSecret = randomBytes(16).toString('hex')
	await lndRest('POST', '/v1/initwallet', {
		ca: lndInit.ca,
		body: {
			wallet_password: Buffer.from(lndWalletSecret).toString('base64'),
			cipher_seed_mnemonic: lndInit.mnemonic,
		},
	})

	const lndMacaroonPath = path.join(dirs.lnd, 'data/lnd/data/chain/bitcoin/regtest/admin.macaroon')
	const lndMacaroonHex = await until(`LND synced to height ${currentHeight}`, async () => {
		const macaroonHex = execFileSync(SUDO_BIN, ['cat', lndMacaroonPath]).toString('hex')
		const info = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex})
		assert.equal(info.synced_to_chain, true)
		assert.equal(info.block_height, currentHeight)
		return macaroonHex
	})
	await until(`CLN synced to height ${currentHeight}`, () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
	})

	// Fund both CLN and LND with 1 BTC each
	const clnAddr = lcli('newaddr').bech32
	const lndAddr = (
		await lndRest('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
	).address
	rootsCli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${clnAddr}`, 'amount=1.0', 'fee_rate=10')
	rootsCli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${lndAddr}`, 'amount=1.0', 'fee_rate=10')
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	currentHeight += 6

	await until(`CLN & LND both confirm 1 BTC at height ${currentHeight}`, async () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
		const clnConfirmed = lcli('listfunds').outputs.find(
			(o) => o.status === 'confirmed' && o.amount_msat === 100_000_000_000,
		)
		assert.ok(clnConfirmed)
		const lndInfo = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(lndInfo.block_height, currentHeight)
		const lndBal = await lndRest('GET', '/v1/balance/blockchain', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(Number(lndBal.confirmed_balance), 100_000_000)
	})
	console.log(`PASS [Stage 3]: CLN & LND synced and confirmed 1 BTC each at height ${currentHeight}`)

	// =========================================================================
	// STAGE 4: Real Lightning Channel Open + BOLT11 Payment + Cooperative Close
	// =========================================================================
	console.log('\n==> [Stage 4] Opening real 500k sat Lightning channel CLN -> LND, paying 50k sat invoice, and closing...')
	const lndInfoBeforeChan = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
	const lndPubkey = lndInfoBeforeChan.identity_pubkey
	lcli('connect', `${lndPubkey}@${lndEnv.APP_LIGHTNING_NODE_IP}:${lndEnv.APP_LIGHTNING_NODE_PORT}`)
	const fundResp = lcli('fundchannel', '-k', `id=${lndPubkey}`, 'amount=500000', 'feerate=1000perkw')
	assert.ok(fundResp.channel_id, 'fundchannel did not return channel_id')

	rootsCli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	currentHeight += 6

	await until('CLN <-> LND channel active on both nodes', async () => {
		const clnChans = lcli('listpeerchannels').channels
		const activeCln = clnChans.find((c) => c.state === 'CHANNELD_NORMAL')
		assert.ok(activeCln, `CLN channel not normal yet: ${JSON.stringify(clnChans)}`)
		const lndChans = (await lndRest('GET', '/v1/channels', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).channels ?? []
		const activeLnd = lndChans.find((c) => c.active === true)
		assert.ok(activeLnd, `LND channel not active yet: ${JSON.stringify(lndChans)}`)
	})

	const invoice = await lndRest('POST', '/v1/invoices', {
		ca: lndInit.ca,
		macaroonHex: lndMacaroonHex,
		body: {value: '50000', memo: 'pi5-stress-test-payment'},
	})
	const payResult = lcli('pay', invoice.payment_request)
	assert.equal(payResult.status, 'complete')

	const settledCheck = await lndRest('GET', '/v1/invoices', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
	assert.ok(settledCheck.invoices.some((inv) => inv.memo === 'pi5-stress-test-payment' && inv.settled === true))

	lcli('close', fundResp.channel_id)
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	currentHeight += 6
	await until('Cooperative channel close confirmed on LND', async () => {
		const lndChans = (await lndRest('GET', '/v1/channels', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).channels ?? []
		assert.equal(lndChans.length, 0)
	})
	console.log(`PASS [Stage 4]: Real CLN <-> LND channel opened, 50k sat payment settled, and cooperatively closed (height ${currentHeight})`)

	// =========================================================================
	// STAGE 5: Official Electrs (Cookie Auth + Whitebind P2P + Electrum TCP)
	// =========================================================================
	console.log('\n==> [Stage 5] Starting official Electrs (getumbrel/electrs) wired to Bitcoin Roots...')
	const electrsEnv = sourceUmbrelEnv({
		callerApp: 'electrs',
		appDir: dirs.electrs,
		dataRoots,
		exportsChain: [
			rootsExportEntry,
			{id: 'electrs', dir: dirs.electrs, dataRoot: dataRoots.electrs, file: path.join(dirs.electrs, 'exports.sh')},
		],
	})
	const electrsOverride = path.join(workDir, 'electrs-override.yml')
	await writeFile(
		electrsOverride,
		`services:
  electrs:
    ports: !override
      - '127.0.0.1:15001:50001'
`,
	)
	const electrsFiles = [path.join(dirs.electrs, 'docker-compose.yml'), netOverride, electrsOverride]
	composeCalls.push({project: projects.electrs, files: electrsFiles, env: electrsEnv})
	compose(projects.electrs, electrsFiles, electrsEnv, 'up', '-d', 'electrs')

	const electrumTip = await until(`Electrs indexes Bitcoin Roots to height ${currentHeight}`, async () => {
		const ver = await electrumRpc(15001, 'server.version', ['pi5-e2e', '1.4'])
		assert.ok(Array.isArray(ver) && ver.length >= 2)
		const tip = await electrumRpc(15001, 'blockchain.headers.subscribe')
		assert.equal(tip.height, currentHeight)
		return {ver, tip}
	})
	console.log('PASS [Stage 5]: Electrs synced via Roots .cookie + whitebind P2P:', electrumTip.ver, 'height:', electrumTip.tip.height)

	// =========================================================================
	// STAGE 6: Bassin (Cap'n Proto IPC) + Official Public Pool (Stratum v1)
	// =========================================================================
	console.log('\n==> [Stage 6] Starting Bassin (IPC + UI) and official Public Pool (RPC + Stratum v1)...')
	const bassinEnv = sourceUmbrelEnv({
		callerApp: 'blockdyor-bassin',
		appDir: dirs.bassin,
		dataRoots,
		exportsChain: [rootsExportEntry],
	})
	const publicPoolEnv = sourceUmbrelEnv({
		callerApp: 'public-pool',
		appDir: dirs.publicPool,
		dataRoots,
		exportsChain: [rootsExportEntry],
	})

	const bassinOverride = path.join(workDir, 'bassin-override.yml')
	await writeFile(
		bassinOverride,
		`services:
  ui:
    ports:
      - '127.0.0.1:18080:8080'
`,
	)
	const publicPoolOverride = path.join(workDir, 'public-pool-override.yml')
	await writeFile(
		publicPoolOverride,
		`services:
  server:
    ports: !override
      - '127.0.0.1:12018:2018'
      - '127.0.0.1:12019:2019'
    environment:
      - NETWORK=regtest
`,
	)

	const bassinFiles = [path.join(dirs.bassin, 'docker-compose.yml'), netOverride, bassinOverride]
	const publicPoolFiles = [path.join(dirs.publicPool, 'docker-compose.yml'), netOverride, publicPoolOverride]
	composeCalls.push(
		{project: projects.bassin, files: bassinFiles, env: bassinEnv},
		{project: projects.publicPool, files: publicPoolFiles, env: publicPoolEnv},
	)

	compose(projects.bassin, bassinFiles, bassinEnv, 'up', '-d', 'ckpool', 'ui')
	compose(projects.publicPool, publicPoolFiles, publicPoolEnv, 'up', '-d', 'server')

	await until('Bassin CKPool stratifier ready & UI HTTP 200', async () => {
		const logs = compose(projects.bassin, bassinFiles, bassinEnv, 'logs', '--no-color', 'ckpool')
		assert.ok(/ckpool stratifier ready/i.test(logs) && !/Failed to connect|auth failed|401/i.test(logs))
		const res = await fetch('http://127.0.0.1:18080/')
		assert.equal(res.status, 200)
	})
	await until(`Public Pool RPC reports height ${currentHeight}`, async () => {
		const res = await fetch('http://127.0.0.1:12019/api/network')
		assert.equal(res.status, 200)
		const info = await res.json()
		assert.equal(info.chain, 'regtest')
		assert.equal(info.blocks, currentHeight)
	})
	const stratumJob = await until('Public Pool serves live Stratum v1 job', () => testStratumV1(12018, minerAddr))
	console.log('PASS [Stage 6]: Bassin (IPC + UI) & Public Pool (RPC + Stratum job', stratumJob.jobId, ') healthy')

	snapshotDockerStats('after full 6-app stack boot')

	// =========================================================================
	// STAGE 7: Mempool Burst (50 rapid txs) + Concurrent REST & WebSocket Stress
	// =========================================================================
	console.log('\n==> [Stage 7] Stress-testing mempool burst (50 rapid txs) + concurrent REST API & WebSockets...')
	let wsTxPings = 0
	let wsBlocks = 0
	const txWs = new WebSocket('ws://127.0.0.1:13000/ws/transactions')
	const blockWs = new WebSocket('ws://127.0.0.1:13000/ws/blocks')
	await Promise.all([
		new Promise((resolve, reject) => {
			txWs.addEventListener('open', resolve, {once: true})
			txWs.addEventListener('error', reject, {once: true})
		}),
		new Promise((resolve, reject) => {
			blockWs.addEventListener('open', resolve, {once: true})
			blockWs.addEventListener('error', reject, {once: true})
		}),
	])
	txWs.addEventListener('message', () => {
		wsTxPings += 1
	})
	blockWs.addEventListener('message', () => {
		wsBlocks += 1
	})

	// Allow demand-driven ZMQ hashtx subscriber to finish syncing/subscribing before blasting txs
	await delay(3000)

	const apiPaths = [
		'/api/stats',
		'/api/sync',
		'/api/peers/locations',
		'/api/blocks?limit=50',
		'/api/widget/stats',
		'/api/widget/sync',
		'/api/connect/details',
	]
	const apiStorm = (async () => {
		for (let round = 0; round < 5; round++) {
			const responses = await Promise.all(apiPaths.map((p) => fetch(`http://127.0.0.1:13000${p}`)))
			for (const res of responses) {
				assert.equal(res.status, 200, `API ${res.url} returned HTTP ${res.status}`)
				await res.text()
			}
			await delay(200)
		}
	})()

	const sinkAddr = rootsCli('-rpcwallet=miner', 'getnewaddress')
	for (let i = 0; i < 50; i++) {
		rootsCli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${sinkAddr}`, 'amount=0.01', 'fee_rate=5')
	}
	await apiStorm

	// Mine 1 block to flush the 50 txs and trigger /ws/blocks
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '1', minerAddr)
	currentHeight += 1

	await until('WebSocket receives live txPing & block frames', () => {
		assert.ok(wsTxPings >= 1, `expected wsTxPings >= 1, got ${wsTxPings}`)
		assert.ok(wsBlocks >= 1, `expected wsBlocks >= 1, got ${wsBlocks}`)
	}, 20, 1000)
	txWs.close()
	blockWs.close()
	console.log(`PASS [Stage 7]: 50-tx burst + 35 concurrent API calls passed (wsTxPings=${wsTxPings}, wsBlocks=${wsBlocks})`)

	snapshotDockerStats('during peak load')

	// =========================================================================
	// STAGE 8: Live Roots Policy Enforcement (datacarrier=0) + 15-block Catch-Up
	// =========================================================================
	console.log('\n==> [Stage 8] Applying strict Roots policy via PATCH /api/config/settings & verifying OP_RETURN rejection...')
	const onionsBefore = await until('Bitcoin Roots Tor onion hostnames discovered', async () => {
		const res = await fetch('http://127.0.0.1:13000/api/connect/details')
		assert.equal(res.status, 200)
		const details = await res.json()
		assert.match(details.p2p.tor.host, /^[a-z2-7]{56}\.onion$/)
		assert.match(details.rpc.tor.host, /^[a-z2-7]{56}\.onion$/)
		return details
	})

	const patchRes = await fetch('http://127.0.0.1:13000/api/config/settings', {
		method: 'PATCH',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			datacarrier: false,
			rejecttokens: true,
			rejectparasites: true,
			permitbaremultisig: false,
			dbcache: 128,
			maxmempool: 100,
		}),
	})
	assert.equal(patchRes.status, 200, `PATCH settings failed: HTTP ${patchRes.status} ${await patchRes.text()}`)

	await until('Bitcoin Roots restarts with strict policy & preserves height', () => {
		const info = JSON.parse(rootsCli('getblockchaininfo'))
		assert.equal(info.blocks, currentHeight)
		const conf = compose(projects.roots, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'cat', '/data/bitcoin/umbrel-bitcoin.conf')
		assert.ok(conf.includes('datacarrier=0'))
		assert.ok(conf.includes('rejecttokens=1'))
		assert.ok(conf.includes('rejectparasites=1'))
		assert.ok(conf.includes('permitbaremultisig=0'))
		assert.ok(conf.includes('dbcache=128'))
		assert.ok(conf.includes('maxmempool=100'))
	})

	// Reload miner wallet after bitcoind restart and test that an OP_RETURN tx is rejected under datacarrier=0
	try {
		rootsCli('loadwallet', 'miner')
	} catch {}
	const rawOpReturn = rootsCli('createrawtransaction', '[]', JSON.stringify([{data: 'deadbeef'}]))
	const fundedOpReturn = JSON.parse(rootsCli('-rpcwallet=miner', 'fundrawtransaction', rawOpReturn, JSON.stringify({fee_rate: 10}))).hex
	const signedOpReturn = JSON.parse(rootsCli('-rpcwallet=miner', 'signrawtransactionwithwallet', fundedOpReturn)).hex
	let opReturnRejected = false
	try {
		rootsCli('sendrawtransaction', signedOpReturn)
	} catch (err) {
		opReturnRejected = /scriptpubkey|datacarrier|non-mandatory-script|bad-txns/i.test(String(err.stderr || err.message))
		assert.ok(opReturnRejected, `Unexpected OP_RETURN error: ${err.stderr || err.message}`)
	}
	assert.ok(opReturnRejected, 'OP_RETURN transaction was NOT rejected despite datacarrier=0!')

	// Mine 15 rapid blocks and verify all downstream apps survive restart & catch up
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '15', minerAddr)
	currentHeight += 15

	await until(`All ecosystem apps (CLN, LND, Electrs, Public Pool) catch up to height ${currentHeight}`, async () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
		const lndInfo = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(lndInfo.block_height, currentHeight)
		const elecTip = await electrumRpc(15001, 'blockchain.headers.subscribe')
		assert.equal(elecTip.height, currentHeight)
		const ppInfo = await (await fetch('http://127.0.0.1:12019/api/network')).json()
		assert.equal(ppInfo.blocks, currentHeight)
	})
	console.log(`PASS [Stage 8]: datacarrier=0 rejected OP_RETURN live, and CLN/LND/Electrs/Public Pool all caught up to height ${currentHeight}`)

	// =========================================================================
	// STAGE 9: Abrupt Crash / Power-Loss Recovery (SIGKILL on Roots app + tor)
	// =========================================================================
	console.log('\n==> [Stage 9] Simulating abrupt power loss (SIGKILL on Bitcoin Roots app + tor)...')
	compose(projects.roots, rootsFiles, rootsEnv, 'kill', '-s', 'SIGKILL', 'app', 'tor')
	compose(projects.roots, rootsFiles, rootsEnv, 'up', '-d', 'app', 'tor')

	await until('Bitcoin Roots recovers from SIGKILL with identical Tor onions', async () => {
		const info = JSON.parse(rootsCli('getblockchaininfo'))
		assert.equal(info.blocks, currentHeight)
		const res = await fetch('http://127.0.0.1:13000/api/connect/details')
		assert.equal(res.status, 200)
		const details = await res.json()
		assert.equal(details.p2p.tor.host, onionsBefore.p2p.tor.host)
		assert.equal(details.rpc.tor.host, onionsBefore.rpc.tor.host)
	})
	try {
		rootsCli('loadwallet', 'miner')
	} catch {}
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '1', minerAddr)
	currentHeight += 1

	await until(`Ecosystem recovers after SIGKILL & reaches height ${currentHeight}`, async () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
		const lndInfo = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(lndInfo.block_height, currentHeight)
		const elecTip = await electrumRpc(15001, 'blockchain.headers.subscribe')
		assert.equal(elecTip.height, currentHeight)
		const ppInfo = await (await fetch('http://127.0.0.1:12019/api/network')).json()
		assert.equal(ppInfo.blocks, currentHeight)
	})
	const i2pState = compose(projects.roots, rootsFiles, rootsEnv, 'ps', '--format', '{{.State}}', 'i2p').trim()
	assert.equal(i2pState, 'running', `i2p state was ${i2pState}`)
	console.log(`PASS [Stage 9]: SIGKILL crash recovery succeeded, Tor onions persisted, and all apps converged at height ${currentHeight}`)

	// =========================================================================
	// STAGE 10: Raspberry Pi 5 Live RAM Budget Audit
	// =========================================================================
	const finalStats = snapshotDockerStats('post-stress final audit')
	const procStatus = compose(projects.roots, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'cat', '/proc/1/status')
	const rssMatch = /VmRSS:\s+(\d+)\s+kB/.exec(procStatus)
	assert.ok(rssMatch, `Could not parse VmRSS from /proc/1/status:\n${procStatus}`)
	const nodeRssMiB = Number(rssMatch[1]) / 1024
	console.log(`Node.js backend PID 1 RSS inside Bitcoin Roots app container: ${nodeRssMiB.toFixed(1)} MiB`)
	assert.ok(nodeRssMiB < 180, `Node.js backend RSS too high for Pi 5: ${nodeRssMiB.toFixed(1)} MiB`)

	const i2pEntry = Object.entries(finalStats).find(([name]) => name.includes(`${projects.roots}-i2p`))
	assert.ok(i2pEntry, 'i2p container missing from docker stats')
	assert.ok(i2pEntry[1].mib < 150, `i2p (--notransit) RAM too high: ${i2pEntry[1].mib.toFixed(1)} MiB`)

	console.log(
		`\nALL 10 PI 5 STRESS STAGES PASSED [${arch()}]: Core->Roots Migration + CLN<->LND Channel/Payment + Electrs + Bassin IPC + Public Pool Stratum + 50-tx/WS Burst + Policy Enforcement + SIGKILL Recovery + RAM Audit`,
	)
} catch (error) {
	for (const {project, files, env} of composeCalls) {
		try {
			console.error(`\n=== LOGS: ${project} ===`)
			console.error(compose(project, files, env, 'logs', '--no-color', '--tail', '60'))
		} catch {}
	}
	throw error
} finally {
	for (const {project, files, env} of composeCalls.reverse()) {
		try {
			compose(project, files, env, 'down', '--volumes', '--remove-orphans', '--timeout', '20')
		} catch {}
	}
	try {
		run(DOCKER_BIN, ['rm', '-f', torContainer])
	} catch {}
	try {
		run(DOCKER_BIN, ['network', 'rm', networkName])
	} catch {}
	await rm(workDir, {recursive: true, force: true}).catch(() => {
		try {
			run(SUDO_BIN, ['rm', '-rf', workDir])
		} catch {}
	})
}
