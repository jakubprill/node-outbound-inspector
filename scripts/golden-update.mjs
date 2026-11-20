// Refreshes the golden snapshots (npm run golden:update). The environment variable is set here, not in the
// package.json script, because the `VARIABLE=1 command` syntax does not work in cmd.exe on Windows (issue #7).
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['--test', 'test/golden/golden.test.mjs'], { stdio: 'inherit', env: { ...process.env, UPDATE_GOLDEN: '1' } });
process.exit(r.status ?? 1);
