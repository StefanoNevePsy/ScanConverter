# ScanConverter

Digitalizzazione e re-impaginazione di documenti accademici e paper storici.
Da una **fotocopia scansionata** a un **PDF vettoriale pulito** con margini
ampi per le annotazioni — in quattro passi, di cui l'ultimo eseguito
interamente nel browser.

```
Immagine/PDF  →  [1/3] OCR (NVIDIA Nemotron-Parse)
              →  [2/3] Layout (Google Gemini → codice Typst)
              →  [3/3] Compilazione (Typst nativo/WASM, locale)  →  PDF vettoriale
```

## Stack

- **React 18 + Vite 6** — SPA condivisa tra web, Electron e Android.
- **Tailwind CSS v4** — interfaccia editoriale carta/grafite con tema chiaro e
  scuro, ottimizzata per desktop, tablet e mobile.
- **Typst 0.15.1 nativo + @myriaddreamin/typst.ts** — sulle app desktop il
  compilatore ufficiale gira in un processo isolato; web e Android usano il
  fallback WebAssembly. Nessun server di compilazione.

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
4. **Compilazione** (`src/lib/typst.js`) — il codice Typst viene compilato dal
   binario nativo nell'app Electron e dal WASM locale su web/Android. L'editor
   a sinistra è modificabile: **Genera PDF**
   ricompila, oppure si attiva l'**Anteprima live** (ricompila con debounce).
   L'anteprima apre il PDF con pdf.js e renderizza **una sola pagina canvas
   alla volta**. Sul desktop il PDF resta in un file temporaneo servito con
   richieste Range: anteprima e salvataggio non ne duplicano tutti i byte nel
   renderer. Sul web gli stessi byte compilati vengono riusati dal download.

I font accademici (Libertinus Serif, New Computer Modern, DejaVu Sans/Mono)
sono **impacchettati localmente** in `src/assets/fonts`: il compilatore non
dipende da CDN esterne a runtime, quindi funziona anche offline e non
incappa in blocchi CORS/CSP.

### Correzione degli errori Typst

Quando la prima compilazione fallisce, l'app avvia automaticamente il motore
locale in `src/lib/typstfix.js`. Il compilatore restituisce diagnostiche
strutturate con riga e colonna; il motore genera patch minime attorno a quella
posizione e conserva una modifica soltanto se una nuova compilazione dimostra
che l'errore è scomparso, si è spostato in avanti o il numero di errori è
diminuito. Il ciclo può attraversare fino a 64 errori consecutivi.

Il tasto **Correggi (locale)** ripete lo stesso processo senza usare API. Se
resta un errore non deterministico, **Correggi con AI** invia al modello solo
un estratto di circa 12.000 caratteri attorno alla diagnostica, non l'intero
libro. Le sostituzioni sono limitate a quell'estratto e vengono accettate solo
dopo la verifica del compilatore locale.

## Struttura

```
src/
├─ App.jsx                  layout, orchestrazione, stato globale
├─ hooks/usePipeline.js     macchina a stati delle 3 fasi (OCR→Typst→PDF)
├─ lib/
│  ├─ nvidia.js             chiamata Nemotron-Parse + parsing risposta
│  ├─ gemini.js             chiamata Gemini + system prompt + unwrap del codice
│  ├─ typst.js              selezione compilatore nativo/WASM + diagnostiche
│  ├─ desktop.js            bridge desktop, handle PDF e fallback trasparente
│  ├─ typstdiag.js          normalizzazione degli intervalli riga/colonna
│  ├─ typstfix.js           correzione deterministica compiler-guided
│  ├─ aifix.js              patch AI focalizzate e applicazione sicura
│  ├─ preamble.js           impaginazione Typst granulare e normalizzazione
│  ├─ projectArchive.js     import/export portabile .scanconverter
│  ├─ pdfPreview.js         ricerca e navigazione dell'anteprima paginata
│  ├─ files.js              validazione file, base64
│  └─ storage.js            persistenza chiavi/endpoint nel localStorage
└─ components/              Dropzone, SettingsModal, PipelineStepper,
                            TypstEditor, PdfPreview, Icons
electron/
├─ main.cjs                 finestra, IPC, protocollo PDF Range e salvataggio
├─ preload.cjs              API desktop minima esposta al renderer
├─ typst-engine.cjs         processo utility serializzato
└─ typst-runner.cjs         esecuzione del binario Typst e gestione figure
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
il problema; nell'app Android lo risolve `CapacitorHttp`. Da PC hai tre opzioni:

1. **Esegui l'app in locale** (`git clone` + `npm install` + `npm run dev`):
   il dev server include già il proxy verso NVIDIA, quindi **tutto funziona**,
   OCR compreso — è l'opzione zero-config per l'uso da PC.
2. **Usa l'app Android** per l'OCR e la webapp per rifinire/compilare (le
   sessioni sono locali a ciascun dispositivo, non sincronizzate).
3. **Instrada NVIDIA attraverso un tuo piccolo proxy CORS** e imposta
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

## App desktop (Mac & Windows) — con NVIDIA funzionante

A differenza della webapp su Pages, l'**app desktop** fa funzionare anche i
modelli NVIDIA (OCR compreso), senza proxy: il processo Electron inietta gli
header CORS mancanti sulle risposte remote — esattamente come `CapacitorHttp`
su Android — quindi le chiamate a NVIDIA non sono bloccate dal browser.
(Verificato: senza iniezione la fetch a NVIDIA fallisce per CORS, con
iniezione risponde `200`.)

La compilazione Typst desktop usa inoltre il binario ufficiale **0.15.1** in
un processo separato. Il sorgente e le figure attraversano un bridge IPC
ristretto; il PDF rimane nella cache temporanea nativa e viene letto a blocchi
dall'anteprima o copiato direttamente dal dialogo **Salva con nome**. Se il
binario non può partire, l'app ricade automaticamente sul backend WASM.

**Come ottenere gli installabili.** Il workflow
`.github/workflows/build-desktop.yml` compila per macOS e Windows. Avvialo da
**Actions → “Build app desktop (Mac + Windows)” → Run workflow** (oppure crea
un tag di versione: `git tag v0.1.0 && git push --tags`). Al termine, in fondo
al run, sotto **Artifacts**, trovi:

- **macOS** — `scanconverter-macos-latest` (`.dmg` e `.zip`)
- **Windows** — `scanconverter-windows-latest` (`.exe`: installer NSIS e portable)

**App non firmata** (nessun certificato di sviluppatore): al primo avvio il
sistema avvisa. Basta autorizzarla una volta:

- **macOS** — click destro sull'app → *Apri* → *Apri*; oppure *Impostazioni di
  Sistema → Privacy e sicurezza → Apri comunque*.
- **Windows** — *Windows ha protetto il PC* → *Ulteriori informazioni* →
  *Esegui comunque*.

**Esecuzione locale (sviluppo):**

```bash
npm run download:typst  # una volta: scarica il binario per OS/architettura
npm run build      # genera dist/
npm run electron   # avvia l'app desktop sulla build
# pacchetto per il tuo OS: npm run build:desktop (scarica Typst automaticamente)
```

Le chiavi API e le sessioni restano locali all'app, come sul web.

## Progetti portabili tra computer

Il pulsante **Esporta progetto** salva lo stato corrente in un archivio
`.scanconverter`: sessione, testo OCR, chunk Typst, opzioni di impaginazione,
figure e pagine ancora in attesa di OCR. Dalla home, **Importa progetto** crea
una nuova sessione locale e permette di continuare il lavoro su un altro PC o
Mac senza ricominciare la scansione.

L'archivio è un ZIP versionato e validato prima dell'importazione. Le chiavi
API, i token e gli altri segreti non vengono inclusi: vanno configurati sul
computer di destinazione. Gli archivi esportati sono ignorati da Git perché
possono essere molto grandi e contenere materiale riservato.

## Workflow di formattazione

### Atelier di impaginazione locale

Nel documento aperto, l'**Atelier di impaginazione** modifica e ricompila il
preambolo senza chiamare modelli online. I controlli coprono formato standard
o personalizzato, orientamento, colonne, rilegatura, margini predefiniti o
manuali sui quattro lati, font e corpo, peso, tracking, lingua, sillabazione,
allineamento, interlinea, spaziatura e rientri, gerarchia dei titoli, testatina,
numerazione pagina, figure, didascalie e note. Le scelte restano nello stato
della sessione e quindi viaggiano anche nel file `.scanconverter`.

Il campo di istruzioni creative e **Rigenera con AI** restano disponibili per
interventi strutturali; **Applica e compila** è invece deterministico e locale.

Nelle impostazioni sono disponibili due percorsi indipendenti:

- **Attuale**: il modello converte il testo OCR in Typst e il controllo a
  trigrammi individua eventuali passaggi omessi.
- **Fedeltà massima**: il testo OCR resta la fonte canonica e viene convertito
  in Typst da un renderer locale deterministico. Il modello scelto produce
  soltanto un piano editoriale vincolato (font, margini, densità e stile degli
  ID di blocco), senza restituire testo o codice. Le correzioni conservative
  sono registrate; dopo la compilazione il layer testuale del PDF viene
  riallineato parola per parola con la fonte e numeri, percentuali, DOI e URL
  sono verificati separatamente. Se il confronto fallisce, il PDF non viene
  considerato verificato.

Prima del rendering, la modalità ad alta fedeltà ripara inoltre le
**sovrapposizioni ai confini OCR**: se un blocco termina con le stesse parole
con cui il successivo riparte in minuscolo (per esempio `…cercando.` /
`cercando il punto…`), conserva una sola occorrenza, riunisce il paragrafo e
registra l'intervento nel report delle correzioni. Le ripetizioni tra paragrafi
autonomi restano invariate.

La seconda modalità può eseguire, opzionalmente, anche l'altro motore OCR sulla
stessa immagine. Il risultato alternativo non sostituisce il testo principale:
serve soltanto a segnalare le pagine discordanti da controllare. Questa opzione
richiede entrambe le chiavi API e raddoppia le chiamate della fase OCR.

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
- Il compilatore Typst WASM (~28 MB, ~11 MB gzip) viene scaricato e messo in
  cache soltanto da web/Android o quando il fallback desktop è necessario.
