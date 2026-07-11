/*
  File condivisi verso l'app (Android): il plugin nativo IncomingFile cattura
  l'intent di condivisione ("Condividi" / "Apri con") e ne restituisce i byte;
  qui li trasformiamo in un oggetto File standard, pronto per la pipeline.
*/

import { Capacitor, registerPlugin } from '@capacitor/core';

const IncomingFile = registerPlugin('IncomingFile');

/** Decodifica base64 → Uint8Array. */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Costruisce un File dal payload del plugin, o null. */
function toFile(res) {
  if (!res?.available || !res.data) return null;
  const bytes = base64ToBytes(res.data);
  const type = res.mime || 'application/octet-stream';
  return new File([bytes], res.name || 'documento', { type });
}

/**
 * Recupera l'eventuale file condiviso con cui l'app è stata aperta (avvio a
 * freddo). Da chiamare al montaggio.
 * @returns {Promise<File|null>}
 */
export async function getSharedFile() {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return toFile(await IncomingFile.getPending());
  } catch {
    return null;
  }
}

/**
 * Registra un handler per i file condivisi ad app GIÀ aperta (nuovo intent).
 * @param {(file: File) => void} handler
 * @returns {() => void} funzione per annullare la registrazione
 */
export function onSharedFile(handler) {
  if (!Capacitor.isNativePlatform()) return () => {};
  const p = IncomingFile.addListener('fileReady', async () => {
    const file = toFile(await IncomingFile.getPending());
    if (file) handler(file);
  });
  return () => {
    p.then((h) => h.remove()).catch(() => {});
  };
}
