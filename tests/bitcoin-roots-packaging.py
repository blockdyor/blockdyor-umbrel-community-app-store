"""Run with python3 tests/bitcoin-roots-packaging.py [package ...]; needs PyYAML (or yq v4), bash, jq, shellcheck (optional)."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

packages = [Path(p).resolve() for p in sys.argv[1:]] or [
    Path(__file__).resolve().parents[1] / "blockdyor-bitcoin-roots"
]
sys.argv[1:] = []


def load_yaml(path: Path):
    if yaml is not None:
        return yaml.safe_load(path.read_text())
    return json.loads(subprocess.check_output(["yq", "-o=json", ".", str(path)]))


class BitcoinRootsPackaging(unittest.TestCase):
    def test_manifest_and_store_contract(self):
        store_root = Path(__file__).resolve().parents[1]
        store_meta = load_yaml(store_root / "umbrel-app-store.yml")
        store_id = store_meta["id"]

        for package in packages:
            with self.subTest(package=package):
                manifest = load_yaml(package / "umbrel-app.yml")
                self.assertEqual(manifest["id"], package.name)
                self.assertTrue(
                    manifest["id"].startswith(f"{store_id}-"),
                    f"app id {manifest['id']} must start with store prefix {store_id}-",
                )
                self.assertEqual(manifest["implements"], ["bitcoin"])
                self.assertEqual(manifest["port"], 2111)
                self.assertEqual(manifest["storage"], {"dataRoot": "data"})
                self.assertTrue(manifest["icon"].startswith("https://"))
                self.assertTrue((package / "icon.png").is_file())
                self.assertIn(f"/{package.name}/icon.png", manifest["icon"])
                self.assertEqual(manifest["dependencies"], [])
                widget_endpoints = {w["id"]: w["endpoint"] for w in manifest["widgets"]}
                self.assertEqual(
                    widget_endpoints,
                    {
                        "stats": "app:3000/api/widget/stats",
                        "sync": "app:3000/api/widget/sync",
                    },
                )
                self.assertIn("data/bitcoin/blocks", manifest["backupIgnore"])

    def test_exports_sh_self_and_dependents(self):
        required_bitcoin_vars = [
            "APP_BITCOIN_NODE_IP",
            "APP_BITCOIN_TOR_PROXY_IP",
            "APP_BITCOIN_I2P_DAEMON_IP",
            "APP_BITCOIN_DATA_DIR",
            "APP_BITCOIN_RPC_PORT",
            "APP_BITCOIN_P2P_PORT",
            "APP_BITCOIN_P2P_WHITEBIND_PORT",
            "APP_BITCOIN_TOR_PORT",
            "APP_BITCOIN_ZMQ_RAWBLOCK_PORT",
            "APP_BITCOIN_ZMQ_RAWTX_PORT",
            "APP_BITCOIN_ZMQ_HASHBLOCK_PORT",
            "APP_BITCOIN_ZMQ_SEQUENCE_PORT",
            "APP_BITCOIN_ZMQ_HASHTX_PORT",
            "APP_BITCOIN_NETWORK",
            "APP_BITCOIN_NETWORK_ELECTRS",
            "APP_BITCOIN_IPC_ENABLED",
            "APP_BITCOIN_IPC_SOCKET_RELATIVE_PATH",
            "APP_BITCOIN_RPC_USER",
            "APP_BITCOIN_RPC_PASS",
            "APP_BITCOIN_RPC_HIDDEN_SERVICE",
            "APP_BITCOIN_P2P_HIDDEN_SERVICE",
        ]

        def source_exports(exports: Path, caller_app: str, data_root: Path):
            script = f"""
set -euo pipefail
derive_entropy() {{ printf '%s' "$1" | sha256sum | cut -d ' ' -f 1; }}
app_entropy_identifier="app-{caller_app}-seed"
EXPORTS_APP_ID="{exports.parent.name}"
EXPORTS_APP_DIR="/umbrel/app-data/{exports.parent.name}"
EXPORTS_APP_DATA_DIR="{data_root}"
before=$-
source "{exports}"
[[ "$before" == "$-" ]]
for k in {' '.join(required_bitcoin_vars + ['APP_BITCOIN_ROOTS_RPC_PASS', 'APP_BITCOIN_ROOTS_TOR_PASSWORD'])}; do
  printf '%s=%s\\n' "$k" "${{!k}}"
done
"""
            out = subprocess.check_output(["bash", "-c", script], text=True)
            return dict(line.split("=", 1) for line in out.strip().splitlines())

        for package in packages:
            with self.subTest(package=package), tempfile.TemporaryDirectory() as tmp:
                exports = package / "exports.sh"
                self.assertTrue(exports.is_file())
                data_root = Path(tmp) / "data"
                (data_root / "app").mkdir(parents=True)
                (data_root / "tor/rpc").mkdir(parents=True)
                (data_root / "tor/p2p").mkdir(parents=True)
                rpc_onion = "a" * 56 + ".onion"
                p2p_onion = "b" * 56 + ".onion"
                (data_root / "tor/rpc/hostname").write_text(rpc_onion + "\n")
                (data_root / "tor/p2p/hostname").write_text(p2p_onion + "\n")

                # 1. Sourced by Bitcoin Roots itself (default mainnet, ipc off)
                self_env = source_exports(exports, package.name, data_root)
                self.assertEqual(self_env["APP_BITCOIN_NODE_IP"], "10.21.120.8")
                self.assertEqual(self_env["APP_BITCOIN_TOR_PROXY_IP"], "10.21.120.9")
                self.assertEqual(self_env["APP_BITCOIN_I2P_DAEMON_IP"], "10.21.120.10")
                self.assertEqual(self_env["APP_BITCOIN_DATA_DIR"], str(data_root / "bitcoin"))
                self.assertEqual(self_env["APP_BITCOIN_RPC_PORT"], "10332")
                self.assertEqual(self_env["APP_BITCOIN_P2P_PORT"], "10333")
                self.assertEqual(self_env["APP_BITCOIN_P2P_WHITEBIND_PORT"], "10335")
                self.assertEqual(self_env["APP_BITCOIN_ZMQ_HASHBLOCK_PORT"], "28334")
                self.assertEqual(self_env["APP_BITCOIN_NETWORK"], "mainnet")
                self.assertEqual(self_env["APP_BITCOIN_NETWORK_ELECTRS"], "bitcoin")
                self.assertEqual(self_env["APP_BITCOIN_IPC_ENABLED"], "false")
                self.assertEqual(self_env["APP_BITCOIN_IPC_SOCKET_RELATIVE_PATH"], "node.sock")
                self.assertEqual(self_env["APP_BITCOIN_RPC_HIDDEN_SERVICE"], rpc_onion)
                self.assertEqual(self_env["APP_BITCOIN_P2P_HIDDEN_SERVICE"], p2p_onion)
                self.assertRegex(self_env["APP_BITCOIN_RPC_PASS"], r"^[a-f0-9]{64}$")
                self.assertRegex(self_env["APP_BITCOIN_ROOTS_TOR_PASSWORD"], r"^[a-f0-9]{64}$")
                self.assertNotEqual(
                    self_env["APP_BITCOIN_RPC_PASS"],
                    self_env["APP_BITCOIN_ROOTS_TOR_PASSWORD"],
                )

                # 2. Sourced by dependent apps (Core Lightning, Bassin): must get identical RPC pass!
                for dependent in ("core-lightning", "blockdyor-bassin", "lightning", "electrs"):
                    dep_env = source_exports(exports, dependent, data_root)
                    self.assertEqual(
                        dep_env["APP_BITCOIN_RPC_PASS"],
                        self_env["APP_BITCOIN_RPC_PASS"],
                        f"dependent {dependent} derived a different RPC password",
                    )
                    self.assertEqual(dep_env["APP_BITCOIN_NODE_IP"], "10.21.120.8")
                    self.assertEqual(dep_env["APP_BITCOIN_RPC_USER"], "umbrel")

                # 3. Settings override: testnet4 + IPC enabled
                (data_root / "app/settings.json").write_text(
                    json.dumps({"chain": "testnet4", "ipc": True})
                )
                t4_env = source_exports(exports, "blockdyor-bassin", data_root)
                self.assertEqual(t4_env["APP_BITCOIN_NETWORK"], "testnet4")
                self.assertEqual(t4_env["APP_BITCOIN_NETWORK_ELECTRS"], "testnet4")
                self.assertEqual(t4_env["APP_BITCOIN_IPC_ENABLED"], "true")
                self.assertEqual(t4_env["APP_BITCOIN_IPC_SOCKET_RELATIVE_PATH"], "testnet4/node.sock")

    def test_tor_entrypoint(self):
        for package in packages:
            with self.subTest(package=package), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                script_src = (package / "hooks/tor-entrypoint.sh").read_text()
                patched = script_src.replace("/data/tor", f"{tmp}/data/tor").replace(
                    "/tmp/roots-torrc", f"{tmp}/roots-torrc"
                )
                entry = root / "tor-entrypoint.sh"
                entry.write_text(patched)

                fake_tor = root / "tor"
                fake_tor.write_text(
                    "#!/bin/sh\n"
                    'if [ "$1" = "--hash-password" ]; then echo "16:ABCDEF1234567890"; exit 0; fi\n'
                    'echo "EXEC:$*"\n'
                )
                fake_tor.chmod(0o755)

                env = dict(
                    os.environ,
                    PATH=f"{tmp}:{os.environ['PATH']}",
                    TOR_CONTROL_PASSWORD="deadbeef1234",
                    BITCOIND_IP="10.21.120.8",
                    RPC_PORT="10332",
                )
                res = subprocess.run(
                    ["bash", str(entry)],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertIn(f"EXEC:-f {tmp}/roots-torrc", res.stdout)
                torrc = (root / "roots-torrc").read_text()
                self.assertIn("HashedControlPassword 16:ABCDEF1234567890", torrc)
                self.assertIn("HiddenServicePort 8333 10.21.120.8:8334", torrc)
                self.assertIn("HiddenServicePort 8332 10.21.120.8:10332", torrc)
                self.assertEqual((root / "data/tor").stat().st_mode & 0o777, 0o700)

    def test_compose_contract(self):
        digest_re = re.compile(r"^.+@sha256:[a-f0-9]{64}$")
        for package in packages:
            with self.subTest(package=package):
                compose = load_yaml(package / "docker-compose.yml")
                services = compose["services"]
                self.assertEqual(
                    services["app_proxy"]["environment"],
                    {"APP_HOST": "${APP_BITCOIN_ROOTS_NODE_IP}", "APP_PORT": 3000},
                )
                for svc_name in ("app", "tor", "i2p"):
                    image = services[svc_name]["image"]
                    self.assertRegex(
                        image,
                        digest_re,
                        f"service {svc_name} image must be digest-pinned: {image}",
                    )
                self.assertEqual(
                    services["app"]["ports"],
                    [
                        "${APP_BITCOIN_ROOTS_P2P_PORT}:${APP_BITCOIN_ROOTS_P2P_PORT}",
                        "${APP_BITCOIN_ROOTS_RPC_PORT}:${APP_BITCOIN_ROOTS_RPC_PORT}",
                    ],
                )
                self.assertEqual(services["app"]["user"], "1000:1000")
                self.assertEqual(services["tor"]["user"], "1000:1000")
                self.assertEqual(services["i2p"]["user"], "root")
                self.assertTrue((package / "data/.gitkeep").is_file())
                self.assertTrue((package / "data/i2pd/.gitkeep").is_file())

    def test_shellcheck_if_installed(self):
        if not shutil.which("shellcheck"):
            self.skipTest("shellcheck not installed")
        for package in packages:
            subprocess.run(
                [
                    "shellcheck",
                    str(package / "exports.sh"),
                    str(package / "hooks/tor-entrypoint.sh"),
                ],
                check=True,
            )


if __name__ == "__main__":
    unittest.main()
