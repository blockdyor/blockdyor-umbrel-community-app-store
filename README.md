# blockdyor Community App Store for umbrelOS

To install an app from this store, open the App Store on your Umbrel, choose Community App Stores, and add this repository URL:

```text
https://github.com/blockdyor/blockdyor-umbrel-community-app-store
```

## Install Bassin and connect a miner

1. Install the Bitcoin Node app (Bitcoin Core or Bitcoin Knots) on Umbrel and let it fully synchronize. Leave it running.
2. Install **Bassin** from the blockdyor store. Open the dashboard from Umbrel (web port `5009`) and select **Connect → Stratum** (V1), **Connect → Stratum V2**, or **Connect → Worker Setup**.
3. Configure your miner:
   - **Stratum V1:** `stratum+tcp://<your-Umbrel-address>:3456`, username `<your-bitcoin-address>.<worker-name>`, password `x`.
   - **Stratum V2 (Noise-encrypted):** `stratum2+tcp://<your-Umbrel-address>:3457/<authority-pubkey>` (shown with a QR code in **Connect → Stratum V2**), `user_identity` `<your-bitcoin-address>.<worker-name>`. (Optional Job Declaration listens on host port `3458` when enabled with Bitcoin Core v32.x IPC.)

## Update or switch stores

For an update, use the store you installed Bassin from. The [community manifest](blockdyor-bassin/umbrel-app.yml) lists its version and release notes; [Docker Compose](blockdyor-bassin/docker-compose.yml) pins its container images. An existing `data/config/ckpool.conf` is reused rather than regenerated from the template — existing installs can toggle Stratum V2 on directly in **Settings → Stratum V2**, and valid changes auto-save and reload CKPool automatically. If a previous first setup left a partial file, follow the [private backup and recovery instructions](https://github.com/blockdyor/bassin/blob/main/docs/getting-started.md#interrupted-first-setup); the update will not overwrite it.

The [official Umbrel listing](https://apps.umbrel.com/app/bassin) installs a separate app (`bassin`, web port `5008`). Switching to the community app (`blockdyor-bassin`) does not migrate your data. Both pools need host port `3456` (and 2.1.15 binds `3457`/`3458` for Stratum V2): stop the old pool before starting the new one.

Before switching or uninstalling, back up the stopped app's data directory, including `data/config/ckpool.conf`, `data/sv2/` (private Stratum V2 Noise keys), and the statistics in `data/www/pool/` and `data/www/users/`. These paths are relative to the installed app ID's directory. Keep the backup private and outside `data/www`, which the dashboard serves. Check the node settings before reusing a configuration and verify mining and statistics before removing the old data. See the [installation and migration guide](https://github.com/blockdyor/bassin/blob/main/docs/getting-started.md).

For help, see the [Bassin FAQ](https://github.com/blockdyor/bassin/blob/main/docs/FAQ.md) or [report a Bassin issue](https://github.com/blockdyor/bassin/issues). Report vulnerabilities privately using the [security policy](https://github.com/blockdyor/bassin/blob/main/SECURITY.md); do not post RPC credentials.

This store also includes [Memos](blockdyor-memos/umbrel-app.yml).
