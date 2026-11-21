# blockdyor Community App Store for umbrelOS

To install an app from this store, open the App Store on your Umbrel, choose Community App Stores, and add this repository URL:

```text
https://github.com/blockdyor/blockdyor-umbrel-community-app-store
```

## Install Bassin and connect a miner

1. Install the Bitcoin Node app on Umbrel and let it fully synchronize. Leave it running.
2. Install **Bassin** from the blockdyor store. Open the dashboard from Umbrel (web port `5009`) and select **Connect → Worker Setup**.
3. In your miner settings, enter `stratum+tcp://<your-Umbrel-address>:3456` as the pool URL. Use your Umbrel's LAN address or hostname. Set the username to `<your-bitcoin-address>.<worker-name>` using a receiving address from your own wallet, and the password to `x`.

## Update or switch stores

For an update, use the store you installed Bassin from. The [community manifest](blockdyor-bassin/umbrel-app.yml) lists its version and release notes; [Docker Compose](blockdyor-bassin/docker-compose.yml) pins its container images. An existing `data/config/ckpool.conf` is reused rather than regenerated from the template.

The [official Umbrel listing](https://apps.umbrel.com/app/bassin) installs a separate app (`bassin`, web port `5008`). Switching to the community app (`blockdyor-bassin`) does not migrate your data. Both pools need host port `3456`: stop the old pool before starting the new one.

Before switching or uninstalling, back up the stopped app's data directory, including `data/config/ckpool.conf` and the statistics in `data/www/pool/` and `data/www/users/`. These paths are relative to the installed app ID's directory. Keep the backup private and outside `data/www`, which the dashboard serves. Check the node settings before reusing a configuration and verify mining and statistics before removing the old data. See the [installation and migration guide](https://github.com/blockdyor/bassin/blob/main/docs/getting-started.md).

For help, see the [Bassin FAQ](https://github.com/blockdyor/bassin/blob/main/docs/FAQ.md) or [report a Bassin issue](https://github.com/blockdyor/bassin/issues). Report vulnerabilities privately using the [security policy](https://github.com/blockdyor/bassin/blob/main/SECURITY.md); do not post RPC credentials.

This store also includes [Memos](blockdyor-memos/umbrel-app.yml).
