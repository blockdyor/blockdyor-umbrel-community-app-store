<p align="center">
  <a href="https://blockdyor.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
      <img src="assets/logo-light.svg" width="120" height="120" alt="blockdyor">
    </picture>
  </a>
</p>

<h1 align="center">blockdyor Community App Store</h1>

<p align="center">
  <em>Self-hosted Bitcoin &amp; sovereignty apps for umbrelOS — digest-pinned, multi-arch, ready to run.</em>
</p>

<p align="center">
  <a href="https://github.com/blockdyor/blockdyor-umbrel-community-app-store/stargazers"><img src="https://img.shields.io/github/stars/blockdyor/blockdyor-umbrel-community-app-store?style=flat-square&color=111111&label=stars" alt="Stars"></a>
  <img src="https://img.shields.io/badge/umbrelOS-1.1%2B-111111?style=flat-square" alt="umbrelOS 1.1+">
  <img src="https://img.shields.io/badge/apps-2-111111?style=flat-square" alt="2 apps">
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-111111?style=flat-square" alt="amd64 and arm64">
  <a href="https://blockdyor.com"><img src="https://img.shields.io/badge/web-blockdyor.com-F7931A?style=flat-square" alt="blockdyor.com"></a>
</p>

<p align="center">
  <a href="#bassin"><img src="blockdyor-bassin/icon.svg" width="84" height="84" alt="Bassin"></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#bitcoin-roots"><img src="blockdyor-bitcoin-roots/icon.svg" width="84" height="84" alt="Bitcoin Roots"></a>
</p>

<p align="center">
  <sub>
    <a href="#apps">Apps</a> &middot;
    <a href="#add-to-umbrelos">Quick Start</a> &middot;
    <a href="#bassin">Bassin</a> &middot;
    <a href="#bitcoin-roots">Bitcoin Roots</a> &middot;
    <a href="#ports--network">Ports &amp; Network</a> &middot;
    <a href="#faq">FAQ</a>
  </sub>
</p>

---

## Add to umbrelOS

1. Open **App Store** on your Umbrel.
2. Click the **&ctdot;** menu in the top-right corner and choose **Community App Stores**.
3. Paste this repository URL and click **Add**:

```text
https://github.com/blockdyor/blockdyor-umbrel-community-app-store
```

---

## Apps

| | App | Version | Category | Web UI | Highlights |
| :-: | --- | --- | --- | :-: | --- |
| <a href="#bassin"><img src="blockdyor-bassin/icon.svg" width="44" height="44" alt="Bassin"></a> | [**Bassin**](#bassin)<br><sub>`blockdyor-bassin`</sub> | `2.1.18` | Bitcoin | `5009` | 0%-fee solo Bitcoin mining pool (CKPool) with Stratum V1 (`3456`), opt-in Noise-encrypted Stratum V2 (`3457`), IPC mining, live Settings, and dashboard widgets. |
| <a href="#bitcoin-roots"><img src="blockdyor-bitcoin-roots/icon.svg" width="44" height="44" alt="Bitcoin Roots"></a> | [**Bitcoin Roots**](#bitcoin-roots)<br><sub>`blockdyor-bitcoin-roots`</sub> | `32.1.0-roots.2-blockdyor.4` | Bitcoin | `2111` | Bitcoin Roots (`v32.1-roots.2`) full node with Relay &amp; Mining Policy UI, persistent Tor &amp; I2P, Plan-B dark UI, standard Bitcoin ports (`8333`/`8332`), and `implements: bitcoin` for CLN / Bassin / LND / Electrs. |

---

## Bassin

<table>
  <tr>
    <td width="96" align="center" valign="middle">
      <img src="blockdyor-bassin/icon.svg" width="76" height="76" alt="Bassin">
    </td>
    <td>
      <strong>Solo Bitcoin Mining Pool (CKPool)</strong> &middot; <code>blockdyor-bassin</code> &middot; <code>v2.1.18</code><br>
      0% pool fee solo mining pool for umbrelOS with simultaneous Stratum V1 &amp; opt-in Noise-encrypted Stratum V2, Bitcoin Core/Roots IPC mining (with RPC/ZMQ fallback), hardened Settings editor, and three Umbrel widgets.<br>
      <sub>
        <a href="blockdyor-bassin/umbrel-app.yml">Manifest</a> &middot;
        <a href="blockdyor-bassin/docker-compose.yml">Compose</a> &middot;
        <a href="https://github.com/blockdyor/bassin">Docs &amp; Source</a> &middot;
        <a href="https://github.com/blockdyor/bassin/blob/main/docs/FAQ.md">FAQ</a> &middot;
        <a href="https://github.com/blockdyor/bassin/issues">Issues</a>
      </sub>
    </td>
  </tr>
</table>

### Install & connect a miner

1. Run a fully synchronized Bitcoin node on Umbrel (**Bitcoin Core**, **Bitcoin Knots**, or **Bitcoin Roots**) and leave it running.
2. Install **Bassin** from this store, open the dashboard (web port `5009`), and select **Connect &rarr; Stratum** (V1), **Connect &rarr; Stratum V2**, or **Connect &rarr; Worker Setup**.
3. Point your miner to your Umbrel:

| Setting | Stratum V1 *(default)* | Stratum V2 *(opt-in, Noise-encrypted)* |
| --- | --- | --- |
| **Pool URL** | `stratum+tcp://<your-Umbrel-address>:3456` | `stratum2+tcp://<your-Umbrel-address>:3457/<authority-pubkey>` |
| **Username / Identity** | `<your-bitcoin-address>.<worker-name>` | `<your-bitcoin-address>.<worker-name>` |
| **Password** | `x` | *(unused)* |
| **Extra port** | — | `3458` *(optional Job Declaration with IPC Mining Interface)* |

> Enable Stratum V2 anytime in **Settings &rarr; Stratum V2** (Stratum V1 stays active on `3456`). Copy the authority public key or scan the QR code from **Connect &rarr; Stratum V2**.

<details>
<summary><strong>Updating, switching from the official store, and backups</strong></summary>

- **Updates:** Update from the same store you installed Bassin from. An existing `data/config/ckpool.conf` is preserved on update rather than overwritten from the template. If an earlier first setup left a partial file, follow the [private backup and recovery instructions](https://github.com/blockdyor/bassin/blob/main/docs/getting-started.md#interrupted-first-setup).
- **Official vs. Community store:** The [official Umbrel listing](https://apps.umbrel.com/app/bassin) installs a separate app (`bassin`, web port `5008`) with its own data directory. Both apps bind host Stratum ports (`3456`, plus `3457`/`3458` for Stratum V2) — stop one pool before starting the other.
- **Backups:** Before switching or uninstalling, stop the app and back up `data/config/ckpool.conf`, `data/sv2/` (private Stratum V2 Noise keys), and stats under `data/www/pool/` and `data/www/users/`. Keep backups private and outside `data/www` (which the dashboard serves). See the [installation and migration guide](https://github.com/blockdyor/bassin/blob/main/docs/getting-started.md).
- **Security:** Report vulnerabilities privately via the [security policy](https://github.com/blockdyor/bassin/blob/main/SECURITY.md); never post RPC credentials.

</details>

---

## Bitcoin Roots

<table>
  <tr>
    <td width="96" align="center" valign="middle">
      <img src="blockdyor-bitcoin-roots/icon.svg" width="76" height="76" alt="Bitcoin Roots">
    </td>
    <td>
      <strong>Personal Bitcoin Roots Node</strong> &middot; <code>blockdyor-bitcoin-roots</code> &middot; <code>v32.1.0-roots.2-blockdyor.4</code><br>
      Full node powered by <a href="https://plan-b.foundation/bitcoin-roots">Bitcoin Roots</a> (<code>v32.1-roots.2</code>) with a Plan-B dark interface, dedicated <strong>Relay &amp; Mining Policy</strong> settings tab, persistent Tor &amp; I2P services, dashboard widgets, and native Umbrel Bitcoin provider support.<br>
      <sub>
        <a href="blockdyor-bitcoin-roots/umbrel-app.yml">Manifest</a> &middot;
        <a href="blockdyor-bitcoin-roots/docker-compose.yml">Compose</a> &middot;
        <a href="blockdyor-bitcoin-roots/exports.sh">Exports</a> &middot;
        <a href="https://github.com/tiero/umbrel-bitcoin-roots">Upstream App</a> &middot;
        <a href="https://github.com/blockdyor/umbrel-bitcoin-roots">Image Build Repo</a> &middot;
        <a href="https://github.com/LuganoPlanB/bitcoin-roots">Bitcoin Roots Core</a>
      </sub>
    </td>
  </tr>
</table>

### Key features

- **Full Relay & Mining Policy UI:** Configure `datacarrier`, `datacarriersize`, `datacarriercost`, `datacarrierfullcount`, `rejecttokens`, `rejectparasites`, `permitbaremultisig`, `permitbarepubkey`, `permitbareanchor`, `permitephemeral`, `mempoolreplacement`, `mempooltruc`, `spkreuse`, `maxscriptsize`, `bytespersigopstrict`, `dustdynamic`, `blockmaxsize`, `blockmaxweight`, and `blockprioritysize` directly in **Settings &rarr; Relay &amp; Mining Policy**.
- **Native Umbrel Bitcoin Provider (`implements: bitcoin`):** Select **Bitcoin Roots** as the Bitcoin backend for **Core Lightning**, **Bassin** (including **IPC Mining Interface**), **LND**, **Electrs**, and other Bitcoin-dependent Umbrel apps.
- **Persistent Tor & I2P:** Dedicated unprivileged Tor and I2P sidecars with persistent P2P and RPC `.onion` addresses displayed automatically in **Connect**.
- **External Storage & Smart Backups:** Declares `storage.dataRoot: data` for umbrelOS storage relocation and excludes `blocks`, `chainstate`, and `indexes` from backups.

<details>
<summary><strong>Migrate from Bitcoin Core or Bitcoin Knots (no re-sync, no uninstall required first)</strong></summary>

> See the full illustrated step-by-step guide with screenshots and router port forwarding in **[MIGRATION.md](MIGRATION.md)**.

Bitcoin Roots uses standard Bitcoin ports (`8333` P2P, `8332` RPC) for full DNS-seed peer discovery and a dedicated Web UI port (`2111`). If migrating from **Bitcoin Core** (`8333`/`8332`), stop Bitcoin Core before installing Bitcoin Roots (you do **not** need to uninstall it). **Bitcoin Knots** uses `9333`/`9332` and does not collide. You can move your existing blockchain files and switch your apps before ever uninstalling your old node:

1. **Stop Bitcoin Core first** if you are migrating from `bitcoin` (skip this before install if migrating from Bitcoin Knots), then **install Bitcoin Roots** from this store.
2. **Stop both nodes** from the Umbrel UI (or via SSH: `umbreld client apps.stop.mutate --appId bitcoin` and `--appId blockdyor-bitcoin-roots`; use `bitcoin-knots` if migrating from Knots).
3. **Move the blockchain data** via SSH on your Umbrel (same-filesystem `mv` is instant and avoids doubling disk usage; do **not** move `bitcoin.conf` or `settings.json`):
   ```bash
   # Set SRC to "bitcoin" (Bitcoin Core) or "bitcoin-knots" (Bitcoin Knots)
   SRC=bitcoin
   SRC_DIR="$HOME/umbrel/app-data/$SRC/data/bitcoin"
   DST_DIR="$HOME/umbrel/app-data/blockdyor-bitcoin-roots/data/bitcoin"

   # Remove any empty initial folders created on first boot of Bitcoin Roots
   rm -rf "$DST_DIR/blocks" "$DST_DIR/chainstate" "$DST_DIR/indexes"

   # Move blocks (including blocks/xor.dat), chainstate, and indexes
   mv "$SRC_DIR/blocks" "$SRC_DIR/chainstate" "$DST_DIR/"
   [ -d "$SRC_DIR/indexes" ] && mv "$SRC_DIR/indexes" "$DST_DIR/"
   ```
   *(If you moved your node data to external storage in umbrelOS, replace `$HOME/umbrel/app-data/<app>/data` with that app's external data root.)*
4. **Start Bitcoin Roots** and wait for it to show **Synchronized 100%** on port `2111`.
5. **Switch dependent apps** (**Core Lightning**, **Bassin**, **LND**, **Electrs**, etc.) in Umbrel **App Settings &rarr; Dependencies** to **Bitcoin Roots** and verify they connect cleanly.
6. **Uninstall the old node** (`bitcoin` or `bitcoin-knots`) once you have verified everything works.
7. **Backups:** Back up `data/tor/` along with your app configuration to preserve your `.onion` P2P and RPC identities.

</details>

---

## Ports & Network

| App | App ID | Web UI | Published Host Ports | Internal Static IPs |
| --- | --- | :-: | --- | --- |
| **Bassin** | `blockdyor-bassin` | `5009` | `3456` (Stratum V1), `3457` (Stratum V2), `3458` (SV2 JD) | Dynamic (`app_proxy`) |
| **Bitcoin Roots** | `blockdyor-bitcoin-roots` | `2111` | `8333` (P2P), `8332` (RPC) | `10.21.120.8` (node), `.9` (Tor), `.10` (I2P) |

---

## FAQ

**Can I connect Core Lightning or Bassin directly to Bitcoin Roots?**
Yes. `blockdyor-bitcoin-roots` declares `implements: [bitcoin]` and exports the full `APP_BITCOIN_*` contract (including ZMQ and IPC). Pick **Bitcoin Roots** as the Bitcoin node dependency when installing or configuring Core Lightning, Bassin, LND, or Electrs.

**Can Bitcoin Roots run alongside Bitcoin Core and Bitcoin Knots?**
Bitcoin Roots uses standard Bitcoin host ports (`8333` P2P, `8332` RPC) with its own Web UI port (`2111`) and internal IPs (`10.21.120.8–10`). It runs side-by-side with **Bitcoin Knots** (`9333`/`9332`) with zero conflicts. With **Bitcoin Core** (`8333`/`8332`), both can stay installed on the same Umbrel, but only one can run at a time — stop Bitcoin Core before installing or starting Bitcoin Roots, move your chain data, switch dependent apps, and uninstall Bitcoin Core only after confirming everything works.

**Are container images verified and multi-architecture?**
Yes. Both **Bassin** and **Bitcoin Roots** pin every container image by `@sha256` multi-architecture manifest digest (`linux/amd64` + `linux/arm64`) built and integration-tested in GitHub Actions.

**How do I run the local packaging tests?**
```bash
python3 tests/bassin-packaging.py
python3 tests/bitcoin-roots-packaging.py
```

---

## Star History

<a href="https://www.star-history.com/blockdyor/blockdyor-umbrel-community-app-store#history">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=blockdyor/blockdyor-umbrel-community-app-store&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=blockdyor/blockdyor-umbrel-community-app-store&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=blockdyor/blockdyor-umbrel-community-app-store&type=Date" />
 </picture>
</a>
