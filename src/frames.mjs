// Ramki stosu inicjatora → miejsca wywołania w kodzie aplikacji (bez wnętrza Node, Next.js, React, undici).

const LIBRARY = /node_modules[\\/](next|react|react-dom|undici)[\\/]/;
const NEXT_INTERNALS = /[\\/]\.next[\\/].*_next_dist_|[\\/]\.next[\\/]server[\\/](edge-)?runtime|next[\\/]dist[\\/]/;

/** @returns {string[]} do 5 ramek „funkcja @ ścieżka:linia:kolumna” */
export function userFrames(initiator) {
  const frames = [];
  for (let st = initiator?.stack; st; st = st.parent) frames.push(...(st.callFrames ?? []));
  return frames
    .filter(f => f.url && !f.url.startsWith('node:') && !LIBRARY.test(f.url) && !NEXT_INTERNALS.test(f.url))
    .slice(0, 5)
    .map(f => `${f.functionName || '(anonymous)'} @ ${f.url.replace(/^file:\/\//, '')}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
}
