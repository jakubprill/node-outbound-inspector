#!/usr/bin/env node
// outbound-next: `next` run under Node with --experimental-network-inspection, without depending on a shell
// (works in cmd.exe, PowerShell and sh). Usage in an app's package.json:
//   "dev:inspect": "outbound-next dev --port 3101 --inspect=9231"
// All arguments go to `next`. From M3, `outbound run -- next dev` will do the same.
import { runNext } from '../src/cli/launch.mjs';

await runNext();
