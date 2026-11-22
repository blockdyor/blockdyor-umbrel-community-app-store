"""Run with python3 tests/bassin-packaging.py [package ...]; needs yq v4, node, envsubst."""
import json, os, shlex, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

packages = [Path(p).resolve() for p in sys.argv[1:]] or [Path(__file__).resolve().parents[1] / 'blockdyor-bassin']
sys.argv[1:] = []

class Packaging(unittest.TestCase):
    def test_init(self):
        for package in packages:
            with self.subTest(package=package), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                template = root / 'ckpool.conf.template'
                shutil.copy(package / 'data/config' / template.name, template)
                conf = root / 'ckpool.conf'
                entry = json.loads(subprocess.check_output(['yq', '-o=json', '.services.init.entrypoint', package / 'docker-compose.yml']))
                argv = shlex.split(entry) if isinstance(entry, str) else entry
                argv[-1] = argv[-1].replace('/config/', tmp + '/').replace('/sv2', tmp + '/sv2').replace('$$', '$')
                env = dict(os.environ, PATH=tmp + ':' + os.environ['PATH'], APP_BITCOIN_RPC_USER='fixture-user')
                # apk is container-only; assert the requested ownership without needing root.
                for name, body in [('apk','exit 0'), ('chown','test "$1" = 1000:1000 && test -e "$2"'), ('envsubst','printf partial; exit 42')]:
                    (root/name).write_text('#!/bin/sh\n' + body + '\n'); (root/name).chmod(0o755)
                self.assertNotEqual(subprocess.run(argv, env=env).returncode, 0)
                self.assertFalse(conf.exists(), 'failed render published a partial config')
                (root/'envsubst').unlink()
                subprocess.run(argv, env=env, check=True)
                self.assertEqual(json.loads(conf.read_text())['btcd'][0]['auth'], 'fixture-user')
                self.assertEqual(conf.stat().st_mode & 0o777, 0o600)
                for content in ['{"custom":true}', 'old partial']:
                    conf.write_text(content); conf.chmod(0o640)
                    subprocess.run(argv, env=env, check=True)
                    self.assertEqual((conf.read_text(), conf.stat().st_mode & 0o777), (content, 0o640))

    def test_dashboard(self):
        for package in packages:
            if not (package/'tools/dashboard.cjs').exists(): continue
            with tempfile.TemporaryDirectory() as tmp:
                app = Path(tmp)/'app'; shutil.copytree(package, app, symlinks=True)
                www = app/'data/www'; (www/'pool').mkdir(); (www/'users').mkdir()
                (www/'pool/pool.status').write_text('{}\n{"hashrate5m":"fixture-rate"}\n{"bestshare":1,"accepted":1,"rejected":0}')
                (www/'users/fixture-user').write_text('{"bestshare":1,"bestever":1,"shares":1}')
                # Disable only the recurring timer; exercise the real first dashboard refresh.
                preload = Path(tmp)/'once.cjs'; preload.write_text('global.setInterval = () => {};')
                result = subprocess.run(['node','-r',preload,app/'tools/dashboard.cjs'], cwd=tmp, capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                for marker in ('fixture-user', 'fixture-rate'): self.assertIn(marker, result.stdout)

if __name__ == '__main__': unittest.main()
