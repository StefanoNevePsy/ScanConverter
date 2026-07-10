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
   è inviata al NIM. Il testo estratto arriva nei `tool_calls` della risposta
   e viene concatenato pagina per pagina.
   - **PDF scansionati**: le pagine sono immagini incorporate (JBIG2/JPEG2000).
     pdf.js le decodifica via WASM, quindi passiamo `wasmUrl` (binari in
     `public/pdfjs/`). Senza questa configurazione la pagina renderizza
     **bianca** e l'OCR restituisce “nessun testo”.
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

## Uso da PC — webapp su GitHub Pages

La GitHub Action `.github/workflows/deploy-pages.yml` pubblica la build statica
su **GitHub Pages** a ogni push sul branch di sviluppo: l'app diventa usabile da
qualsiasi browser (PC compreso) all'indirizzo

```
https://<utente>.github.io/<repo>/     # es. https://stefanonevepsy.github.io/ScanConverter/
```

**Attivazione (una tantum):** nelle impostazioni del repo → **Settings → Pages
→ Build and deployment → Source: “GitHub Actions”**. Da lì in poi ogni push
ripubblica automaticamente; l'URL finale compare nel log del job *Deploy* e
sotto Settings → Pages. Il `base` del sottopercorso è impostato dall'Action via
`VITE_BASE` (in locale e su Android resta la radice `/`).

**Cosa funziona da browser, senza altro:** l'editor Typst, la compilazione in
PDF (WASM locale), il download, il **controllo ortografico** (dizionari
impacchettati) e tutta la **fase Typst via Gemini** (formattazione, «Correggi
con AI», correzione refusi) — Google invia gli header CORS, quindi le chiamate
dal browser passano.

**Limite CORS di NVIDIA.** L'endpoint NVIDIA NIM **non** invia header CORS: da
una pagina statica il browser blocca le chiamate dirette, quindi **l'OCR
Nemotron-Parse, l'elenco modelli NVIDIA e i motori NVIDIA (Typst/GLM/DeepSeek)
non funzionano dalla webapp** così com'è. In dev il proxy del dev server risolve
il problema; nell'app Android lo risolve `CapacitorHttp`. Da PC hai due opzioni:

1. **Usa l'app Android** per l'OCR e la webapp per rifinire/compilare (le
   sessioni sono locali a ciascun dispositivo, non sincronizzate).
2. **Instrada NVIDIA attraverso un tuo piccolo proxy CORS** e imposta
   *Impostazioni → Opzioni avanzate → Endpoint NVIDIA NIM* a
   `https://<tuo-proxy>/https://integrate.api.nvidia.com/v1/chat/completions`
   (l'app deriva da sé l'URL `/v1/models`). Esempio di Cloudflare Worker
   gratuito, che inoltra il percorso e aggiunge gli header CORS:

   ```js
   export default {
     async fetch(req) {
       const target = new URL(req.url).pathname.slice(1) + new URL(req.url).search;
       const cors = {
         'access-control-allow-origin': req.headers.get('origin') || '*',
         'access-control-allow-methods': 'GET,POST,OPTIONS',
         'access-control-allow-headers':
           req.headers.get('access-control-request-headers') || 'authorization,content-type',
       };
       if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
       if (!target.startsWith('https://')) return new Response('bad target', { status: 400 });
       const r = await fetch(target, {
         method: req.method,
         headers: req.headers,
         body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
       });
       const h = new Headers(r.headers);
       for (const [k, v] of Object.entries(cors)) h.set(k, v);
       return new Response(r.body, { status: r.status, headers: h });
     },
   };
   ```

   La chiave NVIDIA transita solo dalla *tua* infrastruttura. Non usare proxy
   CORS pubblici di terzi: vedrebbero la chiave.

## Sessione a chunk, libri interi & rate limiting

Pensato per convertire **documenti lunghi o libri interi**, anche lentamente.
Il testo OCR viene diviso in **chunk** elaborati da Gemini uno alla volta
(`src/lib/session.js`):

- il **primo chunk** genera il preambolo Typst (`#set/#show`) + il corpo;
- i **chunk successivi** ricevono il preambolo (da non ripetere) e la
  **posizione gerarchica corrente** (lo stack dei titoli), e restituiscono solo
  il corpo, senza ripartire da “= 1”.

**Coerenza gerarchica deterministica** (non affidata solo all'LLM):

- `normalizeHeadingLevels` normalizza i livelli sull'**intero** documento (il
  titolo più esterno diventa sempre `=`), quindi la scala è coerente su tutte
  le pagine;
- `enforceHeadingLevels` **impone** all'output di Gemini i livelli del sorgente
  OCR (allineamento per ordine): la profondità dei titoli non può “andare alla
  deriva”, qualunque sia la lunghezza del documento.

**Auto-ripresa lenta sui rate limit**: se Gemini risponde 429/quota, l'app
**riprova da sola** con backoff esponenziale (15s → 30s → … fino a 2 min).
Così un libro si converte gradualmente senza intervento manuale.

**Persistenza su IndexedDB** (`src/lib/store.js`): dopo ogni chunk completato,
lo stato (testo, corpi Typst, preambolo, figure) viene salvato. IndexedDB
gestisce testo esteso e byte delle immagini, ben oltre i limiti di
localStorage, sia su web sia nella WebView Android. L'editor mostra il
documento che si costruisce progressivamente.

**Gestione sessioni**: la home elenca le **Sessioni salvate** — quelle in
sospeso si **riprendono**, quelle completate si **riaprono** (per rigenerare o
scaricare il PDF), e ognuna si può **eliminare**.

**Configurabile** (Impostazioni → Opzioni avanzate):

- **Max pagine PDF** per singolo caricamento (default 20, fino a 2000);
- **Dimensione chunk** in caratteri per richiesta a Gemini (default 5000):
  più piccola = più richieste ma più tolleranza ai rate limit.

## Tabelle, gerarchia, figure e testo OCR

- **Gerarchia preservata**: Nemotron-Parse restituisce i livelli di titolo
  (`##`, `###`, `####`) e Gemini li mappa fedelmente in Typst (`==`, `===`,
  `====`), senza appiattirli.
- **Tabelle**: Nemotron le restituisce in LaTeX (`\begin{tabular}`) e Gemini le
  converte in **tabelle Typst native** (`#table(...)`).
- **Corsivo e trascrizioni**: il corsivo (`_testo_`) è preservato; i paragrafi
  interamente in corsivo (trascrizioni/citazioni) diventano blocchi citazione
  leggermente più piccoli. La *dimensione* assoluta del testo non è riportata
  da Nemotron, quindi non è ricostruibile in modo affidabile.
- **Figure del documento originale**: in modalità `markdown_bbox` il modello
  classifica i blocchi (`Picture`, `Caption`, …) con bounding box. L'app
  **ritaglia** le regioni-immagine dalla pagina sorgente (`src/lib/figures.js`)
  e le **incorpora** nel PDF Typst via `map_shadow`
  (`#figure(image("/figures/fig-N.png"), caption: […])`).
- **Testo OCR per LLM esterni**: il pannello *“Testo OCR”* mostra il Markdown
  estratto e permette di copiarlo — o di copiare **prompt + testo** pronto per
  ChatGPT / Gemma in locale. Il Typst generato altrove si incolla nell'editor
  e si compila con **Genera PDF** (l'editor ha anche un tasto **Copia**).

## Rigenerare il layout (re-prompt Gemini)

Dopo la prima elaborazione, il pannello **“Rigenera layout con Gemini”**
permette di ottenere un'impaginazione diversa **senza rifare l'OCR** (nessun
costo/latenza NVIDIA): si scelgono preset rapidi (**font** tra 6 famiglie
impacchettate — Libertinus, New Computer Modern, PT Serif, PT Sans, DejaVu
Sans/Mono —, **formato pagina**, **margine** per annotazioni, **colonne**,
**allineamento**, **densità**, più extra come numeri di pagina, titoli
numerati, testatina) e/o si scrive un'istruzione libera (es. “titoli centrati
in maiuscoletto”). Viene ri-eseguita solo la fase 2 (Gemini con le indicazioni
di stile) + la fase 3 (compilazione).

In alternativa si può sempre modificare a mano il codice Typst nell'editor e
premere **Genera PDF**, oppure attivare l'**Anteprima live**.

## Modelli

- **OCR**: `nvidia/nemotron-parse` (Nemotron-Parse 1.1) è il modello di
  document-parsing consigliato di NVIDIA — 885M parametri, purpose-built per
  OCR/tabelle/layout, migliore dei VLM generici su documenti strutturati. È
  configurabile in *Impostazioni → Opzioni avanzate*.
- **Layout**: `gemini-flash-latest` (configurabile).

## Note e limiti noti

- **CORS lato NVIDIA (verificato)**: l'endpoint NIM `integrate.api.nvidia.com`
  **non** restituisce header CORS, quindi dal browser web la chiamata OCR è
  bloccata. Soluzioni, per piattaforma:
  - **Android**: nessun problema — `CapacitorHttp` usa HTTP nativo.
  - **Web in sviluppo**: il dev server di Vite fa da proxy (`/__nvidia__`),
    quindi `npm run dev` funziona senza configurazione.
  - **Web in produzione**: serve un reverse-proxy analogo davanti a
    `integrate.api.nvidia.com` (Gemini invece supporta il CORS e funziona
    diretto dal browser).
- **Contratto NIM (verificato con chiave reale)**: endpoint
  `https://integrate.api.nvidia.com/v1/chat/completions`, modello
  `nvidia/nemotron-parse`, tool `markdown_no_bbox`; il testo estratto arriva
  in `tool_calls[0].function.arguments`, che è un **array** JSON `[{text}]`.
  Il parser gestisce array, oggetto e i formati di fallback.
- Il compilatore Typst WASM (~28 MB, ~11 MB gzip) viene scaricato una volta e
  messo in cache dal browser.
