# ScanConverter

Digitalizzazione e re-impaginazione di documenti accademici e paper storici.
Da una **fotocopia scansionata** a un **PDF vettoriale pulito** con margini
ampi per le annotazioni — in quattro passi, di cui l'ultimo eseguito
interamente nel browser.

```
Immagine/PDF  →  [1/3] OCR (NVIDIA Nemotron-Parse)
              →  [2/3] Layout (Google Gemini → codice Typst)
              →  [3/3] Compilazione (Typst WASM, locale)  →  PDF vettoriale
```

## Stack

- **React 18 + Vite 6** — SPA, dark mode nativa.
- **Tailwind CSS v4** — sistema di design ardesia/teal (OKLCH), tema scuro
  ad alto contrasto, ottimizzato per schermi e tablet.
- **@myriaddreamin/typst.ts** — compilatore Typst in WebAssembly, eseguito
  client-side (nessun server di compilazione).

## Avvio

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # build di produzione in dist/
```

## Chiavi API

Aprire **Impostazioni** (in alto a destra) e inserire:

| Chiave            | Uso                                              |
| ----------------- | ------------------------------------------------ |
| `NVIDIA_API_KEY`  | Estrazione OCR con il NIM Nemotron-Parse         |
| `GOOGLE_API_KEY`  | Conversione del testo in codice Typst con Gemini |

Le chiavi restano **solo nel `localStorage`** del browser; non vengono mai
inviate ad alcun server tranne le due API ufficiali, chiamate direttamente
dal client. Endpoint NVIDIA e modello Gemini sono personalizzabili in
_Opzioni avanzate_.

## Come funziona

1. **Caricamento** — Drag & drop di un'immagine (PNG/JPEG/WebP) o PDF.
2. **Estrazione** (`src/lib/nvidia.js` + `src/lib/pdf.js`) — Nemotron-Parse
   accetta **solo immagini**: se il file è un PDF, ogni pagina viene prima
   rasterizzata a ~250 DPI con pdf.js (`renderPdfToImages`), poi ogni pagina
   è inviata al NIM con il tool `markdown_no_bbox`. Il testo estratto arriva
   nei `tool_calls` della risposta (`arguments.text`) e viene concatenato
   pagina per pagina.
3. **Strutturazione** (`src/lib/gemini.js`) — Gemini riceve il testo grezzo e
   il system prompt tipografico e restituisce codice Typst con margini ampi,
   serif per il corpo, sans per i titoli e vere note a piè di pagina.
4. **Compilazione** (`src/lib/typst.js`) — il codice Typst viene compilato in
   PDF dal WASM locale. L'editor a sinistra è modificabile: **Genera PDF**
   ricompila, oppure si attiva l'**Anteprima live** (ricompila con debounce).

I font accademici (Libertinus Serif, New Computer Modern, DejaVu Sans/Mono)
sono **impacchettati localmente** in `src/assets/fonts`: il compilatore non
dipende da CDN esterne a runtime, quindi funziona anche offline e non
incappa in blocchi CORS/CSP.

## Struttura

```
src/
├─ App.jsx                  layout, orchestrazione, stato globale
├─ hooks/usePipeline.js     macchina a stati delle 3 fasi (OCR→Typst→PDF)
├─ lib/
│  ├─ nvidia.js             chiamata Nemotron-Parse + parsing risposta
│  ├─ gemini.js             chiamata Gemini + system prompt + unwrap del codice
│  ├─ typst.js              init compilatore WASM + compile PDF/SVG + font locali
│  ├─ files.js              validazione file, base64
│  └─ storage.js            persistenza chiavi/endpoint nel localStorage
└─ components/              Dropzone, SettingsModal, PipelineStepper,
                            TypstEditor, PdfPreview, Icons
```

## App Android (Capacitor)

Il progetto è impacchettabile come app Android nativa tramite Capacitor.

```bash
npm run build:android     # vite build + cap sync android
npx cap open android      # apre Android Studio
# oppure, da riga di comando:
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Requisiti: JDK 21, Android SDK (platform 36, build-tools 36). Impostare
`ANDROID_HOME` e creare `android/local.properties` con `sdk.dir=...`.

Caratteristiche native:

- **CORS risolto su mobile** — `CapacitorHttp` (abilitato in
  `capacitor.config.ts`) intercetta `fetch` e instrada le chiamate NVIDIA/
  Google via HTTP nativo, fuori dal webview: nessun blocco cross-origin.
- **Tasto/gesture Indietro** (`src/lib/native.js`) — chiude prima il modale,
  poi torna dal workspace al caricamento, infine esce dall'app.
- **Responsive** — su mobile/tablet stretto le due colonne (codice/anteprima)
  diventano schede a tutta altezza; safe-area per notch e barre di
  navigazione; status bar a tema scuro.
- **Icona e splash** — generate in `assets/` (sorgenti SVG in `assets/src/`)
  e installate in `android/app/src/main/res`.

## Note e limiti noti

- **CORS lato NVIDIA**: alcuni endpoint NIM non abilitano le richieste
  cross-origin dal browser. Se la chiamata viene bloccata, l'app mostra un
  errore esplicito; instradare la richiesta tramite un piccolo proxy
  server-side risolve il problema.
- **Contratto NIM**: il payload verso Nemotron-Parse segue lo schema
  OpenAI-compatibile (`messages` con `image_url`) usato dalla maggior parte
  dei NIM VLM. Se l'endpoint corrente adotta uno schema diverso, sono
  sufficienti piccole modifiche in `src/lib/nvidia.js` (il parser della
  risposta è già tollerante a più formati).
- Il compilatore Typst WASM (~28 MB, ~11 MB gzip) viene scaricato una volta e
  messo in cache dal browser.
