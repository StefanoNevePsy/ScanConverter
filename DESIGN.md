---
name: ScanConverter
description: Un banco editoriale operativo per trasformare scansioni in sorgenti Typst e pagine vettoriali verificabili.
colors:
  mineral-canvas: "#f0eee8"
  paper-surface: "#f8f6f0"
  paper-surface-muted: "#e7e4dc"
  paper-surface-deep: "#d9d5cb"
  rule: "#9a968c"
  rule-strong: "#4c4a45"
  graphite-ink: "#11110f"
  graphite-muted: "#4f4d47"
  graphite-faint: "#66635c"
  operational-violet: "#6858e8"
  operational-violet-strong: "#7c6cff"
  operational-violet-soft: "rgb(104 88 232 / 0.12)"
  inverse-ink: "#ffffff"
  local-lime: "#d7ff3f"
  local-lime-soft: "rgb(215 255 63 / 0.18)"
  annotation-lime: "#bfdc24"
  success: "#177653"
  warning: "#9b6500"
  danger: "#b32633"
  danger-soft: "rgb(179 38 51 / 0.11)"
typography:
  display:
    fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif"
    fontSize: "clamp(2.8rem, 7vw, 4.75rem)"
    fontWeight: 500
    lineHeight: 0.92
    letterSpacing: "-0.03em"
  wordmark:
    fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 0.9
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Manrope', 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "'Manrope', 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Manrope', 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.35
  button-label:
    fontFamily: "'Manrope', 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 700
  operational-control:
    fontFamily: "'Manrope', 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 600
  code:
    fontFamily: "ui-monospace, 'SF Mono', 'Menlo', 'Consolas', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "24px"
rounded:
  sharp: "0px"
  control: "8px"
  notice: "10px"
  surface: "12px"
  pill: "999px"
spacing:
  compact: "4px"
  control: "8px"
  cluster: "12px"
  inset: "16px"
  section: "18px"
components:
  button-local:
    backgroundColor: "{colors.local-lime}"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    height: "38px"
  button-local-hover:
    backgroundColor: "color-mix(in srgb, #d7ff3f 86%, white)"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    height: "38px"
  button-operational:
    backgroundColor: "{colors.operational-violet}"
    textColor: "{colors.inverse-ink}"
    typography: "{typography.operational-control}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  button-operational-hover:
    backgroundColor: "{colors.operational-violet-strong}"
    textColor: "{colors.inverse-ink}"
    typography: "{typography.operational-control}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    height: "38px"
  button-outline-hover:
    backgroundColor: "{colors.graphite-ink}"
    textColor: "{colors.mineral-canvas}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    height: "38px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-muted}"
    typography: "{typography.button-label}"
    rounded: "{rounded.sharp}"
    padding: "8px 13px"
    height: "38px"
  field-underline:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sharp}"
    padding: "6px 2px"
    height: "35px"
  card:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.surface}"
  toggle-off:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.pill}"
    height: "20px"
    width: "36px"
  toggle-on:
    backgroundColor: "{colors.local-lime}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.pill}"
    height: "20px"
    width: "36px"
  status-chip:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.graphite-muted}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  topbar-button:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.sharp}"
    padding: "7px 12px"
    height: "38px"
  panel-trigger:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.title}"
    rounded: "{rounded.sharp}"
    padding: "14px 16px"
---

# Design System: ScanConverter

## Overview

**Creative North Star: "Il Banco Editoriale"**

ScanConverter è un banco editoriale operativo: una superficie continua su cui un documento passa da scansione a testo, da testo a sorgente Typst e da sorgente a pagina verificabile. L’interfaccia deve sembrare un luogo di lavoro preciso e durevole, non una dashboard di riquadri intercambiabili.

Il riferimento a Soglia vive nella cura tipografica, nel contrasto asciutto, nelle superfici minerali e nelle micro-interazioni misurate. Qui quel linguaggio diventa più tecnico e leggibile: carta chiara o grafite, regole sottili, gerarchie nette e accenti rari che chiariscono il tipo di azione.

Il documento resta sempre il protagonista. Stato, importazione, ripresa, Atelier di impaginazione, editor e anteprima devono comporre un unico flusso di lavoro, con controlli densi ma mai compressi e con la differenza fra azioni locali e operative sempre percepibile.

**Key Characteristics:**

- Banco continuo, non mosaico di card.
- Carta minerale e grafite strutturate da regole da 1 px.
- Violetto per stato e azioni operative; lime per interventi locali e deterministici.
- Barlow Condensed per identità e grandi gerarchie; Manrope per il lavoro quotidiano.
- Editor, diagnostica e anteprima trattati come strumenti coordinati dello stesso documento.

## Colors

La palette alterna carta minerale e grafite con due accenti ad alta riconoscibilità e colori semantici riservati agli esiti.

### Primary

- **Violetto operativo:** segnala avanzamento, focus, stato attivo e azioni operative come ripresa o download; la variante forte appartiene all’hover.
- **Violetto operativo tenue:** sostiene messaggi o stati selezionati senza trasformarli in blocchi pieni.

### Secondary

- **Lime locale:** identifica le azioni deterministiche eseguite sul dispositivo, la selezione del testo e il marchio del prodotto.
- **Lime locale tenue:** porta attenzione a un’area o a un esito locale senza alterare la gerarchia principale.

### Tertiary

- **Verde esito, ambra avviso e rosso errore:** compaiono solo quando descrivono rispettivamente successo, configurazione incompleta o fallimento.
- **Lime annotazione:** distingue l’anteprima e i riferimenti alla pagina compilata dal violetto dell’editor.

### Neutral

- **Carta minerale:** tela dell’applicazione; la carta più chiara è riservata alle superfici di lavoro.
- **Carta intermedia e carta profonda:** separano footer, toolbar e controlli senza ricorrere a ombre.
- **Inchiostro grafite:** testo principale e regole forti; le due gradazioni attenuate sostengono metadati e note.
- **Tema scuro:** inverte carta e grafite mantenendo invariati i ruoli semantici, il lime locale e la separazione fra superfici.

**The Two Speeds Rule.** Il violetto comunica stato e azione operativa; il lime comunica un intervento locale e deterministico. Non scambiarne i ruoli.

**The Paper Before Panels Rule.** Prima di aggiungere un colore di riempimento, prova una regola sottile o un passaggio fra le superfici di carta già esistenti.

## Typography

**Display Font:** Barlow Condensed (con Arial Narrow come fallback)
**Body Font:** Manrope (con Segoe UI come fallback)
**Label/Mono Font:** stack monospace di sistema per sorgente, diagnostica e valori tecnici

**Character:** Barlow Condensed dà al prodotto una voce editoriale stretta e riconoscibile; Manrope mantiene leggibili controlli, stati e testi densi. Il monospace rende il sorgente Typst una materia direttamente ispezionabile.

### Hierarchy

- **Display** (500, da 44,8 px a 76 px, 0,92): titolo della landing, breve e con ampiezza massima di 16 caratteri.
- **Wordmark** (500, 24 px, 0,9): nome del prodotto nella barra superiore.
- **Title** (700, 14 px, 1,4): titoli di pannello e intestazioni operative.
- **Body** (400–600, 13–15 px, circa 1,5): descrizioni, metadati, comandi e messaggi di stato.
- **Label** (700, 10–11 px, 1,35): etichette dei campi, unità e riepiloghi compatti.
- **Code** (400, 13 px, 24 px): editor Typst e diagnostica tecnica.

**The Narrow Voice Rule.** Barlow Condensed appartiene al wordmark e alle gerarchie editoriali ampie; i controlli operativi restano in Manrope.

## Layout

L’app usa un contenitore centrale massimo di 1400 px con gutter progressivi di 16 px, 24 px e 32 px. La barra superiore resta sticky; sotto di essa, stato del file, Atelier, strumenti secondari, editor e anteprima seguono l’ordine reale del lavoro.

Nel workspace desktop, editor e PDF occupano due colonne uguali da 1024 px in su. L’Atelier aperto diventa una superficie a larghezza piena e dispone i campi in quattro colonne; il suo reticolo usa colonne elastiche con base minima di 155 px e gap orizzontale di 18 px. Le altezze di editor e anteprima sono limitate alla viewport e lo scorrimento resta interno.

Sotto 720 px, le sintesi accessorie scompaiono, i campi diventano una colonna, il footer dell’Atelier impila testo e azioni e i pulsanti principali occupano tutta la larghezza. Editor e anteprima diventano due schede alternative. Su dispositivi a puntatore grossolano, i target interattivi principali raggiungono almeno 44 px.

**The Continuous Bench Rule.** Le sezioni correlate condividono una superficie e sono separate da regole; non annidare card dentro card quando basta una divisione editoriale.

## Elevation & Depth

Il sistema è piatto per impostazione predefinita. Profondità e ordine emergono da superfici tonali, bordi da 1 px, dal lieve bagliore radiale della tela e dalla sfocatura della barra sticky. Le ombre restano eccezioni funzionali: pagina PDF, selezione di figure e modali possono staccarsi dal banco perché rappresentano un oggetto o un livello realmente sovrapposto.

### Shadow Vocabulary

- **Selezione lieve:** un’ombra corta accompagna la figura selezionata.
- **Pagina sollevata:** un’ombra media separa il foglio PDF bianco dalla superficie dell’anteprima.
- **Livello modale:** un’ombra profonda distingue le impostazioni dal documento sottostante.

**The Flat-by-Default Rule.** Card, Atelier, toolbar e pannelli restano senza ombra; una superficie si solleva solo quando il suo comportamento introduce un vero livello sopra il banco.

## Shapes

La forma è precisa ma non rigida. Le superfici principali hanno angoli dolci da 12 px; pulsanti e controlli usano 8 px; gli avvisi usano 10 px. Badge, stati e interruttori sono pillole complete, mentre i campi dell’Atelier restano rettilinei e si definiscono con una sola sottolineatura. Il marchio quadrato da 36 px, senza raggio, è la firma più netta del sistema.

**The Soft Instrument Rule.** Arrotonda l’oggetto interattivo, non ogni divisione interna: le regole e i campi lineari preservano il carattere di strumento.

## Components

### Buttons

- **Shape:** controlli compatti con angoli da 8 px e altezza minima di 38 px; su touch arrivano a 44 px.
- **Local:** fondo lime, inchiostro grafite e bordo scuro; identifica azioni come “Applica e compila”.
- **Operational:** fondo violetto e testo inverso; identifica ripresa, generazione o download quando sono l’azione operativa dominante.
- **Secondary:** fondo trasparente e bordo grafite; all’hover inverte in grafite piena e carta minerale.
- **Quiet:** nessun bordo, testo attenuato e sottolineatura distanziata; serve per reset e azioni subordinate.
- **Focus:** anello violetto da 3 px con offset da 3 px; non affidarsi al solo cambio di colore.

### Chips

- **Style:** pillole con bordo sottile, superficie di carta e label compatta; un punto colorato può portare lo stato.
- **State:** il colore comunica solo uno stato già nominato dal testo o dall’etichetta accessibile.

### Cards / Containers

- **Corner Style:** angoli dolci da 12 px.
- **Background:** carta chiara sul canvas minerale; footer e toolbar possono usare la carta intermedia.
- **Shadow Strategy:** nessuna ombra a riposo; usare la gerarchia tonale e le regole.
- **Border:** una sola regola neutra da 1 px, più forte soltanto dove separa regioni primarie.
- **Internal Padding:** ritmo compatto fra 12 px e 16 px.

### Inputs / Fields

- **Style:** nell’Atelier, fondo trasparente, nessun raggio e sottolineatura forte; altezza di 35 px e padding verticale compatto.
- **Focus:** la sottolineatura diventa violetta e riceve una seconda linea interna.
- **Error / Disabled:** gli errori usano rosso semantico e fondo rosso tenue; i controlli disabilitati riducono l’opacità e mantengono il cursore non disponibile.

### Navigation

- **Top bar:** una regola grafite separa la barra sticky dalla tela; marchio lime, wordmark compatto, tema e impostazioni restano sempre raggiungibili.
- **Workspace tabs:** sotto 1024 px, codice e PDF condividono un selettore segmentato; la scheda attiva usa la carta intermedia, non un nuovo colore d’accento.

### Atelier di impaginazione

È il componente firma: un pannello continuo che apre sezioni editoriali invece di esporre una griglia di card. Il marcatore a tre regole usa grafite, violetto e lime; le intestazioni mantengono titolo, sintesi e stato di apertura sulla stessa linea finché lo spazio lo consente. Il footer separa chiaramente rigenerazione con AI e applicazione locale.

### Notices and Pipeline State

Gli avvisi sono blocchi con bordo nel colore corrente e raggio da 10 px. La pipeline usa cerchi numerati o spuntati e testo esplicito; animazione e colore integrano lo stato, non lo sostituiscono.

**The Motion Has a Job Rule.** Le transizioni di stato durano 180–220 ms e possono sollevare un controllo di 1 px; shimmer e puntini sono riservati all’attesa, e `prefers-reduced-motion` li riduce quasi a zero.

## Do's and Don'ts

### Do:

- **Do** mantenere stato, ripresa, importazione, Atelier, editor e anteprima nello stesso percorso leggibile.
- **Do** usare regole da 1 px e passaggi fra superfici di carta per strutturare il banco.
- **Do** riservare il lime alle azioni locali e deterministiche e il violetto a stato e azioni operative.
- **Do** preservare focus visibile, target touch da 44 px e riduzione del movimento.
- **Do** lasciare che codice Typst e pagina compilata restino visibili o raggiungibili come due viste dello stesso documento.

### Don't:

- **Don't** trasformare il workspace in una dashboard di card indipendenti o annidate.
- **Don't** usare ombre per decorare superfici a riposo o per sostituire una gerarchia tonale chiara.
- **Don't** usare Barlow Condensed per campi, note, diagnostica o testo operativo denso.
- **Don't** affidare stato, errore o successo al solo colore.
- **Don't** introdurre metriche, testimonianze o promesse prestazionali che il prodotto non possiede.
