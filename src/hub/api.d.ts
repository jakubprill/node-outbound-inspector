// Typy programowego API huba: `import { startHub } from 'node-outbound-inspector/hub'` (issue #9).

export interface StartHubOptions {
  /** Interface to listen on. Default `127.0.0.1` (loopback only). */
  host?: string;
  /** Hub port. Default 9229 — on the default list of chrome://inspect. `0` picks a free port. */
  port?: number;
  /** Inspector ports to scan: array or spec like `"9230-9249,9300"`. Default `"9230-9249"`. */
  ports?: readonly number[] | string;
  /** Names by inspector port: object or spec like `"9231=web,9241=admin"`. */
  appNames?: Record<string | number, string> | string;
  /** Show package names without the npm scope (`@acme/web` → `web`). Default `true`. */
  stripScope?: boolean;
  /** Read the app name from the process over CDP (read-only). Default `true`. */
  identify?: boolean;
  /** Scan interval in ms. Default 1500. */
  scanIntervalMs?: number;
  /** Log sink for hub messages (found apps, DevTools connections). Default: silent. */
  log?: (message: string) => void;
}

export interface HubApp {
  port: number;
  app: string;
  targets: number;
}

export interface Hub {
  /**
   * `listening` — this hub is listening; `already-running` — another outbound-hub already serves the port
   * (nothing to do); `port-taken` — another process holds the port (e.g. `node --inspect` without a port).
   */
  status: 'listening' | 'already-running' | 'port-taken';
  /** Port in use (the actual port when `port: 0` was requested). */
  port: number;
  /** `http://127.0.0.1:<port>` when listening. */
  url?: string;
  /** Who holds the port, when known (`outbound-hub 0.7.0`, `node.js/v24.1.0`). */
  holder?: string | null;
  /** Package version of node-outbound-inspector. */
  version: string;
  /** Apps currently found (empty unless listening). */
  apps(): HubApp[];
  /** Stops the hub. Safe to call more than once and for every status. */
  close(): Promise<void>;
}

/** Starts the chrome://inspect hub in the current process. Throws only for Node < 24 or unexpected listen errors. */
export function startHub(options?: StartHubOptions): Promise<Hub>;

export const HUB_MARKER: string;
export const DEFAULT_HUB_PORT: number;
export const DEFAULT_INSPECTOR_PORTS: string;
