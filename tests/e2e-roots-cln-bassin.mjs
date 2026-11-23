// End-to-end umbrelOS simulation on the real 10.21.0.0/16 Docker network:
// 1. Boots blockdyor-bitcoin-roots (regtest + IPC enabled) using its real exports.sh & docker-compose.yml
// 2. Boots official getumbrel/umbrel-apps core-lightning (verbatim lightningd command) wired via exports.sh
//    and verifies RPC auth, block sync, funding tx, and confirmation tracking
// 3. Boots blockdyor-bassin wired via exports.sh and verifies CKPool connects to Bitcoin Roots (RPC/ZMQ/IPC)
//    and Bassin UI serves HTTP 200.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {cp, chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(path.join(tmpdir(), 'umbrel-e2e-'))
const networkName = `umbrel-e2e-net-${process.pid}`
const rootsProject = `e2e-roots-${process.pid}`
const clnProject = `e2e-cln-${process.pid}`
const bassinProject = `e2e-bassin-${process.pid}`
const torContainer = `e2e-umbrel-tor-${process.pid}`

const UMBREL_SEED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const TOR_PROXY_IP = '10.21.21.11'
const TOR_PROXY_PORT = '9050'
const TOR_PASSWORD = 'mLcLDdt5qqMxlq3wv8Din3UD44bTZHzRFhIktw38kWg='
const TOR_HASHED_PASSWORD = '16:158FBE422B1A9D996073BE2B9EC38852C70CE12362CA016F8F6859C426'

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, {
		encoding: 'utf8',
		timeout: 240_000,
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

// Reproduces umbreld's legacy-compat/app-script `source_app()` behavior faithfully.
function sourceUmbrelEnv({callerApp, appDir, dataRoots, exportsChain}) {
	const script = `
set -euo pipefail
derive_entropy() {
  printf "%s" "$1" | openssl dgst -sha256 -hmac "${UMBREL_SEED}" | sed 's/^.* //'
}
app_entropy_identifier="app-${callerApp}-seed"
export NETWORK_IP="10.21.0.0"
export DEVICE_HOSTNAME="umbrel"
export DEVICE_DOMAIN_NAME="umbrel.local"
export TOR_PROXY_IP="${TOR_PROXY_IP}"
export TOR_PROXY_PORT="${TOR_PROXY_PORT}"
export TOR_PASSWORD="${TOR_PASSWORD}"
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
export APP_PASSWORD="$(derive_entropy "app-${callerApp}-seed-APP_PASSWORD")"
env -0
`
	const raw = run('bash', ['-c', script])
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
	return run('docker', args, {env: {...process.env, ...env}})
}

async function fetchText(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
	return res.text()
}

try {
	await chmod(workDir, 0o755)
	const torDataDir = path.join(workDir, 'tor-data')
	await mkdir(torDataDir, {recursive: true, mode: 0o777})
	await chmod(torDataDir, 0o777)

	// 1. Create the Umbrel 10.21.0.0/16 bridge network
	run('docker', ['network', 'create', '--subnet=10.21.0.0/16', networkName])

	// 2. Start Umbrel's shared Tor proxy on 10.21.21.11 (needed by official core-lightning's verbatim command)
	const umbrelTorrc = path.join(workDir, 'umbrel-torrc')
	await writeFile(
		umbrelTorrc,
		[
			'DataDirectory /tmp/tor-data',
			'SocksPort 0.0.0.0:9050',
			'ControlPort 0.0.0.0:29051',
			`HashedControlPassword ${TOR_HASHED_PASSWORD}`,
			'Log notice stdout',
		].join('\n') + '\n',
	)
	run('docker', [
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
		'ghcr.io/getumbrel/tor:0.4.9.11@sha256:e382b8629c0dfef6ceb396b062622d4e4e955b19d6f16b883fd2c0723ad5671a',
		'-f',
		'/etc/tor/torrc',
	])

	// Prepare isolated app directories mimicking /umbrel/app-data/<app-id>
	const rootsDir = path.join(workDir, 'blockdyor-bitcoin-roots')
	const clnDir = path.join(workDir, 'core-lightning')
	const bassinDir = path.join(workDir, 'blockdyor-bassin')

	await cp(path.join(repoRoot, 'blockdyor-bitcoin-roots'), rootsDir, {recursive: true})
	await cp(path.join(repoRoot, 'blockdyor-bassin'), bassinDir, {recursive: true})
	await mkdir(path.join(rootsDir, 'data/app'), {recursive: true})
	await mkdir(path.join(rootsDir, 'data/bitcoin'), {recursive: true})
	await mkdir(path.join(rootsDir, 'data/i2pd'), {recursive: true})
	await mkdir(path.join(clnDir, 'data/lightningd'), {recursive: true})
	await mkdir(path.join(clnDir, 'data/app'), {recursive: true})
	await mkdir(path.join(bassinDir, 'data/www'), {recursive: true})
	await mkdir(path.join(bassinDir, 'data/sv2'), {recursive: true})

	// Configure Bitcoin Roots on regtest with IPC enabled (so we test both CLN RPC and Bassin IPC/RPC/ZMQ)
	await writeFile(
		path.join(rootsDir, 'data/app/settings.json'),
		JSON.stringify({chain: 'regtest', ipc: true}, null, 2) + '\n',
	)
	run('chmod', ['-R', 'a+rwx', path.join(rootsDir, 'data'), path.join(clnDir, 'data'), path.join(bassinDir, 'data')])

	// Fetch official Core Lightning exports.sh & docker-compose.yml from getumbrel/umbrel-apps
	const clnBase = 'https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/core-lightning'
	await writeFile(path.join(clnDir, 'exports.sh'), await fetchText(`${clnBase}/exports.sh`))
	await writeFile(path.join(clnDir, 'docker-compose.yml'), await fetchText(`${clnBase}/docker-compose.yml`))

	const dataRoots = {
		'blockdyor-bitcoin-roots': path.join(rootsDir, 'data'),
		'core-lightning': path.join(clnDir, 'data'),
		'blockdyor-bassin': path.join(bassinDir, 'data'),
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

	// 3. Boot blockdyor-bitcoin-roots using its real exports.sh and docker-compose.yml
	const rootsEnv = sourceUmbrelEnv({
		callerApp: 'blockdyor-bitcoin-roots',
		appDir: rootsDir,
		dataRoots,
		exportsChain: [
			{
				id: 'blockdyor-bitcoin-roots',
				dir: rootsDir,
				dataRoot: dataRoots['blockdyor-bitcoin-roots'],
				file: path.join(rootsDir, 'exports.sh'),
			},
		],
	})
	assert.equal(rootsEnv.APP_BITCOIN_NETWORK, 'regtest')
	assert.equal(rootsEnv.APP_BITCOIN_IPC_ENABLED, 'true')
	assert.equal(rootsEnv.APP_BITCOIN_IPC_SOCKET_RELATIVE_PATH, 'regtest/node.sock')

	const rootsFiles = [path.join(rootsDir, 'docker-compose.yml'), netOverride]
	composeCalls.push({project: rootsProject, files: rootsFiles, env: rootsEnv})
	console.log('==> Starting blockdyor-bitcoin-roots (app + tor + i2p)...')
	compose(rootsProject, rootsFiles, rootsEnv, 'up', '-d', 'app', 'tor', 'i2p')

	const bcli = (...args) =>
		compose(
			rootsProject,
			rootsFiles,
			rootsEnv,
			'exec',
			'-T',
			'app',
			'bitcoin-cli',
			'-datadir=/data/bitcoin',
			'-regtest',
			'-rpcport=8332',
			...args,
		).trim()

	await until('Bitcoin Roots RPC ready', () => {
		const info = JSON.parse(bcli('getblockchaininfo'))
		assert.equal(info.chain, 'regtest')
		return info
	})

	const versionJson = JSON.parse(
		compose(
			rootsProject,
			rootsFiles,
			rootsEnv,
			'exec',
			'-T',
			'app',
			'node',
			'-e',
			`fetch('http://127.0.0.1:3000/api/bitcoind/version').then(r=>r.text()).then(console.log)`,
		),
	)
	assert.equal(versionJson.implementation, 'Bitcoin Roots')
	assert.equal(versionJson.version, 'v30.3-roots.1')
	console.log('PASS: Bitcoin Roots started cleanly:', versionJson)

	// Verify IPC socket was created on regtest/node.sock
	await until('Bitcoin Roots IPC socket', () => {
		compose(rootsProject, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'test', '-S', '/data/bitcoin/regtest/node.sock')
	})
	console.log('PASS: Bitcoin Roots IPC socket active at /data/bitcoin/regtest/node.sock')

	// Create regtest wallet and mine 101 blocks so CLN & Bassin have a real active chain with spendable coins
	bcli('createwallet', 'miner')
	const minerAddr = bcli('-rpcwallet=miner', 'getnewaddress')
	bcli('-rpcwallet=miner', 'generatetoaddress', '101', minerAddr)
	assert.equal(JSON.parse(bcli('getblockchaininfo')).blocks, 101)
	console.log('PASS: Mined 101 regtest blocks on Bitcoin Roots')

	// 4. Boot official Core Lightning connected to Bitcoin Roots via exports.sh
	const clnEnv = sourceUmbrelEnv({
		callerApp: 'core-lightning',
		appDir: clnDir,
		dataRoots,
		exportsChain: [
			{
				id: 'blockdyor-bitcoin-roots',
				dir: rootsDir,
				dataRoot: dataRoots['blockdyor-bitcoin-roots'],
				file: path.join(rootsDir, 'exports.sh'),
			},
			{
				id: 'core-lightning',
				dir: clnDir,
				dataRoot: dataRoots['core-lightning'],
				file: path.join(clnDir, 'exports.sh'),
			},
		],
	})
	assert.equal(clnEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS, 'CLN must derive identical RPC pass')
	assert.equal(clnEnv.APP_CORE_LIGHTNING_BITCOIN_NETWORK, 'regtest')

	const clnFiles = [path.join(clnDir, 'docker-compose.yml'), netOverride]
	composeCalls.push({project: clnProject, files: clnFiles, env: clnEnv})
	console.log('==> Starting official Core Lightning (lightningd) wired to Bitcoin Roots...')
	compose(clnProject, clnFiles, clnEnv, 'up', '-d', 'lightningd')

	const lcli = (...args) =>
		JSON.parse(
			compose(
				clnProject,
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

	const clnInfo = await until('Core Lightning synced to height 101', () => {
		const info = lcli('getinfo')
		assert.equal(info.network, 'regtest')
		assert.equal(info.blockheight, 101)
		return info
	})
	console.log('PASS: Core Lightning synced to Bitcoin Roots at blockheight', clnInfo.blockheight, 'id:', clnInfo.id)

	// Fund CLN from Bitcoin Roots, mine 6 blocks, and verify CLN sees the confirmed on-chain funds
	const clnAddr = lcli('newaddr').bech32
	assert.ok(clnAddr.startsWith('bcrt1'), `unexpected CLN address: ${clnAddr}`)
	bcli('-rpcwallet=miner', 'sendtoaddress', clnAddr, '1.0')
	bcli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)

	await until('Core Lightning confirms 1 BTC deposit at height 107', () => {
		const info = lcli('getinfo')
		assert.equal(info.blockheight, 107)
		const funds = lcli('listfunds')
		const confirmed = funds.outputs.find((o) => o.status === 'confirmed' && o.amount_msat === 100_000_000_000)
		assert.ok(confirmed, 'confirmed 1 BTC output not found in CLN listfunds')
	})
	console.log('PASS: Core Lightning received & confirmed 1 BTC transaction from Bitcoin Roots (height 107)')

	// 5. Boot blockdyor-bassin connected to Bitcoin Roots via exports.sh
	const bassinEnv = sourceUmbrelEnv({
		callerApp: 'blockdyor-bassin',
		appDir: bassinDir,
		dataRoots,
		exportsChain: [
			{
				id: 'blockdyor-bitcoin-roots',
				dir: rootsDir,
				dataRoot: dataRoots['blockdyor-bitcoin-roots'],
				file: path.join(rootsDir, 'exports.sh'),
			},
		],
	})
	assert.equal(bassinEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS, 'Bassin must derive identical RPC pass')

	const bassinFiles = [path.join(bassinDir, 'docker-compose.yml'), netOverride]
	composeCalls.push({project: bassinProject, files: bassinFiles, env: bassinEnv})
	console.log('==> Starting blockdyor-bassin (init + ckpool + ui) wired to Bitcoin Roots...')
	compose(bassinProject, bassinFiles, bassinEnv, 'up', '-d', 'ckpool', 'ui')

	await until('Bassin CKPool connected to Bitcoin Roots & UI healthy', () => {
		const logs = compose(bassinProject, bassinFiles, bassinEnv, 'logs', '--no-color', 'ckpool')
		assert.ok(
			/bitcoind|IPC|Connected|New block|Stratum/i.test(logs) && !/Failed to connect|auth failed|401/i.test(logs),
			`unexpected ckpool logs:\n${logs}`,
		)
		const status = compose(
			bassinProject,
			bassinFiles,
			bassinEnv,
			'exec',
			'-T',
			'ui',
			'node',
			'-e',
			`fetch('http://127.0.0.1:8080/').then(r=>console.log(r.status))`,
		).trim()
		assert.equal(status, '200')
	})
	const ckLogs = compose(bassinProject, bassinFiles, bassinEnv, 'logs', '--no-color', '--tail', '30', 'ckpool')
	console.log('PASS: Bassin CKPool + UI connected to Bitcoin Roots:\n' + ckLogs)

	// Verify i2p sidecar stayed up cleanly
	const i2pState = compose(rootsProject, rootsFiles, rootsEnv, 'ps', '--format', '{{.State}}', 'i2p').trim()
	assert.equal(i2pState, 'running', `i2p container state was ${i2pState}`)
	console.log('PASS: Bitcoin Roots I2P sidecar running cleanly')

	console.log('\nALL E2E CHECKS PASSED: Bitcoin Roots + Core Lightning + Bassin')
} catch (error) {
	for (const {project, files, env} of composeCalls) {
		try {
			console.error(`\n=== LOGS: ${project} ===`)
			console.error(compose(project, files, env, 'logs', '--no-color', '--tail', '80'))
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
		run('docker', ['rm', '-f', torContainer])
	} catch {}
	try {
		run('docker', ['network', 'rm', networkName])
	} catch {}
	await rm(workDir, {recursive: true, force: true}).catch(() => {})
}
