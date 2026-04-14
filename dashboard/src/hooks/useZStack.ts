import { useCallback, useRef, useState } from 'react';

// Tracks a monotonic z-index per pane id. Call focus(paneId) on mousedown/click
// to bring that window to the top. Returns zOf(paneId) for render.
export function useZStack() {
  const [, force] = useState(0);
  const zRef = useRef<Map<number, number>>(new Map());
  const topRef = useRef(10);

  const focus = useCallback((paneId: number) => {
    topRef.current += 1;
    zRef.current.set(paneId, topRef.current);
    force((n) => n + 1);
  }, []);

  const zOf = useCallback((paneId: number) => zRef.current.get(paneId) ?? 10, []);

  return { focus, zOf };
}
