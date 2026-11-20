// Połączenie WebSocket z inspektorem (Chrome DevTools Protocol).
// `send` rozwiązuje się wynikiem albo null (błąd, przekroczony czas, brak połączenia).

/**
 * @param {string} wsUrl
 * @param {{ timeoutMs: number, onOpen?: () => void, onEvent?: (method: string, params: any) => void, onClose?: () => void }} opts
 */
export function connectCdp(wsUrl, { timeoutMs, onOpen, onEvent, onClose, onError = () => {} }) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise(res => {
    if (ws.readyState !== 1) return res(null);
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.delete(i)) res(null); }, timeoutMs);
  });
  ws.onopen = () => onOpen?.();
  // druga strona to dowolny lokalny proces: zniekształcona wiadomość ani błąd obsługi zdarzenia nie mogą wywrócić kolektora (audyt B-04)
  ws.onmessage = ({ data }) => {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : ''); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? null : m.result); pending.delete(m.id); return; }
    if (typeof m.method === 'string') {
      try { onEvent?.(m.method, m.params && typeof m.params === 'object' ? m.params : {}); } catch (e) { onError(e); }
    }
  };
  ws.onclose = () => onClose?.();
  ws.onerror = () => {};
  return { send, close: () => ws.close() };
}
