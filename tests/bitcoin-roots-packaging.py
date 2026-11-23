"""Run with python3 tests/bitcoin-roots-packaging.py [package ...]; needs PyYAML (or yq v4), bash, shellcheck (optional)."""
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
                self.assertEqual(manifest["port"], 2106)
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

    def test_exports_sh(self):
        for package in packages:
            with self.subTest(package=package):
                exports = package / "exports.sh"
                self.assertTrue(exports.is_file())
                script = f"""
set -euo pipefail
derive_entropy() {{ printf '%s' "$1" | sha256sum | cut -d ' ' -f 1; }}
app_entropy_identifier=app-{package.name}-seed
before=$-
source {exports}
[[ "$before" == "$-" ]]
[[ "$APP_BITCOIN_ROOTS_NODE_IP" == "10.21.120.8" ]]
[[ "$APP_BITCOIN_ROOTS_TOR_IP" == "10.21.120.9" ]]
[[ "$APP_BITCOIN_ROOTS_I2P_IP" == "10.21.120.10" ]]
[[ "$APP_BITCOIN_ROOTS_RPC_USER" == "umbrel" ]]
first=$APP_BITCOIN_ROOTS_RPC_PASS
[[ "$first" != "$APP_BITCOIN_ROOTS_TOR_PASSWORD" ]]
source {exports}
[[ "$first" == "$APP_BITCOIN_ROOTS_RPC_PASS" ]]
printf '%s %s' "$APP_BITCOIN_ROOTS_RPC_PASS" "$APP_BITCOIN_ROOTS_TOR_PASSWORD"
"""
                out = subprocess.check_output(["bash", "-c", script], text=True)
                rpc_pass, tor_pass = out.split(" ")
                self.assertRegex(rpc_pass, r"^[a-f0-9]{64}$")
                self.assertRegex(tor_pass, r"^[a-f0-9]{64}$")

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
                self.assertIn("HiddenServicePort 8332 10.21.120.8:8332", torrc)
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
                self.assertEqual(services["app"]["ports"], ["8333:8333", "8332:8332"])
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
