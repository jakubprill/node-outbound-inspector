// Reguły pomijania zapytań przy przyjęciu (czyste): hosty z IGNORE_HOSTS, ruch do inspektorów
// i eksport OpenTelemetry (OTLP). Pominięte zapytania nie trafiają do magazynu.
//
// OTLP rozpoznajemy po sygnaturze, nie po samej ścieżce: `/v1/traces|metrics|logs` tylko na
// domyślnym porcie OTLP/HTTP 4318 (dowolny host: localhost, 127.0.0.1, kontener kolektora),
// a ścieżkę usługi OTLP/gRPC na dowolnym porcie (jest jednoznaczna). Sama ścieżka `/v1/logs`
// bez portu mogłaby ukryć prawdziwy ruch, np. własny backend z takim API.

const OTLP_HTTP_PORT = '4318';
const OTLP_HTTP_PATH = /^\/v1\/(traces|metrics|logs)\/?$/;
const OTLP_GRPC_PATH = /^\/opentelemetry\.proto\.collector\.(trace|metrics|logs)\.v1\.(Trace|Metrics|Logs)Service\/Export$/;

/** Opis reguł OTLP dla inspector_status (w tej samej postaci co wzorce: host:port/ścieżka). */
export const OTLP_RULES = Object.freeze([
  '*:4318/v1/traces', '*:4318/v1/metrics', '*:4318/v1/logs',
  '*/opentelemetry.proto.collector.{trace,metrics,logs}.v1.*Service/Export',
]);

/** @param {URL} u */
export function isOtlpExport(u) {
  return (u.port === OTLP_HTTP_PORT && OTLP_HTTP_PATH.test(u.pathname)) || OTLP_GRPC_PATH.test(u.pathname);
}

/**
 * Powód pominięcia zapytania albo null, gdy zapytanie trafia do magazynu.
 * @param {string} url
 * @param {{ ignoreHosts?: readonly string[], inspectorPorts?: readonly number[], ignoreOtlp?: boolean }} rules
 * @returns {'hosts' | 'inspector' | 'otlp' | null}
 */
export function ignoreReason(url, { ignoreHosts = [], inspectorPorts = [], ignoreOtlp = false }) {
  let u = null;
  try { u = new URL(url); } catch {}
  const host = u?.host ?? '';
  if (ignoreHosts.some(h => host.includes(h))) return 'hosts';
  if (inspectorPorts.some(port => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return 'inspector';
  if (ignoreOtlp && u && isOtlpExport(u)) return 'otlp';
  return null;
}
