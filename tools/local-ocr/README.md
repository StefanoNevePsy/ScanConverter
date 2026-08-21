# Pipeline locale — guida per Windows

Fa girare la conversione sulla tua macchina: nessuna chiave API, nessun limite
di quota, nessuna pagina che esce da casa.

Si installa **in due pezzi indipendenti**. Il primo dà quasi tutto il beneficio
in dieci minuti; il secondo è più impegnativo e va affrontato solo dopo aver
verificato che ti serva.

---

## La strada corta: lo script

Quello che segue nelle prossime sezioni è il lavoro fatto a mano, spiegato
passo per passo. Se vuoi solo che funzioni, lo stesso lavoro è in uno script
parametrico sulla cartella di destinazione:

```
cd tools\setup
.\Install-ScanConverter.ps1 -Root D:\ScanConverter
```

(su macOS e Linux: `./install-scanconverter.sh --root /Volumes/Esterno/SC`)

Crea le cartelle, installa Ollama dove dici tu, scarica il modello, prende il
compilatore Typst nativo e imposta le variabili d'ambiente perché tutto punti
lì. **Niente finisce su C:** se non glielo chiedi.

Il comando esatto, con il percorso già dentro, te lo scrive l'app:
Impostazioni → Pipeline locale → «Dove installare». Lì c'è anche il tasto che
verifica se i servizi rispondono davvero, che è l'unico modo di saperlo.

Lo script è **rieseguibile**: quello che c'è già lo salta. Se un disco esterno
cambia lettera — succede — rilancialo con quella nuova: non riscarica niente,
rimette solo a posto i percorsi.

Il resto di questa guida serve se vuoi capire cosa fa, o se preferisci farlo
a mano.

---

## Pezzo 1 — Il modello linguistico (comincia da qui)

Serve per la rilettura: accenti, parole troncate, refusi. È la fase con più
chiamate, quindi la prima a sbattere contro i limiti di quota — ed è quella che
sposta di più la qualità sull'italiano.

**Non serve WSL2, non serve Linux.** Ollama è un'applicazione Windows normale.

### Installazione

1. Scarica Ollama da **[ollama.com/download](https://ollama.com/download)** →
   *Download for Windows*. Installa con doppio clic.
2. Apri il **Prompt dei comandi** (tasto Windows → digita `cmd`) e scarica il
   modello:

   ```
   ollama pull qwen3:8b
   ```

   Sono circa 5 GB. Il download parte una volta sola.
3. Verifica che risponda:

   ```
   ollama list
   ```

**Dove finiscono i file:** in `C:\Users\<tuonome>\.ollama\models`.
Vedi sotto se hai poco spazio su C:.

**Come si usa:** non devi lanciare niente a mano. Ollama si avvia con Windows e
resta in ascolto su `http://localhost:11434`. Se l'app dice che non lo trova,
controlla l'icona nella barra delle applicazioni vicino all'orologio.

### Quale modello

| Modello | Comando | Spazio | Note |
|---|---|---|---|
| **`qwen3:8b`** | `ollama pull qwen3:8b` | ~5 GB | **Consigliato.** Copre 100+ lingue, la migliore resa sull'italiano fra i piccoli. |
| `mistral-small` | `ollama pull mistral-small` | ~13 GB | Addestrato esplicitamente anche su italiano. Al limite dei tuoi 10 GB. |
| `qwen3:4b` | `ollama pull qwen3:4b` | ~2,5 GB | Se vuoi lasciare libera la GPU per altro. Meno accurato. |

Sulla tua RTX 3080 da 10 GB, `qwen3:8b` entra comodamente e lascia margine.

### Configurazione nell'app

Impostazioni → **Motori per fase**. Ogni fase ha la sua riga, con il motore e
il modello: scegli **Locale** su «Rilettura e ortografia». L'elenco dei modelli
si popola da solo con quelli che hai scaricato — non devi ricordarne i tag.

Lascia pure l'OCR e il Typst su Gemini. **Questo è già il 90% del beneficio
pratico**, e non perdi né la struttura né le figure.

La stessa riga esiste per la **traduzione**, che è una fase a sé: produce un
secondo documento e non tocca l'originale. Anche quella può girare in locale,
ed è la fase in cui conviene di più — sono molte chiamate su molto testo.

### Se su C: hai poco spazio

Lo script in cima a questa guida fa già tutto quello che segue. Qui sotto c'è
cosa fa, se preferisci farlo a mano. In ogni caso va fatto **prima** di
scaricare i modelli — altrimenti li riscarichi.

**I modelli di Ollama** (la parte pesante, ~5 GB). Imposta una variabile
d'ambiente di sistema e riavvia Ollama:

```
setx OLLAMA_MODELS "D:\ollama\models"
```

Poi chiudi Ollama dalla barra delle applicazioni e riaprilo. Se avevi già
scaricato dei modelli, sposta a mano la cartella `.ollama\models` nella nuova
posizione: Ollama li ritrova.

**Il programma Ollama** (poche centinaia di MB). L'installer accetta una
destinazione:

```
OllamaSetup.exe /DIR="D:\Programmi\Ollama"
```

**La distribuzione WSL2** — serve solo per il Pezzo 2, e di default sta su C:.
Si sposta esportandola e reimportandola:

```
wsl --shutdown
wsl --export Ubuntu D:\wsl\ubuntu-backup.tar
wsl --unregister Ubuntu
wsl --import Ubuntu D:\wsl\Ubuntu D:\wsl\ubuntu-backup.tar
```

**Il modello OCR** dentro WSL (poche centinaia di MB). Nel terminale Ubuntu,
prima di avviare il sidecar:

```
export HF_HOME=/mnt/d/hf-cache
```

Aggiungi la stessa riga in fondo a `~/.bashrc` per non ridigitarla ogni volta.
`/mnt/d/` è come WSL vede il tuo disco D:.

**Riepilogo dello spazio:** Pezzo 1 circa 5,5 GB (Ollama + qwen3:8b); Pezzo 2
circa 3 GB per WSL2 e le librerie, più qualche centinaio di MB per il modello.

---

## Pezzo 2 — L'OCR locale (facoltativo, più impegnativo)

Serve solo se vuoi che *anche* la lettura delle immagini avvenga in casa.

**Qui WSL2 è obbligatorio**, perché la scheda del modello richiede Linux amd64
con CUDA. Non è un capriccio del nostro codice: è il requisito di NVIDIA.

### Installazione

1. **Installa Ubuntu in WSL2.** PowerShell *come amministratore*. Con
   `--location` anche il disco virtuale Linux (Python, CUDA e librerie) resta
   sul disco esterno:

   ```powershell
   wsl --update
   wsl --install -d Ubuntu --location 'D:\ScanConverter\wsl\Ubuntu'
   ```

   Riavvia quando richiesto e, al primo avvio di Ubuntu, crea nome utente e
   password Linux.
2. **Driver NVIDIA.** Sul lato Windows serve un driver recente
   ([nvidia.com/drivers](https://www.nvidia.com/drivers)). Dentro WSL **non**
   installare driver: li vede da Windows. Verifica dentro Ubuntu:

   ```
   nvidia-smi
   ```

   Se vedi la tua 3080, sei a posto.
3. **Compilatore CUDA 13.2.** Nemotron contiene un'estensione C++/CUDA da
   compilare. Dentro Ubuntu installa soltanto il compilatore WSL, mai un driver
   NVIDIA Linux. CUDA 13.2 evita inoltre l'incompatibilità fra gli header di
   CUDA 12.8 e la glibc recente inclusa in Ubuntu 26.04. Il pacchetto minimale
   evita circa 6 GB di profiler, GUI e librerie duplicate che il sidecar non usa:

   ```bash
   sudo apt update
   sudo apt install -y curl wget git git-lfs build-essential gcc-13 g++-13
   wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
   sudo dpkg -i cuda-keyring_1.1-1_all.deb
   sudo apt update
   sudo apt install -y --no-install-recommends cuda-compiler-13-2
   export CUDA_HOME=/usr/local/cuda-13.2
   export PATH="$CUDA_HOME/bin:$PATH"
   export CC=/usr/bin/gcc-13
   export CXX=/usr/bin/g++-13
   ```

4. **Codice, ambiente Python 3.12 e modello.** Ubuntu 26.04 include Python
   3.14, ma Nemotron accetta esclusivamente `>=3.12,<3.13`. `uv` installa un
   3.12 isolato senza sostituire il Python di sistema. Sempre dentro Ubuntu;
   cambia
   `/mnt/d/ScanConverter` se hai scelto un'altra unità o cartella:

   ```bash
   export SC_ROOT=/mnt/d/ScanConverter
   export SC_VENV="$HOME/.venvs/scanconverter-ocr"
   mkdir -p "$SC_ROOT/sidecar"
   mkdir -p "$(dirname "$SC_VENV")"
   export HF_HOME="$SC_ROOT/hf-cache"

   git clone --branch claude/pipeline-locale --single-branch \
     https://github.com/StefanoNevePsy/ScanConverter.git \
     "$SC_ROOT/sidecar/ScanConverter"

   git lfs install
   git clone https://huggingface.co/nvidia/nemotron-ocr-v2 \
     "$SC_ROOT/sidecar/nemotron-ocr-v2"

   curl -LsSf https://astral.sh/uv/install.sh | sh
   "$HOME/.local/bin/uv" python install 3.12
   "$HOME/.local/bin/uv" venv --python 3.12 --seed "$SC_VENV"
   source "$SC_VENV/bin/activate"
   python --version
   pip list --format=freeze | awk -F== '/^nvidia-.*-cu12==/ {print $1}' \
     | xargs -r pip uninstall -y
   pip uninstall -y torch torchvision cuda-toolkit cuda-bindings triton
   pip install torch==2.12.1 torchvision==0.27.1 \
     --index-url https://download.pytorch.org/whl/cu132
   nvcc --version
   python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
   pip install hatchling editables setuptools ninja
   export TORCH_CUDA_ARCH_LIST="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1)"
   export MAX_JOBS=4
   export OCR_BUILD_ROOT="$(mktemp -d)"
   cp -a "$SC_ROOT/sidecar/nemotron-ocr-v2/nemotron-ocr" "$OCR_BUILD_ROOT/"
   pip install --no-build-isolation -v "$OCR_BUILD_ROOT/nemotron-ocr"
   python -c "from nemotron_ocr.inference.pipeline_v2 import NemotronOCRV2; print('OK')"
   pip install -r "$SC_ROOT/sidecar/ScanConverter/tools/local-ocr/requirements.txt"
   rm -rf "$OCR_BUILD_ROOT"
   pip cache purge
   sudo apt clean

   export NEMOTRON_OCR_MODEL_ROOT="$SC_ROOT/sidecar/nemotron-ocr-v2"
   cd "$SC_ROOT/sidecar/ScanConverter/tools/local-ocr"
   python server.py
   ```

   Il virtualenv deve stare nel filesystem Linux, non sotto `/mnt/d` o
   `/mnt/f`: i volumi Windows possono rifiutare i symlink usati da Python.
   Se la distribuzione Ubuntu è stata installata con `wsl --location` sul
   disco esterno, anche la home Linux e questo virtualenv sono fisicamente su
   quel disco.

   Le esportazioni di `HF_HOME`, `CUDA_HOME`, `PATH` e
   `NEMOTRON_OCR_MODEL_ROOT` possono essere aggiunte a `~/.bashrc` per gli
   avvii successivi. Il clone Git LFS scarica i pesi una volta sola.

5. Nell'app: Impostazioni → **Motori per fase** → riga «Lettura (OCR)» → **Locale**.

### Verifica

Con il sidecar avviato, da Windows apri `http://localhost:8000/health` nel
browser: deve rispondere `{"status": "ok", …}`. WSL2 inoltra le porte a Windows
automaticamente.

---

## Il contesto del documento

Impostazioni → **Contesto del documento**. Una frase su cosa stai
digitalizzando, per esempio:

> Libro di psicoterapia sistemica (scuola di Milano): cibernetica di secondo
> ordine, parentificazione, doppio legame, ipotizzazione.

Non è un dettaglio estetico. Senza, lo spellchecker segnala «parentificazione»
come parola sconosciuta e la manda al modello, che può "correggerla" in
qualcosa di più comune. Dichiarare il dominio la rende **attesa**, e vale per
tutte le fasi: ortografia, rilettura, conversione in Typst e traduzione — dove
serve anche a scegliere il traducente giusto per un termine tecnico.

Vale la pena aggiornarlo quando cambi argomento, ma se la tua biblioteca è
tutta della stessa area lo scrivi una volta sola.

---

## La traduzione

È una fase **separata**, non un passaggio della pipeline, e la ragione è
strutturale: ogni verifica di questo progetto — inventario dei token,
sottosequenza, guardia sulle tabelle — esiste per impedire che il testo cambi.
Una traduzione cambia ogni parola. Farla passare di lì vorrebbe dire spegnere
proprio le difese che rendono affidabile il resto.

Quindi la traduzione produce un **secondo documento**, che percorre poi la
stessa strutturazione dell'originale. Nell'elenco li trovi entrambi, e
l'originale non viene toccato.

Si avvia dal workspace: pannello **Traduci**, sotto l'editor.

### Come viene tagliato il testo

Qui si decide quasi tutta la qualità, molto più che nella scelta del modello.

- **Nessuna frase spezzata a metà.** Un modello che riceve «…e per questo
  motivo la famiglia» non ha modo di sapere come finisce, e completa a caso.
  I tagli cadono fra blocchi; dentro un blocco troppo grande, fra frasi. Le
  abbreviazioni sono riconosciute, così «cfr. Bateson» e «p. 42» non diventano
  due frasi.
- **Contesto prima e dopo.** Ogni passaggio porta con sé qualche frase
  precedente e seguente, dichiarate come contesto da leggere e *non* da
  tradurre. Senza, all'inizio di ogni pezzo i pronomi non hanno antecedente
  («questo approccio» — quale?) e i termini ricorrenti cambiano resa a ogni
  pezzo. Quante frasi lo decidi in Impostazioni → Opzioni avanzate →
  «Contesto della traduzione» (default 2).
- **Struttura verificata, non sperata.** I blocchi viaggiano etichettati e la
  risposta viene ricontrollata: se ne manca uno, quel blocco viene ritradotto
  da solo. Se proprio non torna, resta in lingua originale e te lo dice — non
  sparisce in silenzio. I percorsi delle figure vengono ripristinati se il
  modello li ha "tradotti".

Il **contesto del documento** (sotto) vale anche qui, e serve a scegliere il
traducente giusto: senza, «ipotizzazione» diventa quello che capita.

---

## Struttura, figure e tabelle in locale

Nemotron OCR v2 restituisce solo riquadri e testo: non dice cosa è un titolo,
dove sta una figura, quali righe formano una tabella. Quelle informazioni però
**non sono perse** — stanno nella geometria della pagina, e `layout.py` le
ricostruisce senza alcun modello:

- **Titoli** — per *rango* delle altezze di riga, non per soglia fissa: si
  raggruppano le righe di altezza simile, il gruppo più numeroso è il corpo del
  testo, e i gruppi più alti diventano livello 1, 2, 3. Un libro in corpo 9 e
  uno in corpo 14 danno la stessa gerarchia senza tarare nulla. È lo stesso
  principio che l'app già usa per i PDF con testo digitale.
- **Figure** — l'inchiostro che *non* appartiene a nessuna riga di testo.
  Cancellando dalla pagina i riquadri dell'OCR, ciò che resta è illustrazione.
- **Tabelle** — due criteri complementari: i *righelli* (corse continue di
  pixel scuri, sottili) per le tabelle bordate, e l'*allineamento delle
  colonne* fra righe consecutive per quelle senza bordi.

Poiché l'app esiste per le fotocopie mal fatte, due accorgimenti sono
essenziali e sono dentro:

- **Raddrizzamento automatico.** Una pagina appoggiata storta sul vetro rende i
  righelli non più orizzontali, e la tabella sparisce. L'inclinazione viene
  stimata col profilo di proiezione (si prova una decina di piccole rotazioni e
  si tiene quella che rende più netti gli stacchi fra riga e interlinea),
  l'analisi gira sulla pagina raddrizzata e i riquadri tornano nello spazio
  originale, che è quello da cui l'app ritaglia.
- **Soglia locale invece che globale.** Con una soglia fissa, una macchia di
  caffè o la lampada che illumina un lato più dell'altro rendono "inchiostro"
  un'intera zona, che diventa una figura fantasma. Confrontando ogni pixel con
  la media dei suoi vicini conta solo il contrasto locale: le ombre morbide
  spariscono, i glifi restano.

### Quanto regge davvero

`python test_degraded.py` prende la stessa pagina e la rovina in modi
realistici — inclinata, con granelli di fotocopia, con luce disomogenea, con
una macchia, col bordo nero del coperchio aperto, sbiadita — una degradazione
per volta e poi tutte insieme, con anche i riquadri OCR spostati di qualche
pixel come succede nella realtà.

| Pagina | Esito |
|---|---|
| pulita, inclinata 1° e 3°, rumore, luce disomogenea, macchia, bordo nero, sbiadita | tutto riconosciuto |
| **tutti i difetti insieme** | titolo, prosa e tabella corretti; la figura vera trovata, più qualche candidata in eccesso |

Nel caso peggiore quindi non si rompe: produce *candidate in più*, che finiscono
nella revisione figure dove si tolgono con un clic. È un cedimento visibile e
correggibile, non silenzioso.

**Resta comunque un'approssimazione.** La gerarchia dedotta dalla tipografia è
buona ma non è la classificazione semantica di Nemotron-Parse: su documenti
molto strutturati (indici, apparati, note fitte) il modello in rete resta
superiore. Per questo la pipeline locale vive su una branch separata: è una
scelta di velocità, costo e riservatezza — non di qualità assoluta.

---

## L'incognita che decide tutto

**L'italiano non è fra le lingue documentate** della variante multilingue
(inglese, cinese, giapponese, coreano, russo), anche se i metadati del modello
lo elencano fra le lingue supportate. La scheda si contraddice.

Prima di investire tempo nel Pezzo 2, dagli in pasto **una sola pagina** della
scansione difficile e guarda se «è», «più», «perché» escono corretti. Se sì, la
strada è aperta. Se no, tieni l'OCR su Gemini e usa il locale solo per la
rilettura — che è comunque il pezzo che ti fa risparmiare di più.
