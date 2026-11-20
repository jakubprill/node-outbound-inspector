// Odświeża zrzuty golden (npm run golden:update). Zmienna środowiskowa ustawiana tutaj, a nie w skrypcie
// package.json, bo składnia `ZMIENNA=1 polecenie` nie działa w cmd.exe na Windows (issue #7).
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['--test', 'test/golden/golden.test.mjs'], { stdio: 'inherit', env: { ...process.env, UPDATE_GOLDEN: '1' } });
process.exit(r.status ?? 1);
