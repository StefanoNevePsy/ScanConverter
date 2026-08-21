# Pipeline locale (branch sperimentale)

Fa girare l'intera conversione sulla tua macchina: nessuna chiave API, nessun
limite di quota, nessuna pagina che esce da casa.

## L'idea

I due modelli fanno mestieri diversi, e da soli non bastano:

| | Cosa fa bene | Cosa non sa fare |
|---|---|---|
| **Nemotron OCR v2** (~84M parametri) | riconosce i glifi, velocissimo | non capisce la lingua: non può sapere che quella «e» è il verbo *essere* |
| **LLM locale** (es. `qwen3:8b`) | rimette accenti, parole troncate, virgolette | non legge le immagini |

Messi in fila coprono i rispettivi buchi: l'OCR estrae il testo in pochi
secondi, il modello linguistico lo rilegge. È la stessa divisione di ruoli che
l'app usa già in rete (Nemotron-Parse + Gemini), portata in locale.

Le correzioni proposte dal modello passano per **gli stessi guard
deterministici** già usati con Gemini: sottosequenza delle parole, dizionario
italiano/inglese, punteggiatura strutturale invariata. Il modello propone, il
dizionario dispone — anche in locale.

## Cosa serve

**Per l'LLM (la parte che conta di più):** solo [Ollama](https://ollama.com).
Gira nativo su Windows, macOS e Linux, e su una RTX 3080 10GB un modello da 8B
entra comodamente.

```bash
ollama pull qwen3:8b     # multilingue, consigliato per l'italiano
ollama serve             # espone http://localhost:11434
```

**Per l'OCR locale (facoltativo):** il sidecar di questa cartella, che richiede
GPU NVIDIA Ampere o successiva, CUDA e **Linux amd64** (su Windows: WSL2).

```bash
pip install -r requirements.txt
python server.py --host 127.0.0.1 --port 8000
```

## Configurazione nell'app

Impostazioni → scegli **Locale** nei motori che vuoi spostare. Compare la
sezione «Pipeline locale» con gli indirizzi, già precompilati con i default di
Ollama e del sidecar.

Le tre fasi sono indipendenti: puoi tenere l'OCR su Gemini (più accurato sulle
scansioni pessime) e spostare in locale solo la rilettura, che è la fase con
più chiamate e quindi la prima a incontrare i limiti di quota.

## Limiti da conoscere prima di adottarla

- **Nemotron OCR v2 non restituisce classi semantiche.** Dà riquadri e testo,
  non «questo è un titolo, questa è una tabella». Il sidecar deduce i titoli
  dall'altezza della riga: è un'euristica, non la gerarchia esatta che dà
  Nemotron-Parse. Documenti molto strutturati ci perdono.
- **Niente estrazione di figure.** Senza regioni di tipo `Picture` non c'è
  nulla da ritagliare: le immagini del documento vanno reinserite a mano.
- **L'italiano non è fra le lingue documentate** della variante multilingue
  (inglese, cinese, giapponese, coreano, russo), anche se i metadati del
  modello lo elencano. È la prima cosa da verificare su una pagina vera.

Per questo la pipeline locale vive su una branch separata: è una scelta di
velocità, costo e riservatezza, non di qualità.
