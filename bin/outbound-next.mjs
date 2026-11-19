#!/usr/bin/env node
// outbound-next: `next` uruchomiony pod Node z --experimental-network-inspection, bez zależności od powłoki
// (działa w cmd.exe, PowerShell i sh). Użycie w package.json aplikacji:
//   "dev:inspect": "outbound-next dev --port 3101 --inspect=9231"
// Wszystkie argumenty trafiają do `next`. Od M3 to samo da `outbound run -- next dev`.
import { runNext } from '../src/cli/launch.mjs';

await runNext();
