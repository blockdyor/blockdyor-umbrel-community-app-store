// Real-world Raspberry Pi 5 (ARM64 + x86_64) stress & ecosystem E2E suite for blockdyor-bitcoin-roots:
// 1. Side-by-side coexistence with official Bitcoin Core (8333/8332 vs 10333/10332)
// 2. Real zero-re-sync chain migration from Bitcoin Core -> Bitcoin Roots (exact block hash parity)
// 3. Official Core Lightning + official LND synced via exports.sh (RPC + ZMQ rawblock/rawtx)
// 4. Real Lightning channel open, BOLT11 invoice payment, and cooperative close between CLN <-> LND
// 5. Official Electrs (cookie auth + whitebind P2P + live Electrum JSON-RPC query)
// 6. Bassin (Cap'n Proto IPC + UI) + Official Public Pool (RPC + live Stratum v1 getblocktemplate job)
// 7. Mempool burst (50 rapid txs) + concurrent REST API & WebSocket (/ws/blocks, /ws/transactions) stress
// 8. Live Roots Relay & Mining Policy toggle (datacarrier=0 -> OP_RETURN rejected) + CVE-2026-117348 probe
// 9. Abrupt SIGKILL crash recovery on Bitcoin Roots app + Tor (onion identity persistence + full reconnect)
// 10. Live per-container RAM & Node.js RSS budget audit for Raspberry Pi 5
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {arch, tmpdir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'
import {
	BASH_BIN,
	CHMOD_BIN,
	DOCKER_BIN,
	SUDO_BIN,
	UMBREL_APPS_BASE,
	compose,
	createSecrets,
	electrumRpc,
	fetchText,
	lndRest,
	run,
	sendDuplicateWtxInvBurst,
	snapshotDockerStats,
	sourceUmbrelEnv,
	startSharedTorProxy,
	testStratumV1,
	until,
} from './lib/e2e-helpers.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(path.join(tmpdir(), 'umbrel-pi5-stress-'))
const pid = process.pid
const networkName = `pi5-stress-net-${pid}`
const torContainer = `pi5-umbrel-tor-${pid}`
const {umbrelSeed, torControlSecret} = createSecrets()

const projects = {
	core: `pi5-core-${pid}`,
	roots: `pi5-roots-${pid}`,
	cln: `pi5-cln-${pid}`,
	lnd: `pi5-lnd-${pid}`,
	electrs: `pi5-electrs-${pid}`,
	bassin: `pi5-bassin-${pid}`,
	publicPool: `pi5-public-pool-${pid}`,
}
const composeCalls = []

try {
	console.log(`=== Raspberry Pi 5 Real-World Stress Suite (host arch=${arch()}) ===`)
	await chmod(workDir, 0o755)
	await startSharedTorProxy({workDir, networkName, torContainer, torControlSecret})

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

	for (const [base, rel] of [
		[dirs.core, 'data/app'],
		[dirs.core, 'data/bitcoin'],
		[dirs.core, 'data/i2pd'],
		[dirs.core, 'scripts'],
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
		await mkdir(path.join(base, rel), {recursive: true})
	}

	await writeFile(path.join(dirs.core, 'data/app/settings.json'), JSON.stringify({chain: 'regtest'}, null, 2) + '\n')
	await writeFile(
		path.join(dirs.roots, 'data/app/settings.json'),
		JSON.stringify({chain: 'regtest', ipc: true}, null, 2) + '\n',
	)
	await writeFile(path.join(dirs.lnd, 'data/lnd/umbrel-lnd.conf'), '')
	run(CHMOD_BIN, ['-R', 'a+rwx', ...Object.values(dirs).map((d) => path.join(d, 'data'))])

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
	// Official bitcoin/exports.sh invokes scripts/rpcauth.py
	const rpcauthPath = path.join(dirs.core, 'scripts/rpcauth.py')
	await writeFile(rpcauthPath, await fetchText(`${UMBREL_APPS_BASE}/bitcoin/scripts/rpcauth.py`))
	await chmod(rpcauthPath, 0o755)

	const dataRoots = {
		bitcoin: path.join(dirs.core, 'data'),
		'blockdyor-bitcoin-roots': path.join(dirs.roots, 'data'),
		'core-lightning': path.join(dirs.cln, 'data'),
		lightning: path.join(dirs.lnd, 'data'),
		electrs: path.join(dirs.electrs, 'data'),
		'blockdyor-bassin': path.join(dirs.bassin, 'data'),
		'public-pool': path.join(dirs.publicPool, 'data'),
	}
	const envArgs = {workDir, umbrelSeed, torControlSecret, dataRoots}

	const netOverride = path.join(workDir, 'network-override.yml')
	await writeFile(
		netOverride,
		`services:\n  app_proxy:\n    image: busybox:1.37\nnetworks:\n  default:\n    external: true\n    name: ${networkName}\n`,
	)

	// STAGE 1: Side-by-Side Coexistence (Official Bitcoin Core + Bitcoin Roots)
	console.log('\n==> [Stage 1] Booting Official Bitcoin Core (8333/8332) AND Bitcoin Roots (10333/10332) simultaneously...')
	const coreEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'bitcoin',
		appDir: dirs.core,
		exportsChain: [{id: 'bitcoin', dir: dirs.core, dataRoot: dataRoots.bitcoin, file: path.join(dirs.core, 'exports.sh')}],
	})
	const rootsExport = {
		id: 'blockdyor-bitcoin-roots',
		dir: dirs.roots,
		dataRoot: dataRoots['blockdyor-bitcoin-roots'],
		file: path.join(dirs.roots, 'exports.sh'),
	}
	const rootsEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'blockdyor-bitcoin-roots',
		appDir: dirs.roots,
		exportsChain: [rootsExport],
	})

	const rootsOverride = path.join(workDir, 'roots-override.yml')
	await writeFile(rootsOverride, `services:\n  app:\n    ports:\n      - '127.0.0.1:13000:3000'\n`)
	const coreFiles = [path.join(dirs.core, 'docker-compose.yml'), netOverride]
	const rootsFiles = [path.join(dirs.roots, 'docker-compose.yml'), netOverride, rootsOverride]
	composeCalls.push(
		{project: projects.core, files: coreFiles, env: coreEnv},
		{project: projects.roots, files: rootsFiles, env: rootsEnv},
	)

	compose(projects.core, coreFiles, coreEnv, 'up', '-d', 'app')
	compose(projects.roots, rootsFiles, rootsEnv, 'up', '-d', 'app', 'tor', 'i2p')

	const coreCli = (...args) =>
		compose(projects.core, coreFiles, coreEnv, 'exec', '-T', 'app', 'bitcoin-cli', '-datadir=/data/bitcoin', '-regtest', `-rpcport=${coreEnv.APP_BITCOIN_RPC_PORT}`, ...args).trim()
	const rootsCli = (...args) =>
		compose(projects.roots, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'bitcoin-cli', '-datadir=/data/bitcoin', '-regtest', `-rpcport=${rootsEnv.APP_BITCOIN_ROOTS_RPC_PORT}`, ...args).trim()

	await until('Official Bitcoin Core RPC ready on 8332', () => {
		assert.equal(JSON.parse(coreCli('getblockchaininfo')).chain, 'regtest')
	})
	const rootsVersion = await until('Bitcoin Roots RPC & HTTP API ready on 10332/3000', async () => {
		assert.equal(JSON.parse(rootsCli('getblockchaininfo')).chain, 'regtest')
		const res = await fetch('http://127.0.0.1:13000/api/bitcoind/version')
		assert.equal(res.status, 200)
		const v = await res.json()
		assert.equal(v.implementation, 'Bitcoin Roots')
		return v
	})
	console.log('PASS [Stage 1]: Core & Roots (', rootsVersion.version, ') ran side-by-side with zero conflicts')

	coreCli('createwallet', 'coreminer')
	const coreMinerAddr = coreCli('-rpcwallet=coreminer', 'getnewaddress')
	coreCli('-rpcwallet=coreminer', 'generatetoaddress', '101', coreMinerAddr)
	const expectedHash101 = coreCli('getblockhash', '101')

	// STAGE 2: Real Zero-Re-Sync Migration (Bitcoin Core -> Bitcoin Roots)
	console.log('\n==> [Stage 2] Migrating chain data from Bitcoin Core -> Bitcoin Roots...')
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
	compose(projects.core, coreFiles, coreEnv, 'down', '--volumes', '--remove-orphans', '--timeout', '20')
	compose(projects.roots, rootsFiles, rootsEnv, 'up', '-d', 'app')

	await until('Bitcoin Roots boots from Core chain data at height 101 with exact block hash', () => {
		assert.equal(JSON.parse(rootsCli('getblockchaininfo')).blocks, 101)
		assert.equal(rootsCli('getblockhash', '101'), expectedHash101)
		compose(projects.roots, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'test', '-S', '/data/bitcoin/regtest/node.sock')
	})
	console.log('PASS [Stage 2]: Migrated Core -> Roots at height 101 with zero re-sync')

	rootsCli('createwallet', 'miner')
	const minerAddr = rootsCli('-rpcwallet=miner', 'getnewaddress')
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '101', minerAddr)
	let currentHeight = 202

	// STAGE 3: Core Lightning + LND
	console.log('\n==> [Stage 3] Starting official Core Lightning and official LND...')
	const clnEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'core-lightning',
		appDir: dirs.cln,
		exportsChain: [rootsExport, {id: 'core-lightning', dir: dirs.cln, dataRoot: dataRoots['core-lightning'], file: path.join(dirs.cln, 'exports.sh')}],
	})
	const lndEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'lightning',
		appDir: dirs.lnd,
		exportsChain: [rootsExport, {id: 'lightning', dir: dirs.lnd, dataRoot: dataRoots.lightning, file: path.join(dirs.lnd, 'exports.sh')}],
	})
	const lndOverride = path.join(workDir, 'lnd-override.yml')
	await writeFile(lndOverride, `services:\n  lnd:\n    ports: !override\n      - '127.0.0.1:18081:8080'\n`)
	const clnFiles = [path.join(dirs.cln, 'docker-compose.yml'), netOverride]
	const lndFiles = [path.join(dirs.lnd, 'docker-compose.yml'), netOverride, lndOverride]
	composeCalls.push(
		{project: projects.cln, files: clnFiles, env: clnEnv},
		{project: projects.lnd, files: lndFiles, env: lndEnv},
	)
	compose(projects.cln, clnFiles, clnEnv, 'up', '-d', 'lightningd')
	compose(projects.lnd, lndFiles, lndEnv, 'up', '-d', 'lnd')

	const lcli = (...args) => {
		const raw = compose(
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
		)
		const jsonText = raw
			.split('\n')
			.filter((line) => !line.startsWith('#'))
			.join('\n')
			.trim()
		return JSON.parse(jsonText)
	}

	const lndInit = await until('LND REST API ready', async () => {
		const ca = await readFile(path.join(dirs.lnd, 'data/lnd/tls.cert'))
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

	const clnAddr = lcli('newaddr').bech32
	const lndAddr = (await lndRest('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).address
	rootsCli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${clnAddr}`, 'amount=1.0', 'fee_rate=10')
	rootsCli('-rpcwallet=miner', '-named', 'sendtoaddress', `address=${lndAddr}`, 'amount=1.0', 'fee_rate=10')
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	currentHeight += 6

	await until(`CLN & LND confirm 1 BTC each at height ${currentHeight}`, async () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
		assert.ok(lcli('listfunds').outputs.find((o) => o.status === 'confirmed' && o.amount_msat === 100_000_000_000))
		const lndBal = await lndRest('GET', '/v1/balance/blockchain', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
		assert.equal(Number(lndBal.confirmed_balance), 100_000_000)
	})
	console.log(`PASS [Stage 3]: CLN & LND synced and confirmed 1 BTC each (height ${currentHeight})`)

	// STAGE 4: Real Lightning Channel + BOLT11 Payment + Cooperative Close
	console.log('\n==> [Stage 4] Opening real 500k sat CLN -> LND channel, paying 50k sat invoice, and closing...')
	const lndPubkey = (await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).identity_pubkey
	lcli('connect', `${lndPubkey}@${lndEnv.APP_LIGHTNING_NODE_IP}:${lndEnv.APP_LIGHTNING_NODE_PORT}`)
	const fundResp = lcli('fundchannel', '-k', `id=${lndPubkey}`, 'amount=500000', 'feerate=1000perkw')
	assert.ok(fundResp.channel_id)

	rootsCli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	currentHeight += 6
	await until('CLN <-> LND channel active on both nodes', async () => {
		assert.ok(lcli('listpeerchannels').channels.find((c) => c.state === 'CHANNELD_NORMAL'))
		const lndChans = (await lndRest('GET', '/v1/channels', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).channels ?? []
		assert.ok(lndChans.find((c) => c.active === true))
	})

	const invoice = await lndRest('POST', '/v1/invoices', {
		ca: lndInit.ca,
		macaroonHex: lndMacaroonHex,
		body: {value: '50000', memo: 'pi5-stress-test-payment'},
	})
	assert.equal(lcli('pay', invoice.payment_request).status, 'complete')
	const invList = await lndRest('GET', '/v1/invoices', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})
	assert.ok(invList.invoices.some((inv) => inv.memo === 'pi5-stress-test-payment' && inv.settled === true))

	lcli('close', fundResp.channel_id)
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '6', minerAddr)
	currentHeight += 6
	await until('Cooperative close confirmed on LND', async () => {
		const lndChans = (await lndRest('GET', '/v1/channels', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).channels ?? []
		assert.equal(lndChans.length, 0)
	})
	console.log(`PASS [Stage 4]: Real CLN <-> LND channel opened, 50k sat payment settled, and closed (height ${currentHeight})`)

	// STAGE 5: Official Electrs
	console.log('\n==> [Stage 5] Starting official Electrs wired to Bitcoin Roots...')
	const electrsEnv = sourceUmbrelEnv({
		...envArgs,
		callerApp: 'electrs',
		appDir: dirs.electrs,
		exportsChain: [rootsExport, {id: 'electrs', dir: dirs.electrs, dataRoot: dataRoots.electrs, file: path.join(dirs.electrs, 'exports.sh')}],
	})
	const electrsOverride = path.join(workDir, 'electrs-override.yml')
	await writeFile(electrsOverride, `services:\n  electrs:\n    ports: !override\n      - '127.0.0.1:15001:50001'\n`)
	const electrsFiles = [path.join(dirs.electrs, 'docker-compose.yml'), netOverride, electrsOverride]
	composeCalls.push({project: projects.electrs, files: electrsFiles, env: electrsEnv})
	compose(projects.electrs, electrsFiles, electrsEnv, 'up', '-d', 'electrs')

	const electrumTip = await until(`Electrs indexes Bitcoin Roots to height ${currentHeight}`, async () => {
		const ver = await electrumRpc(15001, 'server.version', ['pi5-e2e', '1.4'])
		const tip = await electrumRpc(15001, 'blockchain.headers.subscribe')
		assert.equal(tip.height, currentHeight)
		return {ver, tip}
	})
	console.log('PASS [Stage 5]: Electrs synced via Roots .cookie + whitebind P2P:', electrumTip.ver, 'height:', electrumTip.tip.height)

	// STAGE 6: Bassin + Public Pool
	console.log('\n==> [Stage 6] Starting Bassin (IPC + UI) and Public Pool (RPC + Stratum v1)...')
	const bassinEnv = sourceUmbrelEnv({...envArgs, callerApp: 'blockdyor-bassin', appDir: dirs.bassin, exportsChain: [rootsExport]})
	const publicPoolEnv = sourceUmbrelEnv({...envArgs, callerApp: 'public-pool', appDir: dirs.publicPool, exportsChain: [rootsExport]})
	const bassinOverride = path.join(workDir, 'bassin-override.yml')
	await writeFile(bassinOverride, `services:\n  ui:\n    ports:\n      - '127.0.0.1:18080:8080'\n`)
	const publicPoolOverride = path.join(workDir, 'public-pool-override.yml')
	await writeFile(
		publicPoolOverride,
		`services:\n  server:\n    ports: !override\n      - '127.0.0.1:12018:2018'\n      - '127.0.0.1:12019:2019'\n    environment:\n      - NETWORK=regtest\n`,
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
		assert.equal((await fetch('http://127.0.0.1:18080/')).status, 200)
	})
	await until(`Public Pool RPC reports height ${currentHeight}`, async () => {
		const info = await (await fetch('http://127.0.0.1:12019/api/network')).json()
		assert.equal(info.chain, 'regtest')
		assert.equal(info.blocks, currentHeight)
	})
	const stratumJob = await until('Public Pool serves Stratum v1 job', () => testStratumV1(12018, minerAddr))
	console.log('PASS [Stage 6]: Bassin & Public Pool (job', stratumJob.jobId, ') healthy')
	snapshotDockerStats('after full 6-app stack boot')

	// STAGE 7: Mempool Burst + Concurrent REST & WebSocket Stress
	console.log('\n==> [Stage 7] Stress-testing 50 rapid txs + concurrent REST API & WebSockets...')
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
	await delay(3000)

	const apiPaths = ['/api/stats', '/api/sync', '/api/peers/locations', '/api/blocks?limit=50', '/api/widget/stats', '/api/widget/sync', '/api/connect/details']
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
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '1', minerAddr)
	currentHeight += 1
	await until('WebSockets receive live txPing & block frames', () => {
		assert.ok(wsTxPings >= 1 && wsBlocks >= 1)
	}, 20, 1000)
	txWs.close()
	blockWs.close()
	console.log(`PASS [Stage 7]: 50-tx burst + 35 API calls passed (wsTxPings=${wsTxPings}, wsBlocks=${wsBlocks})`)

	// STAGE 8: Live Policy Enforcement + CVE-2026-117348 Duplicate-WTX Inv Probe
	console.log('\n==> [Stage 8] Applying strict Roots policy, checking OP_RETURN rejection & CVE-2026-117348 resilience...')
	const onionsBefore = await until('Tor onion hostnames discovered', async () => {
		const details = await (await fetch('http://127.0.0.1:13000/api/connect/details')).json()
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
	assert.equal(patchRes.status, 200)

	await until('Bitcoin Roots restarts with strict policy & preserves height', () => {
		assert.equal(JSON.parse(rootsCli('getblockchaininfo')).blocks, currentHeight)
		const conf = compose(projects.roots, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'cat', '/data/bitcoin/umbrel-bitcoin.conf')
		assert.ok(conf.includes('datacarrier=0') && conf.includes('rejecttokens=1') && conf.includes('rejectparasites=1'))
	})
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
	}
	assert.ok(opReturnRejected, 'OP_RETURN transaction was NOT rejected despite datacarrier=0!')

	// CVE-2026-117348 check: verify patched >= 32.1 (320100) and survive 50,000 duplicate MSG_WTX inv burst
	const netInfo = JSON.parse(rootsCli('getnetworkinfo'))
	console.log('Bitcoin Roots version:', netInfo.version, netInfo.subversion)
	assert.ok(
		netInfo.version >= 320100,
		`Bitcoin Roots ${netInfo.version} (${netInfo.subversion}) is vulnerable to CVE-2026-117348 (need >= 320100)`,
	)
	const probeStart = Date.now()
	await sendDuplicateWtxInvBurst(Number(rootsEnv.APP_BITCOIN_ROOTS_P2P_PORT), 50_000)
	const rpcStart = Date.now()
	assert.equal(JSON.parse(rootsCli('getblockchaininfo')).blocks, currentHeight)
	const rpcLatencyMs = Date.now() - rpcStart
	assert.ok(rpcLatencyMs < 3000, `Node stalled after duplicate-wtxid inv burst (${rpcLatencyMs} ms)`)
	console.log(`PASS [Stage 8a]: CVE-2026-117348 50k-dup inv probe survived (RPC latency=${rpcLatencyMs}ms, total=${Date.now() - probeStart}ms)`)

	rootsCli('-rpcwallet=miner', 'generatetoaddress', '15', minerAddr)
	currentHeight += 15
	await until(`CLN/LND/Electrs/Public Pool catch up to height ${currentHeight}`, async () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
		assert.equal((await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).block_height, currentHeight)
		assert.equal((await electrumRpc(15001, 'blockchain.headers.subscribe')).height, currentHeight)
		assert.equal((await (await fetch('http://127.0.0.1:12019/api/network')).json()).blocks, currentHeight)
	})
	console.log(`PASS [Stage 8]: datacarrier=0 enforced & all apps caught up to height ${currentHeight}`)

	// STAGE 9: Abrupt SIGKILL Crash Recovery
	console.log('\n==> [Stage 9] Simulating abrupt power loss (SIGKILL on Bitcoin Roots app + tor)...')
	compose(projects.roots, rootsFiles, rootsEnv, 'kill', '-s', 'SIGKILL', 'app', 'tor')
	compose(projects.roots, rootsFiles, rootsEnv, 'up', '-d', 'app', 'tor')
	await until('Bitcoin Roots recovers from SIGKILL with identical Tor onions', async () => {
		assert.equal(JSON.parse(rootsCli('getblockchaininfo')).blocks, currentHeight)
		const details = await (await fetch('http://127.0.0.1:13000/api/connect/details')).json()
		assert.equal(details.p2p.tor.host, onionsBefore.p2p.tor.host)
		assert.equal(details.rpc.tor.host, onionsBefore.rpc.tor.host)
	})
	try {
		rootsCli('loadwallet', 'miner')
	} catch {}
	rootsCli('-rpcwallet=miner', 'generatetoaddress', '1', minerAddr)
	currentHeight += 1
	await until(`Ecosystem converges at height ${currentHeight} after SIGKILL`, async () => {
		assert.equal(lcli('getinfo').blockheight, currentHeight)
		assert.equal((await lndRest('GET', '/v1/getinfo', {ca: lndInit.ca, macaroonHex: lndMacaroonHex})).block_height, currentHeight)
		assert.equal((await electrumRpc(15001, 'blockchain.headers.subscribe')).height, currentHeight)
		assert.equal((await (await fetch('http://127.0.0.1:12019/api/network')).json()).blocks, currentHeight)
	})
	assert.equal(compose(projects.roots, rootsFiles, rootsEnv, 'ps', '--format', '{{.State}}', 'i2p').trim(), 'running')
	console.log(`PASS [Stage 9]: SIGKILL recovery passed at height ${currentHeight}`)

	// STAGE 10: Raspberry Pi 5 Live RAM Budget Audit
	const finalStats = snapshotDockerStats('post-stress final audit')
	const procStatus = compose(projects.roots, rootsFiles, rootsEnv, 'exec', '-T', 'app', 'cat', '/proc/1/status')
	const rssMatch = /VmRSS:\s+(\d+)\s+kB/.exec(procStatus)
	assert.ok(rssMatch)
	const nodeRssMiB = Number(rssMatch[1]) / 1024
	console.log(`Node.js backend PID 1 RSS inside Bitcoin Roots app container: ${nodeRssMiB.toFixed(1)} MiB`)
	assert.ok(nodeRssMiB < 180, `Node.js backend RSS too high for Pi 5: ${nodeRssMiB.toFixed(1)} MiB`)
	const i2pEntry = Object.entries(finalStats).find(([name]) => name.includes(`${projects.roots}-i2p`))
	assert.ok(i2pEntry && i2pEntry[1].mib < 150)

	console.log(`\nALL 10 PI 5 STRESS STAGES PASSED [${arch()}]`)
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
