/*
  Integrazione con le funzionalità native (Capacitor). Tutto è no-op sul web:
  le funzioni controllano `Capacitor.isNativePlatform()` prima di agire, così
  lo stesso codice gira invariato nel browser e nell'app Android.
*/

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNative = Capacitor.isNativePlatform();

/** Configura la status bar (tema scuro) all'avvio. */
export async function initNativeShell() {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: '#111317' });
    }
  } catch {
    /* plugin non disponibile: si ignora */
  }
}

/**
 * Registra un handler per il tasto/gesture "indietro" di Android.
 * L'handler riceve `{ canGoBack }` e deve restituire `true` se ha gestito
 * la navigazione, `false` per lasciar chiudere l'app.
 *
 * @param {(info:{canGoBack:boolean})=>boolean} handler
 * @returns {() => void} funzione per rimuovere il listener
 */
export function onBackButton(handler) {
  if (!isNative) return () => {};
  let remove = () => {};
  App.addListener('backButton', (info) => {
    const handled = handler(info);
    if (!handled) App.exitApp();
  }).then((h) => {
    remove = () => h.remove();
  });
  return () => remove();
}
