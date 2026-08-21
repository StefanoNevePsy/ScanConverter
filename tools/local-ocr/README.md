# Pipeline locale — guida per Windows

Fa girare la conversione sulla tua macchina: nessuna chiave API, nessun limite
di quota, nessuna pagina che esce da casa.

Si installa **in due pezzi indipendenti**. Il primo dà quasi tutto il beneficio
in dieci minuti; il secondo è più impegnativo e va affrontato solo dopo aver
verificato che ti serva.

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

**Dove finiscono i file:** in `C:\Users\<tuonome>\.ollama\models`. Non devi
spostarli né saperlo: Ollama li gestisce da sé. Se vuoi metterli su un altro
disco, imposta la variabile d'ambiente `OLLAMA_MODELS` sul percorso che
preferisci.

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

Impostazioni → nella sezione **Correzioni AI** scegli **Modello locale**.
Compare la sezione «Pipeline locale» con i campi già compilati
(`http://localhost:11434/v1/chat/completions` e `qwen3:8b`): se non hai
cambiato nulla in Ollama, vanno bene così.

Lascia pure l'OCR su Gemini e il Typst su Gemini. **Questo è già il 90% del
beneficio pratico**, e non perdi né la struttura né le figure.

---

## Pezzo 2 — L'OCR locale (facoltativo, più impegnativo)

Serve solo se vuoi che *anche* la lettura delle immagini avvenga in casa.

**Qui WSL2 è obbligatorio**, perché la scheda del modello richiede Linux amd64
con CUDA. Non è un capriccio del nostro codice: è il requisito di NVIDIA.

### Installazione

1. **Attiva WSL2.** Prompt dei comandi *come amministratore*:

   ```
   wsl --install
   ```

   Riavvia quando te lo chiede. Ti verrà creato un Ubuntu.
2. **Driver NVIDIA.** Sul lato Windows serve un driver recente
   ([nvidia.com/drivers](https://www.nvidia.com/drivers)). Dentro WSL **non**
   installare driver: li vede da Windows. Verifica dentro Ubuntu:

   ```
   nvidia-smi
   ```

   Se vedi la tua 3080, sei a posto.
3. **Il sidecar.** Sempre dentro Ubuntu:

   ```
   git clone https://github.com/StefanoNevePsy/ScanConverter.git
   cd ScanConverter/tools/local-ocr
   pip install torch --index-url https://download.pytorch.org/whl/cu124
   pip install -r requirements.txt
   python server.py
   ```

   Il modello (poche centinaia di MB) si scarica al primo avvio in
   `~/.cache/huggingface`.

4. Nell'app: Impostazioni → **Motore OCR** → **Locale (sidecar)**.

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
tutte e tre le fasi: ortografia, rilettura e conversione in Typst.

Vale la pena aggiornarlo quando cambi argomento, ma se la tua biblioteca è
tutta della stessa area lo scrivi una volta sola.

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

Tutto deterministico e ispezionabile. La suite (`python test_layout.py`, 23
controlli) verifica anche i casi in cui non deve scattare nulla: pagine di sola
prosa che non devono produrre titoli inventati, rumore di scansione che non
deve diventare una figura, paragrafi a piena larghezza che non sono tabelle.

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
