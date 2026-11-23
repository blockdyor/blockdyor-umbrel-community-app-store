// End-to-end umbrelOS simulation on the real 10.21.0.0/16 Docker network:
// Boots blockdyor-bitcoin-roots + official core-lightning + official LND + blockdyor-bassin
// + official public-pool + I2P + zero-re-sync chain migration.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {
	BASH_BIN,
	CHMOD_BIN,
	DOCKER_BIN,
	SUDO_BIN,
	UMBREL_APPS_BASE,
	compose,
	createSecrets,
	fetchText,
	lndRest,
	run,
	sourceUmbrelEnv,
	startSharedTorProxy,
	testStratumV1,
	until,
} from './lib/e2e-helpers.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(path.join(tmpdir(), 'umbrel-e2e-'))
const networkName = `umbrel-e2e-net-${process.pid}`
const rootsProject = `e2e-roots-${process.pid}`
const clnProject = `e2e-cln-${process.pid}`
const lndProject = `e2e-lnd-${process.pid}`
const bassinProject = `e2e-bassin-${process.pid}`
const publicPoolProject = `e2e-public-pool-${process.pid}`
const torContainer = `e2e-umbrel-tor-${process.pid}`
const {umbrelSeed, torControlSecret} = createSecrets()

const composeCalls = []

try {
	await chmod(workDir, 0o755)
	await startSharedTorProxy({workDir, networkName, torContainer, torControlSecret})

	const rootsDir = path.join(workDir, 'blockdyor-bitcoin-roots')
	const clnDir = path.join(workDir, 'core-lightning')
	const lndDir = path.join(workDir, 'lightning')
	const bassinDir = path.join(workDir, 'blockdyor-bassin')
	const publicPoolDir = path.join(workDir, 'public-pool')

	await cp(path.join(repoRoot, 'blockdyor-bitcoin-roots'), rootsDir, {recursive: true})
	await cp(path.join(repoRoot, 'blockdyor-bassin'), bassinDir, {recursive: true})
	for (const p of [
		path.join(rootsDir, 'data/app'),
		path.join(rootsDir, 'data/bitcoin'),
		path.join(rootsDir, 'data/i2pd'),
		path.join(clnDir, 'data/lightningd'),
		path.join(clnDir, 'data/app'),
		path.join(lndDir, 'data/lnd'),
		path.join(lndDir, 'data/lightning'),
		path.join(bassinDir, 'data/www'),
		path.join(bassinDir, 'data/sv2'),
		path.join(publicPoolDir, 'data/database'),
	]) {
		await mkdir(p, {recursive: true})
	}
	await writeFile(path.join(lndDir, 'data/lnd/umbrel-lnd.conf'), '')
	await writeFile(
		path.join(rootsDir, 'data/app/settings.json'),
		JSON.stringify({chain: 'regtest', ipc: true}, null, 2) + '\n',
	)
	run(CHMOD_BIN, [
		'-R',
		'a+rwx',
		path.join(rootsDir, 'data'),
		path.join(clnDir, 'data'),
		path.join(lndDir, 'data'),
		path.join(bassinDir, 'data'),
		path.join(publicPoolDir, 'data'),
	])

	await writeFile(path.join(clnDir, 'exports.sh'), await fetchText(`${UMBREL_APPS_BASE}/core-lightning/exports.sh`))
	await writeFile(
		path.join(clnDir, 'docker-compose.yml'),
		await fetchText(`${UMBREL_APPS_BASE}/core-lightning/docker-compose.yml`),
	)
	await writeFile(path.join(lndDir, 'exports.sh'), await fetchText(`${UMBREL_APPS_BASE}/lightning/exports.sh`))
	await writeFile(
		path.join(lndDir, 'docker-compose.yml'),
		await fetchText(`${UMBREL_APPS_BASE}/lightning/docker-compose.yml`),
	)
	await writeFile(
		path.join(publicPoolDir, 'docker-compose.yml'),
		await fetchText(`${UMBREL_APPS_BASE}/public-pool/docker-compose.yml`),
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

	const rootsExport = {
		id: 'blockdyor-bitcoin-roots',
		dir: rootsDir,
		dataRoot: dataRoots['blockdyor-bitcoin-roots'],
		file: path.join(rootsDir, 'exports.sh'),
	}
	const envArgs = {workDir, umbrelSeed, torControlSecret, dataRoots}

	// 1. Boot blockdyor-bitcoin-roots
	const rootsEnv = sourceUmbrelEnv({...envArgs, callerApp: 'blockdyor-bitcoin-roots', appDir: rootsDir, exportsChain: [rootsExport]})
	assert.equal(rootsEnv.APP_BITCOIN_RPC_PORT, '10332')
	assert.equal(rootsEnv.APP_BITCOIN_P2P_PORT, '10333')
	assert.equal(rootsEnv.APP_BITCOIN_NETWORK, 'regtest')
	assert.equal(rootsEnv.APP_BITCOIN_IPC_ENABLED, 'true')

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

	await until('Bitcoin Roots RPC & IPC socket ready', () => {
		const info = JSON.parse(bcli('getblockchaininfo'))
		assert.equal(info.chain, 'regtest')
		compose(rootsProject, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'test', '-S', '/data/bitcoin/regtest/node.sock')
	})

	const versionInfo = JSON.parse(
		compose(
			rootsProject,
			rootsFiles,
			rootsEnv,
			'exec',
			'-T',
			'app',
			'node',
			'-e',
			`fetch('http://127.0.0.1:3000/api/bitcoind/version').then(r=>r.text()).then(t=>console.log(t))`,
		),
	)
	assert.equal(versionInfo.implementation, 'Bitcoin Roots')
	assert.match(versionInfo.version, /^v\d+\.\d+(?:\.\d+)?-roots\.\d+$/)
	console.log('PASS: Bitcoin Roots booted:', versionInfo)

	bcli('createwallet', 'miner')
	const minerAddr = bcli('-rpcwallet=miner', 'getnewaddress')
	bcli('-rpcwallet=miner', 'generatetoaddress', '101', minerAddr)

	// 2. Core Lightning
	const clnEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'core-lightning',
		appDir: clnDir,
		exportsChain: [rootsExport, {id: 'core-lightning', dir: clnDir, dataRoot: dataRoots['core-lightning'], file: path.join(clnDir, 'exports.sh')}],
	})
	assert.equal(clnEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS)
	const clnFiles = [path.join(clnDir, 'docker-compose.yml'), netOverride]
	composeCalls.push({project: clnProject, files: clnFiles, env: clnEnv})
	compose(clnProject, clnFiles, clnEnv, 'up', '-d', 'lightningd')

	const lcli = (...args) =>
		JSON.parse(
			compose(clnProject, clnFiles, clnEnv, 'exec', '-T', 'lightningd', 'lightning-cli', '--lightning-dir=/root/.lightning', '--network=regtest', ...args),
		)

	await until('Core Lightning synced to height 101', () => {
		assert.equal(lcli('getinfo').blockheight, 101)
	})
	const clnAddr = lcli('newaddr').bech32
	bcli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${clnAddr}`, 'amount=1.0', 'fee_rate=10')
	bcli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	await until('Core Lightning confirms 1 BTC at height 107', () => {
		assert.equal(lcli('getinfo').blockheight, 107)
		assert.ok(lcli('listfunds').outputs.find((o) => o.status === 'confirmed' && o.amount_msat === 100_000_000_000))
	})
	console.log('PASS: Core Lightning synced & confirmed 1 BTC (height 107)')

	// 3. LND
	const lndEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'lightning',
		appDir: lndDir,
		exportsChain: [rootsExport, {id: 'lightning', dir: lndDir, dataRoot: dataRoots.lightning, file: path.join(lndDir, 'exports.sh')}],
	})
	assert.equal(lndEnv.APP_BITCOIN_RPC_PASS, rootsEnv.APP_BITCOIN_RPC_PASS)
	const lndOverride = path.join(workDir, 'lnd-override.yml')
	await writeFile(lndOverride, `services:\n  lnd:\n    ports: !override\n      - '127.0.0.1:18081:8080'\n`)
	const lndFiles = [path.join(lndDir, 'docker-compose.yml'), netOverride, lndOverride]
	composeCalls.push({project: lndProject, files: lndFiles, env: lndEnv})
	compose(lndProject, lndFiles, lndEnv, 'up', '-d', 'lnd')

	const lndInit = await until('LND REST API ready', async () => {
		const ca = await readFile(path.join(lndDir, 'data/lnd/tls.cert'))
		const seedResp = await lndRest('GET', '/v1/genseed', {ca})
		assert.ok(Array.isArray(seedResp.cipher_seed_mnemonic))
		return {ca, mnemonic: seedResp.cipher_seed_mnemonic}
	})
	await lndRest('POST', '/v1/initwallet', {
		ca: lndInit.ca,
		body: {
			wallet_password: Buffer.from(randomBytes(16).toString('hex')).toString('base64'),
			cipher_seed_mnemonic: lndInit.mnemonic,
		},
	})
	const lndMacaroonPath = path.join(lndDir, 'data/lnd/data/chain/bitcoin/regtest/admin.macaroon')
	const lndMacaroonHex = await until('LND synced to height 107', async () => {
		const macaroonHex = execFileSync(SUDO_BIN, ['cat', lndMacaroonPath]).toString('hex')
		const info = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex})
		assert.equal(info.synced_to_chain, true)
		assert.equal(info.block_height, 107)
		return macaroonHex
	})
	const lndAddr = (
		await lndRest('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
	).address
	bcli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${lndAddr}`, 'amount=1.0', 'fee_rate=10')
	bcli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	await until('LND confirms 1 BTC at height 113', async () => {
		const info = await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(info.block_height, 113)
		const bal = await lndRest('GET', '/v1/balance/blockchain', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(Number(bal.confirmed_balance), 100_000_000)
	})
	console.log('PASS: LND synced & confirmed 1 BTC (height 113)')

	// 4. Bassin
	const bassinEnv = sourceUmbrelEnv({...envArgs, callerApp: 'blockdyor-bassin', appDir: bassinDir, exportsChain: [rootsExport]})
	const bassinOverride = path.join(workDir, 'bassin-override.yml')
	await writeFile(bassinOverride, `services:\n  ui:\n    ports:\n      - '127.0.0.1:18080:8080'\n`)
	const bassinFiles = [path.join(bassinDir, 'docker-compose.yml'), netOverride, bassinOverride]
	composeCalls.push({project: bassinProject, files: bassinFiles, env: bassinEnv})
	compose(bassinProject, bassinFiles, bassinEnv, 'up', '-d', 'ckpool', 'ui')
	await until('Bassin CKPool stratifier ready & UI HTTP 200', async () => {
		const logs = compose(bassinProject, bassinFiles, bassinEnv, 'logs', '--no-color', 'ckpool')
		assert.ok(/ckpool stratifier ready/i.test(logs) && !/Failed to connect|auth failed|401/i.test(logs))
		assert.equal((await fetch('http://127.0.0.1:18080/')).status, 200)
	})
	console.log('PASS: Bassin CKPool + UI connected to Bitcoin Roots')

	// 5. Public Pool
	const publicPoolEnv = sourceUmbrelEnv({...envArgs, callerApp: 'public-pool', appDir: publicPoolDir, exportsChain: [rootsExport]})
	const publicPoolOverride = path.join(workDir, 'public-pool-override.yml')
	await writeFile(
		publicPoolOverride,
		`services:\n  server:\n    ports: !override\n      - '127.0.0.1:12018:2018'\n      - '127.0.0.1:12019:2019'\n    environment:\n      - NETWORK=regtest\n`,
	)
	const publicPoolFiles = [path.join(publicPoolDir, 'docker-compose.yml'), netOverride, publicPoolOverride]
	composeCalls.push({project: publicPoolProject, files: publicPoolFiles, env: publicPoolEnv})
	compose(publicPoolProject, publicPoolFiles, publicPoolEnv, 'up', '-d', 'server')
	await until('Public Pool RPC reports height 113', async () => {
		const info = await (await fetch('http://127.0.0.1:12019/api/network')).json()
		assert.equal(info.chain, 'regtest')
		assert.equal(info.blocks, 113)
	})
	const stratum = await until('Public Pool serves Stratum v1 job', () => testStratumV1(12018, minerAddr))
	console.log('PASS: Public Pool connected & served Stratum v1 job:', stratum.jobId)

	// 6. I2P & Zero-Re-Sync Chain Migration
	assert.equal(compose(rootsProject, rootsFiles, rootsEnv, 'ps', '--format', '{{.State}}', 'i2p').trim(), 'running')
	compose(rootsProject, rootsFiles, rootsEnv, 'stop', 'app')
	const migratedDir = path.join(workDir, 'migrated-bitcoin-data')
	const srcRegtest = path.join(rootsDir, 'data/bitcoin/regtest')
	run(SUDO_BIN, [
		BASH_BIN,
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
	await until('Migrated Bitcoin Roots boots immediately at height 113', () => {
		assert.equal(JSON.parse(bcli('getblockchaininfo')).blocks, 113)
	})
	await until('CLN stays synced at height 113 after migration', () => {
		assert.equal(lcli('getinfo').blockheight, 113)
	})
	console.log('\nALL E2E CHECKS PASSED: Bitcoin Roots + CLN + LND + Bassin + Public Pool + Migration')
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
