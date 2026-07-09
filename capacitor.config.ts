import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scanconverter.app',
  appName: 'ScanConverter',
  webDir: 'dist',
  // Su nativo, CapacitorHttp intercetta window.fetch e instrada le richieste
  // via HTTP nativo: le chiamate a NVIDIA/Google non passano dal webview e
  // NON sono soggette a CORS. Sul web resta la fetch standard del browser.
  plugins: {
    CapacitorHttp: { enabled: true },
    StatusBar: { overlaysWebView: false, style: 'DARK', backgroundColor: '#111317' },
    Keyboard: { resize: 'native' },
  },
  android: {
    // Consente il caricamento dei grandi asset WASM dal file system locale.
    allowMixedContent: false,
    backgroundColor: '#111317',
  },
};

export default config;
