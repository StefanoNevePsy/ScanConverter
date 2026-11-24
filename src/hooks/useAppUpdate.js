import { useCallback, useEffect, useRef, useState } from 'react';

const SEIORE = 6 * 60 * 60 * 1000;

/** Ponte desktop, solo nell'app Electron (altrove è null). */
export function desktopUpdater() {
  const d = typeof window !== 'undefined' ? window.scanConverterDesktop : null;
  return d?.updateCheck ? d : null;
}

/**
 * Controlla gli aggiornamenti dell'app desktop: una volta all'avvio e poi ogni
 * sei ore. `check()` forza il controllo e dice com'è andata.
 * phase: idle | checking | downloading | error
 */
export function useAppUpdate({ auto = false } = {}) {
  const bridge = desktopUpdater();
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState({ pct: 0, received: 0, total: 0 });
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (!bridge || busy.current) return null;
    setPhase('checking');
    try {
      const result = await bridge.updateCheck();
      setInfo(result);
      setError(result?.error || '');
      setChecked(true);
      setPhase('idle');
      return result;
    } catch (e) {
      setError('Controllo non riuscito.');
      setPhase('idle');
      return null;
    }
  }, [bridge]);

  useEffect(() => {
    if (!auto || !bridge) return undefined;
    check();
    const id = setInterval(check, SEIORE);
    return () => clearInterval(id);
  }, [auto, bridge, check]);

  const install = useCallback(async () => {
    if (!bridge) return;
    busy.current = true;
    setError('');
    setProgress({ pct: 0, received: 0, total: 0 });
    setPhase('downloading');
    const off = bridge.onUpdateProgress?.((p) => setProgress(p));
    try {
      const result = await bridge.updateInstall();
      if (!result?.ok) {
        setError(result?.error || 'Aggiornamento non riuscito.');
        setPhase('error');
      }
    } catch (e) {
      setError('Aggiornamento non riuscito.');
      setPhase('error');
    } finally {
      off?.();
      busy.current = false;
    }
  }, [bridge]);

  return { supported: Boolean(bridge), info, phase, progress, error, checked, check, install };
}
