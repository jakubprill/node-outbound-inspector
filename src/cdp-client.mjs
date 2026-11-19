// Połączenie WebSocket z inspektorem (Chrome DevTools Protocol).
// `send` rozwiązuje się wynikiem albo null (błąd, przekroczony czas, brak połączenia).

/**
 * @param {string} wsUrl
 * @param {{ timeoutMs: number, onOpen?: () => void, onEvent?: (method: string, params: any) => void, onClose?: () => void }} opts
 */
export function connectCdp(wsUrl, { timeoutMs, onOpen, onEvent, onClose }) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise(res => {
    if (ws.readyState !== 1) return res(null);
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.delete(i)) res(null); }, timeoutMs);
  });
  ws.onopen = () => onOpen?.();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? null : m.result); pending.delete(m.id); return; }
    if (m.method) onEvent?.(m.method, m.params);
  };
  ws.onclose = () => onClose?.();
  ws.onerror = () => {};
  return { send, close: () => ws.close() };
}
