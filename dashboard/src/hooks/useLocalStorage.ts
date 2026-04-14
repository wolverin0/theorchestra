import { useCallback, useEffect, useState } from 'react';

// Versioned localStorage hook. Key should include a version suffix (e.g. `theorchestra:foo:v2`).
// On parse failure (schema drift / manual tampering), falls back to the default and clears the bad value.
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch {
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
      return defaultValue;
    }
  });

  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* quota / private mode */ }
      return next;
    });
  }, [key]);

  // Cross-tab sync: listen for storage events on this key and update our state.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== key || e.newValue == null) return;
      try { setValue(JSON.parse(e.newValue) as T); } catch { /* ignore malformed */ }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [key]);

  return [value, set];
}
