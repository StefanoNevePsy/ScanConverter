/*
  Pagine 21–25 del «Manuale SST» (capitolo 3), trascritte nella forma in cui
  le restituisce Nemotron-Parse: blocchi con tipo, riquadro e testo, compresi
  i suoi difetti tipici — pallini come formula LaTeX, testatina corrente
  classificata come titolo, apertura di capitolo spezzata in tre blocchi,
  numero di pagina nel cerchio. Serve da banco di prova per le regole fisse.
*/
const B = '\\(\\bullet\\)';
const box = (xmin, ymin, xmax, ymax) => ({ xmin, ymin, xmax, ymax });
const P = 'Si affrontano le aspettative dei partecipanti rispetto al gruppo SST e si fornisce una panoramica tra gli argomenti, focalizzandosi sulle abilità trattate.';

export const PAGES = [
  // p. 21 — apertura di capitolo
  [
    { type: 'Section-header', bbox: box(0.40, 0.11, 0.55, 0.13), text: 'CAPITOLO' },
    { type: 'Text', bbox: box(0.44, 0.15, 0.51, 0.19), text: '3' },
    { type: 'Title', bbox: box(0.29, 0.25, 0.65, 0.32), text: 'Dalla teoria alla pratica' },
    { type: 'Text', bbox: box(0.19, 0.34, 0.73, 0.37), text: 'R. Castaldo, S. Bari, G. Tocchi, R. Keller' },
    { type: 'Text', bbox: box(0.09, 0.46, 0.89, 0.48), text: 'Un percorso di SST segue una scaletta di programma definito, articolato in:' },
    { type: 'List-item', bbox: box(0.09, 0.48, 0.5, 0.50), text: '1. test iniziali (T0);' },
    { type: 'List-item', bbox: box(0.09, 0.50, 0.5, 0.52), text: '2. introduzione e aspettative;' },
    { type: 'List-item', bbox: box(0.09, 0.52, 0.5, 0.54), text: '3. saluto (2 incontri);' },
    { type: 'Text', bbox: box(0.09, 0.80, 0.89, 0.90), text: 'Il percorso proposto varia da un minimo di sei mesi a un massimo di dieci mesi, con possibilità di ampliare e ridefinire gli incontri dedicati alle diverse tematiche in base alle esigenze del gruppo, senza tuttavia ridurre il numero di incontri ne-' },
    { type: 'Page-footer', bbox: box(0.77, 0.94, 0.81, 0.96), text: '21' },
  ],
  // p. 22
  [
    { type: 'Section-header', bbox: box(0.30, 0.02, 0.70, 0.04), text: '3. DALLA TEORIA ALLA PRATICA' },
    { type: 'Text', bbox: box(0.10, 0.05, 0.90, 0.30), text: 'cessari per ciascuna abilità. Gli incontri dedicati ai test iniziali e conclusivi sono da considerarsi opzionali, ma importanti: si possono riunire i partecipanti insieme ed esaurire piuttosto in una sola occasione una batteria di test prestabilita.' },
    { type: 'Text', bbox: box(0.10, 0.31, 0.90, 0.50), text: 'Nelle prossime pagine saranno illustrate le singole abilita\' ponendo l\'accento sugli aspetti da approfondire. E\' importante che i membri del gruppo apportino il loro contributo alla crescita di questa pratica , fornendo esempi.' },
    { type: 'Section-header', bbox: box(0.10, 0.62, 0.72, 0.645), text: 'INCONTRO 1: INTRODUZIONE E ASPETTATIVE' },
    { type: 'Text', bbox: box(0.10, 0.65, 0.90, 0.75), text: P },
    { type: 'Section-header', bbox: box(0.10, 0.77, 0.30, 0.795), text: 'Mi presento' },
    { type: 'Text', bbox: box(0.10, 0.80, 0.90, 0.92), text: 'Chi sono io, le cose che mi piacciono, le mie qualità fisiche, altre mie qualità, i miei interessi speciali. È molto importante conoscere questi aspetti dei partecipanti.' },
    { type: 'Page-footer', bbox: box(0.04, 0.94, 0.08, 0.96), text: '22' },
  ],
  // p. 23
  [
    { type: 'Page-header', bbox: box(0.30, 0.04, 0.70, 0.06), text: '3. DALLA TEORIA ALLA PRATICA' },
    { type: 'Section-header', bbox: box(0.10, 0.14, 0.22, 0.165), text: 'Regole' },
    { type: 'Text', bbox: box(0.10, 0.17, 0.90, 0.23), text: 'Vengono esplicitate e scritte sulla lavagna in modo da essere chiare e ben visibili, ci si sofferma su ognuna, si verifica la comprensione da parte dei partecipanti e si condivide il significato.' },
    { type: 'List-item', bbox: box(0.10, 0.24, 0.90, 0.27), text: '1. Sospensione del giudizio: non si giudica quanto detto dai compagni.' },
    { type: 'List-item', bbox: box(0.10, 0.27, 0.90, 0.29), text: '2. Rispetto reciproco.' },
    { type: 'Section-header', bbox: box(0.10, 0.66, 0.78, 0.69), text: 'La voce del gruppo: aspettative iniziando il percorso' },
    { type: 'List-item', bbox: box(0.10, 0.69, 0.80, 0.71), text: `${B} "Vorrei essere più sicuro di me, imparare a dire no senza timore."` },
    { type: 'List-item', bbox: box(0.10, 0.71, 0.80, 0.73), text: `${B} "Vorrei sapermi allontanare da situazioni pericolose anziché attirarle."` },
    { type: 'List-item', bbox: box(0.10, 0.73, 0.80, 0.75), text: `${B} "Vorrei essere più disinvolto."` },
    { type: 'Page-footer', bbox: box(0.88, 0.94, 0.92, 0.96), text: '23' },
  ],
  // p. 24 — foto storta: tutto più grande del 15%
  [
    { type: 'Section-header', bbox: box(0.30, 0.03, 0.70, 0.05), text: '3. DALLA TEORIA ALLA PRATICA' },
    { type: 'Section-header', bbox: box(0.13, 0.09, 0.47, 0.118), text: 'Spunti per il conduttore' },
    { type: 'Text', bbox: box(0.13, 0.12, 0.92, 0.27), text: 'È importante porre ogni domanda a ogni singolo partecipante: come ti chiami? quanti anni hai? dove vivi? di cosa ti occupi? cosa ti appassiona e ti rende felice?' },
    { type: 'Section-header', bbox: box(0.13, 0.31, 0.62, 0.34), text: 'ABILITÀ 1: IL SALUTO' },
    { type: 'Section-header', bbox: box(0.13, 0.36, 0.42, 0.39), text: 'Definire l\'abilità' },
    { type: 'Text', bbox: box(0.13, 0.39, 0.92, 0.47), text: 'Il saluto può apparire come una abilità banale, ma spesso i partecipanti, pur valutando teoricamente l\'importanza di questa competenza, non tengono in considerazione quanto esso sia variabile.' },
    { type: 'Page-footer', bbox: box(0.12, 0.94, 0.17, 0.96), text: '24' },
  ],
  // p. 25
  [
    { type: 'Page-header', bbox: box(0.30, 0.04, 0.70, 0.06), text: '3. DALLA TEORIA ALLA PRATICA' },
    { type: 'Section-header', bbox: box(0.10, 0.18, 0.47, 0.205), text: 'Motivare all\'apprendimento' },
    { type: 'Text', bbox: box(0.10, 0.21, 0.70, 0.23), text: 'Alcune domande utili possono essere le seguenti:' },
    { type: 'List-item', bbox: box(0.10, 0.23, 0.60, 0.25), text: `${B} Perché è importante salutare?` },
    { type: 'List-item', bbox: box(0.10, 0.25, 0.60, 0.27), text: `${B} È facile o difficile? Difficile quando e perché?` },
    { type: 'Section-header', bbox: box(0.10, 0.47, 0.32, 0.495), text: 'La voce del gruppo' },
    { type: 'List-item', bbox: box(0.10, 0.50, 0.60, 0.52), text: `${B} "Mi costringo a farlo sempre, mi sforzo."` },
    { type: 'List-item', bbox: box(0.10, 0.52, 0.60, 0.54), text: `${B} "A volte balbetto."` },
    { type: 'Section-header', bbox: box(0.10, 0.80, 0.42, 0.825), text: 'Spunti per il conduttore' },
    { type: 'Text', bbox: box(0.10, 0.83, 0.90, 0.88), text: 'I cerchi dell\'intimità: disegnare i vari contesti per far comprendere quali sono le varie situazioni dalle più informali alle più professionali.' },
    { type: 'Page-footer', bbox: box(0.88, 0.94, 0.92, 0.96), text: '25' },
  ],
];
