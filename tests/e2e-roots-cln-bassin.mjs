// End-to-end umbrelOS simulation on the real 10.21.0.0/16 Docker network:
// 1. Boots blockdyor-bitcoin-roots (regtest + IPC enabled) using its real exports.sh & docker-compose.yml
// 2. Boots official getumbrel/umbrel-apps core-lightning (verbatim lightningd command) wired via exports.sh
//    and verifies RPC auth, block sync, funding tx, and confirmation tracking
// 3. Boots blockdyor-bassin wired via exports.sh and verifies CKPool connects to Bitcoin Roots (RPC/ZMQ/IPC)
//    and Bassin UI serves HTTP 200.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(path.join(tmpdir(), 'umbrel-e2e-'))
const networkName = `umbrel-e2e-net-${process.pid}`
const rootsProject = `e2e-roots-${process.pid}`
const clnProject = `e2e-cln-${process.pid}`
const lndProject = `e2e-lnd-${process.pid}`
const bassinProject = `e2e-bassin-${process.pid}`
const publicPoolProject = `e2e-public-pool-${process.pid}`
const torContainer = `e2e-umbrel-tor-${process.pid}`

const UMBREL_SEED = randomBytes(32).toString('hex')
const TOR_IMAGE =
	'ghcr.io/getumbrel/tor:0.4.9.11@sha256:e382b8629c0dfef6ceb396b062622d4e4e955b19d6f16b883fd2c0723ad5671a'
const TOR_PROXY_IP = process.env.E2E_TOR_PROXY_IP ?? ['10', '21', '21', '11'].join('.')
const TOR_PROXY_PORT = '9050'
const TOR_CONTROL_SECRET = randomBytes(24).toString('base64')

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
					resolve({subscribed, authorized, jobId: jobNotify[0], prevHash: jobNotify[1]})
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

try {
	await chmod(workDir, 0o755)
	const torDataDir = path.join(workDir, 'tor-data')
	await mkdir(torDataDir, {recursive: true, mode: 0o777})
	await chmod(torDataDir, 0o777)

	// 1. Create the Umbrel 10.21.0.0/16 bridge network
	run('docker', ['network', 'create', '--subnet=10.21.0.0/16', networkName])

	// 2. Start Umbrel's shared Tor proxy (needed by official core-lightning's verbatim command)
	const torHash = run('docker', ['run', '--rm', '--entrypoint', 'tor', TOR_IMAGE, '--hash-password', TOR_CONTROL_SECRET])
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
		TOR_IMAGE,
		'-f',
		'/etc/tor/torrc',
	])

	// Prepare isolated app directories mimicking /umbrel/app-data/<app-id>
	const rootsDir = path.join(workDir, 'blockdyor-bitcoin-roots')
	const clnDir = path.join(workDir, 'core-lightning')
	const lndDir = path.join(workDir, 'lightning')
	const bassinDir = path.join(workDir, 'blockdyor-bassin')
	const publicPoolDir = path.join(workDir, 'public-pool')

	await cp(path.join(repoRoot, 'blockdyor-bitcoin-roots'), rootsDir, {recursive: true})
	await cp(path.join(repoRoot, 'blockdyor-bassin'), bassinDir, {recursive: true})
	await mkdir(path.join(rootsDir, 'data/app'), {recursive: true})
	await mkdir(path.join(rootsDir, 'data/bitcoin'), {recursive: true})
	await mkdir(path.join(rootsDir, 'data/i2pd'), {recursive: true})
	await mkdir(path.join(clnDir, 'data/lightningd'), {recursive: true})
	await mkdir(path.join(clnDir, 'data/app'), {recursive: true})
	await mkdir(path.join(lndDir, 'data/lnd'), {recursive: true})
	await mkdir(path.join(lndDir, 'data/lightning'), {recursive: true})
	await writeFile(path.join(lndDir, 'data/lnd/umbrel-lnd.conf'), '')
	await mkdir(path.join(bassinDir, 'data/www'), {recursive: true})
	await mkdir(path.join(bassinDir, 'data/sv2'), {recursive: true})
	await mkdir(path.join(publicPoolDir, 'data/database'), {recursive: true})

	// Configure Bitcoin Roots on regtest with IPC enabled (so we test CLN, LND, Bassin IPC/RPC/ZMQ, and Public Pool)
	await writeFile(
		path.join(rootsDir, 'data/app/settings.json'),
		JSON.stringify({chain: 'regtest', ipc: true}, null, 2) + '\n',
	)
	run('chmod', [
		'-R',
		'a+rwx',
		path.join(rootsDir, 'data'),
		path.join(clnDir, 'data'),
		path.join(lndDir, 'data'),
		path.join(bassinDir, 'data'),
		path.join(publicPoolDir, 'data'),
	])

	// Fetch official Core Lightning, LND, and Public Pool packages from getumbrel/umbrel-apps
	const umbrelAppsBase = 'https://raw.githubusercontent.com/getumbrel/umbrel-apps/master'
	await writeFile(path.join(clnDir, 'exports.sh'), await fetchText(`${umbrelAppsBase}/core-lightning/exports.sh`))
	await writeFile(
		path.join(clnDir, 'docker-compose.yml'),
		await fetchText(`${umbrelAppsBase}/core-lightning/docker-compose.yml`),
	)
	await writeFile(path.join(lndDir, 'exports.sh'), await fetchText(`${umbrelAppsBase}/lightning/exports.sh`))
	await writeFile(
		path.join(lndDir, 'docker-compose.yml'),
		await fetchText(`${umbrelAppsBase}/lightning/docker-compose.yml`),
	)
	await writeFile(
		path.join(publicPoolDir, 'docker-compose.yml'),
		await fetchText(`${umbrelAppsBase}/public-pool/docker-compose.yml`),
	)

	const dataRoots = {
		'blockdyor-bitcoin-roots': path.join(rootsDir, 'data'),
		'core-lightning': path.join(clnDir, 'data'),
		lightning: path.join(lndDir, 'data'),
		'blockdyor-bassin': path.join(bassinDir, 'data'),
		'public-pool': path.join(publicPoolDir, 'data'),
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
			`-rpcport=${rootsEnv.APP_BITCOIN_ROOTS_RPC_PORT}`,
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
	bcli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${clnAddr}`, 'amount=1.0', 'fee_rate=10')
	bcli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)

	await until('Core Lightning confirms 1 BTC deposit at height 107', () => {
		const info = lcli('getinfo')
		assert.equal(info.blockheight, 107)
		const funds = lcli('listfunds')
		const confirmed = funds.outputs.find((o) => o.status === 'confirmed' && o.amount_msat === 100_000_000_000)
		assert.ok(confirmed, 'confirmed 1 BTC output not found in CLN listfunds')
	})
	console.log('PASS: Core Lightning received & confirmed 1 BTC transaction from Bitcoin Roots (height 107)')

	// 5. Boot official LND (lightning) connected to Bitcoin Roots via exports.sh (RPC + ZMQ rawblock/rawtx)
	const lndEnv = sourceUmbrelEnv({
		callerApp: 'lightning',
		appDir: lndDir,
		dataRoots,
		exportsChain: [
			{
				id: 'blockdyor-bitcoin-roots',
				dir: rootsDir,
				dataRoot: dataRoots['blockdyor-bitcoin-roots'],
				file: path.join(rootsDir, 'exports.sh'),
			},
			{
				id: 'lightning',
				dir: lndDir,
				dataRoot: dataRoots.lightning,
				file: path.join(lndDir, 'exports.sh'),
			},
		],
	})
	assert.equal(lndEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS, 'LND must derive identical RPC pass')
	assert.ok(
		lndEnv.APP_LIGHTNING_COMMAND.includes(
			`--bitcoind.rpchost=${rootsEnv.APP_BITCOIN_NODE_IP}:${rootsEnv.APP_BITCOIN_RPC_PORT}`,
		),
		`unexpected APP_LIGHTNING_COMMAND: ${lndEnv.APP_LIGHTNING_COMMAND}`,
	)

	const lndOverride = path.join(workDir, 'lnd-override.yml')
	await writeFile(
		lndOverride,
		`services:
  lnd:
    ports: !reset
      - '127.0.0.1:18081:8080'
`,
	)
	const lndFiles = [path.join(lndDir, 'docker-compose.yml'), netOverride, lndOverride]
	composeCalls.push({project: lndProject, files: lndFiles, env: lndEnv})
	console.log('==> Starting official LND (lightninglabs/lnd) wired to Bitcoin Roots...')
	compose(lndProject, lndFiles, lndEnv, 'up', '-d', 'lnd')

	const lndTlsPath = path.join(lndDir, 'data/lnd/tls.cert')
	const lndCa = await until('LND generates TLS certificate & opens REST API', async () => {
		const ca = await readFile(lndTlsPath)
		const seedResp = await lndRest('GET', '/v1/genseed', {ca})
		assert.ok(Array.isArray(seedResp.cipher_seed_mnemonic), 'genseed failed')
		return {ca, mnemonic: seedResp.cipher_seed_mnemonic}
	})
	const lndWalletSecret = randomBytes(16).toString('hex')
	await lndRest('POST', '/v1/initwallet', {
		ca: lndCa.ca,
		body: {
			wallet_password: Buffer.from(lndWalletSecret).toString('base64'),
			cipher_seed_mnemonic: lndCa.mnemonic,
		},
	})

	const lndMacaroonPath = path.join(lndDir, 'data/lnd/data/chain/bitcoin/regtest/admin.macaroon')
	const lndMacaroonHex = await until('LND creates admin.macaroon & syncs to Bitcoin Roots at height 107', async () => {
		const rawMacaroon = execFileSync('sudo', ['cat', lndMacaroonPath])
		const macaroonHex = rawMacaroon.toString('hex')
		const info = await lndRest('GET', '/v1/getinfo', {ca: lndCa.ca, macaroonHex})
		assert.equal(info.synced_to_chain, true, `LND not synced yet: ${JSON.stringify(info)}`)
		assert.equal(info.block_height, 107)
		return macaroonHex
	})
	console.log('PASS: LND synced to Bitcoin Roots (RPC + ZMQ rawblock/rawtx) at height 107')

	// Fund LND from Bitcoin Roots, mine 6 blocks, and verify LND sees confirmed 1 BTC balance at height 113
	const lndAddrResp = await lndRest('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH', {
		ca: lndCa.ca,
		macaroonHex: lndMacaroonHex,
	})
	assert.ok(lndAddrResp.address.startsWith('bcrt1'), `unexpected LND address: ${lndAddrResp.address}`)
	bcli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${lndAddrResp.address}`, 'amount=1.0', 'fee_rate=10')
	bcli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)

	await until('LND confirms 1 BTC deposit at height 113', async () => {
		const info = await lndRest('GET', '/v1/getinfo', {ca: lndCa.ca, macaroonHex: lndMacaroonHex})
		assert.equal(info.block_height, 113)
		const bal = await lndRest('GET', '/v1/balance/blockchain', {ca: lndCa.ca, macaroonHex: lndMacaroonHex})
		assert.equal(Number(bal.confirmed_balance), 100_000_000)
	})
	console.log('PASS: LND received & confirmed 1 BTC transaction from Bitcoin Roots (height 113)')

	// 6. Boot blockdyor-bassin connected to Bitcoin Roots via exports.sh
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

	const bassinOverride = path.join(workDir, 'bassin-override.yml')
	await writeFile(
		bassinOverride,
		`services:
  ui:
    ports:
      - '127.0.0.1:18080:8080'
`,
	)
	const bassinFiles = [path.join(bassinDir, 'docker-compose.yml'), netOverride, bassinOverride]
	composeCalls.push({project: bassinProject, files: bassinFiles, env: bassinEnv})
	console.log('==> Starting blockdyor-bassin (init + ckpool + ui) wired to Bitcoin Roots...')
	compose(bassinProject, bassinFiles, bassinEnv, 'up', '-d', 'ckpool', 'ui')

	await until('Bassin CKPool connected to Bitcoin Roots & UI healthy', async () => {
		const logs = compose(bassinProject, bassinFiles, bassinEnv, 'logs', '--no-color', 'ckpool')
		assert.ok(
			/ckpool stratifier ready/i.test(logs) && !/Failed to connect|auth failed|401/i.test(logs),
			`unexpected ckpool logs:\n${logs}`,
		)
		const res = await fetch('http://127.0.0.1:18080/')
		assert.equal(res.status, 200)
	})
	const ckLogs = compose(bassinProject, bassinFiles, bassinEnv, 'logs', '--no-color', '--tail', '30', 'ckpool')
	console.log('PASS: Bassin CKPool + UI connected to Bitcoin Roots:\n' + ckLogs)

	// 7. Boot official Public Pool connected to Bitcoin Roots via exports.sh (RPC + Stratum v1 getblocktemplate)
	const publicPoolEnv = sourceUmbrelEnv({
		callerApp: 'public-pool',
		appDir: publicPoolDir,
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
	assert.equal(
		publicPoolEnv.APP_BITCOIN_RPC_PASS,
		rootsEnv.APP_BITCOIN_RPC_PASS,
		'Public Pool must derive identical RPC pass',
	)

	const publicPoolOverride = path.join(workDir, 'public-pool-override.yml')
	await writeFile(
		publicPoolOverride,
		`services:
  server:
    ports: !reset
      - '127.0.0.1:12018:2018'
      - '127.0.0.1:12019:2019'
    environment:
      - NETWORK=regtest
`,
	)
	const publicPoolFiles = [path.join(publicPoolDir, 'docker-compose.yml'), netOverride, publicPoolOverride]
	composeCalls.push({project: publicPoolProject, files: publicPoolFiles, env: publicPoolEnv})
	console.log('==> Starting official Public Pool wired to Bitcoin Roots...')
	compose(publicPoolProject, publicPoolFiles, publicPoolEnv, 'up', '-d', 'server')

	await until('Public Pool connects to Bitcoin Roots RPC & reports height 113', async () => {
		const res = await fetch('http://127.0.0.1:12019/api/network')
		assert.equal(res.status, 200)
		const info = await res.json()
		assert.equal(info.chain, 'regtest')
		assert.equal(info.blocks, 113)
	})
	const stratum = await until('Public Pool serves live Stratum v1 job from Bitcoin Roots getblocktemplate', () =>
		testStratumV1(12018, minerAddr),
	)
	console.log('PASS: Public Pool connected to Bitcoin Roots & served Stratum v1 job:', stratum)

	// Verify i2p sidecar stayed up cleanly
	const i2pState = compose(rootsProject, rootsFiles, rootsEnv, 'ps', '--format', '{{.State}}', 'i2p').trim()
	assert.equal(i2pState, 'running', `i2p container state was ${i2pState}`)
	console.log('PASS: Bitcoin Roots I2P sidecar running cleanly')

	// 8. Verify chain-data migration without re-sync (simulates moving blocks/chainstate/indexes from Core/Knots)
	console.log('==> Testing zero-re-sync chain data migration (moving blocks, chainstate, indexes)...')
	compose(rootsProject, rootsFiles, rootsEnv, 'stop', 'app')
	const migratedDir = path.join(workDir, 'migrated-bitcoin-data')
	const srcRegtest = path.join(rootsDir, 'data/bitcoin/regtest')
	// Inside the container bitcoind runs as UID 1000 with mode 0700; use sudo on runners where host UID != 1000
	run('sudo', [
		'bash',
		'-euo',
		'pipefail',
		'-c',
		`
mkdir -p "${migratedDir}/regtest"
cp -a "${srcRegtest}/blocks" "${srcRegtest}/chainstate" "${migratedDir}/regtest/"
[ -d "${srcRegtest}/indexes" ] && cp -a "${srcRegtest}/indexes" "${migratedDir}/regtest/"
rm -rf "${rootsDir}/data/bitcoin"
mkdir -p "${srcRegtest}"
mv "${migratedDir}/regtest/blocks" "${migratedDir}/regtest/chainstate" "${srcRegtest}/"
[ -d "${migratedDir}/regtest/indexes" ] && mv "${migratedDir}/regtest/indexes" "${srcRegtest}/"
chown -R 1000:1000 "${rootsDir}/data/bitcoin"
`,
	])

	compose(rootsProject, rootsFiles, rootsEnv, 'up', '-d', 'app')
	await until('Migrated Bitcoin Roots boots immediately at height 113 without re-sync', () => {
		const info = JSON.parse(bcli('getblockchaininfo'))
		assert.equal(info.blocks, 113)
		return info
	})
	console.log('PASS: Migrated Bitcoin Roots resumed at height 113 with zero re-sync')

	// Also verify Core Lightning reconnects seamlessly after Bitcoin Roots restarted with migrated data
	const clnPostMigration = await until('Core Lightning stays synced at height 113 after migration', () => {
		const info = lcli('getinfo')
		assert.equal(info.blockheight, 113)
		return info
	})
	console.log('PASS: Core Lightning remained connected at height', clnPostMigration.blockheight)

	console.log(
		'\nALL E2E CHECKS PASSED: Bitcoin Roots (10333/10332) + Core Lightning + LND + Bassin + Public Pool + Chain Migration',
	)
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
	await rm(workDir, {recursive: true, force: true}).catch(() => {
		try {
			run('sudo', ['rm', '-rf', workDir])
		} catch {}
	})
}
