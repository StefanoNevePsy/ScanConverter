# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

ScanConverter è pensato per chi digitalizza scansioni difficili, dispense e libri interi e deve poter correggere, verificare e riprendere il lavoro anche in sessioni molto lunghe. Il progetto viene distribuito come web app e tramite wrapper desktop e Android.

## Product Purpose

Trasformare immagini e PDF scansionati, anche degradati, in documenti Typst puliti e in PDF vettoriali. Il risultato intermedio deve restare modificabile, compilabile e trasferibile; il PDF è una delle uscite, non l’unica fonte di verità.

## Positioning

Il prodotto combina OCR, ricostruzione del layout assistita da modelli e un percorso locale deterministico per compilazione, diagnosi e correzione Typst. L’editor Typst rimane la fonte di verità controllabile dall’utente.

## Operating Context

- I documenti possono contenere centinaia di pagine e figure e richiedere ore di elaborazione.
- Le sessioni vengono salvate localmente e devono poter essere interrotte, riaperte e trasferite fra computer.
- L’utente confronta spesso codice Typst, diagnostiche e anteprima PDF nello stesso spazio di lavoro.
- Le chiavi API sono impostazioni del dispositivo e non fanno parte del documento esportato.

## Capabilities and Constraints

- OCR tramite NVIDIA o Gemini e formattazione Typst tramite modelli configurabili.
- Compilazione Typst locale nativa su desktop, con fallback WASM sul web e nei wrapper compatibili.
- Persistenza locale in IndexedDB di sessioni, parti OCR, pagine ancora da elaborare e figure.
- Correzione degli errori di compilazione Typst sia deterministica sia assistita da modelli.
- Il formato di progetto portatile deve essere versionato e non includere credenziali.
- L’interfaccia deve restare reattiva con libri interi; anteprima, importazione ed esportazione non devono materializzare più dati del necessario quando è evitabile.

## Brand Commitments

Il nome è ScanConverter. La revisione dell’interfaccia prende Soglia, presente nello stesso workspace locale, come riferimento dichiarato per il livello di cura, la tipografia, il contrasto, le superfici e le micro-interazioni, senza confondere il carattere operativo di ScanConverter con quello contemplativo di Soglia.

## Evidence on Hand

- Implementazione corrente in `src/`.
- Motore desktop in `electron/` e wrapper Android in `android/`.
- Test automatici in `tests/`.
- Riferimento Soglia in `C:/Users/neves/Documents/ChatGPT/Easy DMN`.
- Nessuna testimonianza, metrica commerciale o promessa prestazionale da introdurre nell’interfaccia.

## Product Principles

1. Il documento resta dell’utente: stato locale, sorgente modificabile ed esportazione portatile.
2. I libri lunghi sono il caso reale, non un’eccezione da gestire dopo.
3. Le azioni deterministiche e locali devono essere distinguibili dalle chiamate ai modelli.
4. Stato, errori e possibilità di ripresa devono essere sempre comprensibili.
5. La cura grafica deve aumentare orientamento e leggibilità, mai nascondere il lavoro tecnico.

## Accessibility & Inclusion

L’interfaccia deve mantenere navigazione da tastiera, focus visibile, contrasto adeguato, target tattili utilizzabili e rispetto di `prefers-reduced-motion` su desktop e mobile.
