"""
Analisi del layout a partire dalle sole regioni di testo.

Nemotron OCR v2 dice DOVE c'è testo e COSA c'è scritto, ma non dice se una
riga è un titolo, dove sta una figura o quali righe formano una tabella. Quelle
informazioni però non sono perse: stanno nella geometria della pagina, e si
recuperano con analisi d'immagine classica — deterministica, ispezionabile e
senza modelli. È lo stesso principio con cui l'app già assegna i livelli di
titolo ai PDF con testo digitale (rango delle dimensioni, non soglie fisse).

Tre funzioni, indipendenti fra loro:

  heading_levels  righe più alte del corpo → livelli di titolo, per RANGO
  find_figures    inchiostro fuori dalle regioni di testo → figure da ritagliare
  find_tables     righelli di tabella e colonne allineate → regioni tabella

Nessuna richiede la GPU: girano sulla pagina già rasterizzata.
"""

from __future__ import annotations

import numpy as np

# ------------------------------------------------------------------ titoli

# Una riga di titolo è più alta del corpo, ma «più alta» va misurato in modo
# relativo: cambia con la risoluzione di scansione. Il 12% separa bene una
# variazione di font da una fluttuazione di rilevamento.
_SAME_SIZE_TOLERANCE = 0.12
_MAX_HEADING_WORDS = 14


def heading_levels(regions, max_levels: int = 3) -> list[str]:
    """
    Assegna a ogni regione un tipo: 'Title', 'Section-header', … o 'Text'.

    Per RANGO, non per soglia: si raggruppano le altezze simili, si prende come
    corpo del testo il gruppo più frequente (non il più grande: una pagina è
    fatta soprattutto di prosa) e i gruppi più alti diventano livelli 1, 2, 3
    nell'ordine. Così un libro stampato in corpo 9 e uno in corpo 14 danno la
    stessa gerarchia, senza tarare nulla a mano.

    @param regions: sequenza di dict con 'bbox' (x0,y0,x1,y1) e 'text'
    @returns: lista di tipi, nello stesso ordine delle regioni
    """
    heights = [float(r["bbox"][3] - r["bbox"][1]) for r in regions]
    if not heights:
        return []

    clusters = _cluster_sizes(heights)
    if not clusters:
        return ["Text"] * len(regions)

    # Il corpo del testo è il gruppo con più righe; a parità, il più piccolo.
    body = max(clusters, key=lambda c: (len(c["members"]), -c["size"]))
    larger = sorted(
        [c for c in clusters if c["size"] > body["size"] * (1 + _SAME_SIZE_TOLERANCE)],
        key=lambda c: -c["size"],
    )
    level_of = {id(c): i + 1 for i, c in enumerate(larger[:max_levels])}

    names = {1: "Title", 2: "Section-header", 3: "Subsection-header"}
    types: list[str] = []
    for index, region in enumerate(regions):
        cluster = next(c for c in clusters if index in c["members"])
        level = level_of.get(id(cluster))
        # Un paragrafo lungo non è un titolo nemmeno se stampato grande:
        # capita con le iniziali decorate e con l'OCR che fonde due righe.
        if level and _looks_like_heading(region.get("text", "")):
            types.append(names.get(level, "Subsection-header"))
        else:
            types.append("Text")
    return types


def _cluster_sizes(heights: list[float]) -> list[dict]:
    """Raggruppa le altezze simili (entro la tolleranza) in gruppi ordinati."""
    order = sorted(range(len(heights)), key=lambda i: heights[i])
    clusters: list[dict] = []
    for i in order:
        h = heights[i]
        if clusters and h <= clusters[-1]["size"] * (1 + _SAME_SIZE_TOLERANCE):
            c = clusters[-1]
            c["members"].add(i)
            # La dimensione del gruppo è la mediana: un singolo rilevamento
            # storto non sposta il riferimento.
            c["sizes"].append(h)
            c["size"] = float(np.median(c["sizes"]))
        else:
            clusters.append({"size": h, "sizes": [h], "members": {i}})
    return clusters


def _looks_like_heading(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if len(t.split()) > _MAX_HEADING_WORDS:
        return False
    # I titoli non finiscono col punto (ma possono finire con ? o !).
    return not t.endswith((".", ";", ","))


# ------------------------------------------------------------------ figure


def _ink_mask(gray: np.ndarray, threshold: int = 200) -> np.ndarray:
    """True dove la pagina è scura: l'inchiostro, testo o disegno che sia."""
    return gray < threshold


def find_figures(
    gray: np.ndarray,
    text_boxes,
    cell: int = 16,
    min_area_ratio: float = 0.004,
    pad: int = 2,
) -> list[tuple[int, int, int, int]]:
    """
    Trova le regioni illustrate: l'inchiostro che NON appartiene al testo.

    L'OCR ci dà i riquadri di tutte le righe: cancellandoli dalla maschera
    d'inchiostro resta ciò che testo non è — figure, diagrammi, timbri. Si
    lavora su una griglia grossolana (celle da `cell` px) perché per ritagliare
    una figura basta la precisione di qualche pixel, e così l'etichettatura
    delle componenti resta veloce anche su pagine da 2600px.

    @returns: riquadri (x0, y0, x1, y1) in pixel, dal più grande
    """
    h, w = gray.shape
    mask = _ink_mask(gray)

    # Via il testo, con un margine: i riquadri OCR sono spesso stretti.
    for x0, y0, x1, y1 in text_boxes:
        xa, ya = max(0, int(x0) - pad), max(0, int(y0) - pad)
        xb, yb = min(w, int(x1) + pad), min(h, int(y1) + pad)
        if xb > xa and yb > ya:
            mask[ya:yb, xa:xb] = False

    rows, cols = h // cell, w // cell
    if rows == 0 or cols == 0:
        return []
    # Densità d'inchiostro per cella: una cella conta se è sporca davvero,
    # così il rumore di scansione (granelli isolati) non genera figure.
    trimmed = mask[: rows * cell, : cols * cell]
    density = trimmed.reshape(rows, cell, cols, cell).mean(axis=(1, 3))
    grid = density > 0.06

    boxes = []
    page_area = float(rows * cols)
    for component in _components(grid):
        ys = [c[0] for c in component]
        xs = [c[1] for c in component]
        if len(component) / page_area < min_area_ratio:
            continue
        boxes.append(
            (
                int(min(xs) * cell),
                int(min(ys) * cell),
                int((max(xs) + 1) * cell),
                int((max(ys) + 1) * cell),
            )
        )
    boxes.sort(key=lambda b: -((b[2] - b[0]) * (b[3] - b[1])))
    return boxes


def _components(grid: np.ndarray) -> list[list[tuple[int, int]]]:
    """Componenti connesse (4-vicinato) sulla griglia booleana, senza scipy."""
    seen = np.zeros_like(grid, dtype=bool)
    rows, cols = grid.shape
    out: list[list[tuple[int, int]]] = []
    for r in range(rows):
        for c in range(cols):
            if not grid[r, c] or seen[r, c]:
                continue
            stack = [(r, c)]
            seen[r, c] = True
            component = []
            while stack:
                y, x = stack.pop()
                component.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < rows and 0 <= nx < cols and grid[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            out.append(component)
    return out


# ----------------------------------------------------------------- tabelle


def find_ruling_lines(gray: np.ndarray, min_ratio: float = 0.3, band=None) -> dict:
    """
    Righelli di tabella: corse di pixel scuri lunghe almeno `min_ratio` della
    dimensione di riferimento. È il segnale più affidabile per una tabella
    bordata, e non richiede alcun modello.

    I righelli VERTICALI vanno cercati dentro la fascia della tabella, non su
    tutta la pagina: separano le colonne e quindi sono alti quanto la tabella,
    che è una frazione del foglio. Misurarli sull'altezza intera li scarterebbe
    sempre. `band` limita la ricerca a (y0, y1).

    @returns: {'horizontal': [y, …], 'vertical': [x, …]}
    """
    mask = _ink_mask(gray)
    h, w = mask.shape
    # Conta la corsa CONTINUA più lunga, non il totale dei pixel scuri: una
    # riga di testo fitto può annerire metà riga, ma a tratti — fra una lettera
    # e l'altra ci sono buchi. Un righello invece è ininterrotto. Sommando si
    # scambiano i paragrafi per tabelle; misurando la continuità no.
    horizontal = [
        int(y) for y in range(h) if _longest_run(mask[y]) >= w * min_ratio
    ]

    y0, y1 = (0, h) if band is None else (max(0, int(band[0])), min(h, int(band[1])))
    height = max(1, y1 - y0)
    vertical = (
        [int(x) for x in range(w) if _longest_run(mask[y0:y1, x]) >= height * min_ratio]
        if y1 > y0
        else []
    )
    return {
        "horizontal": _merge_adjacent(horizontal),
        "vertical": _merge_adjacent(vertical),
    }


def _longest_run(line: np.ndarray) -> int:
    """Lunghezza della più lunga sequenza contigua di True in un vettore."""
    if not line.any():
        return 0
    edges = np.flatnonzero(np.diff(np.concatenate(([0], line.view(np.int8), [0]))))
    return int((edges[1::2] - edges[::2]).max())


def _merge_adjacent(values: list[int], gap: int = 3, max_thickness: int = 10) -> list[int]:
    """
    Un righello spesso 3px sono tre righe consecutive: contano per una.

    Scarta anche i gruppi troppo SPESSI: una figura scura piena produce
    centinaia di righe consecutive tutte «continue», che somigliano a righelli
    ma sono un'area riempita. Un righello vero è sottile per definizione.
    """
    merged: list[list[int]] = []
    for v in values:
        if merged and v - merged[-1][-1] <= gap:
            merged[-1].append(v)
        else:
            merged.append([v])
    return [
        int(sum(group) / len(group))
        for group in merged
        if group[-1] - group[0] <= max_thickness
    ]


def find_tables(gray: np.ndarray, text_boxes, min_rows: int = 3) -> list[tuple[int, int, int, int]]:
    """
    Regioni tabella, con due criteri complementari:

      • bordata  — almeno due righelli orizzontali e uno verticale che si
                   incrociano: la griglia è disegnata sulla pagina;
      • non bordata — più righe consecutive che condividono gli stessi inizi
                   di colonna. Senza bordi resta l'allineamento, che è comunque
                   una proprietà geometrica misurabile.

    @returns: riquadri (x0, y0, x1, y1) in pixel
    """
    h, w = gray.shape
    found: list[tuple[int, int, int, int]] = []

    # Due passaggi: le righe orizzontali delimitano la fascia della tabella,
    # e solo dentro quella fascia si cercano i separatori di colonna.
    horizontal = find_ruling_lines(gray)["horizontal"]
    if len(horizontal) >= 2:
        band = (min(horizontal), max(horizontal))
        vertical = find_ruling_lines(gray, band=band)["vertical"]
        if vertical:
            found.append(
                (
                    max(0, min(vertical) - 2),
                    max(0, band[0] - 2),
                    min(w, max(vertical) + 2),
                    min(h, band[1] + 2),
                )
            )

    for box in _aligned_column_runs(text_boxes, min_rows=min_rows):
        if not any(_overlaps(box, existing) for existing in found):
            found.append(box)
    return found


def find_figures_excluding(gray: np.ndarray, text_boxes, tables) -> list:
    """
    Figure, escludendo le tabelle già riconosciute.

    Una tabella bordata è inchiostro che non appartiene a nessuna riga di
    testo: senza questa esclusione verrebbe restituita anche come figura, e
    l'app la ritaglierebbe come immagine oltre a impaginarla come tabella.
    """
    return find_figures(gray, list(text_boxes) + list(tables))


def _aligned_column_runs(text_boxes, min_rows: int, tol: int = 12):
    """Sequenze di righe vicine che condividono gli stessi inizi di colonna."""
    boxes = sorted(text_boxes, key=lambda b: b[1])
    rows: list[list[tuple]] = []
    for box in boxes:
        # Stessa riga tipografica se le fasce verticali si sovrappongono.
        if rows and box[1] < rows[-1][0][3]:
            rows[-1].append(box)
        else:
            rows.append([box])

    runs = []
    current: list[list[tuple]] = []
    for row in rows:
        starts = sorted(int(b[0]) for b in row)
        if len(starts) < 2:
            if len(current) >= min_rows:
                runs.append(current)
            current = []
            continue
        if current and _same_columns(starts, sorted(int(b[0]) for b in current[-1]), tol):
            current.append(row)
        else:
            if len(current) >= min_rows:
                runs.append(current)
            current = [row]
    if len(current) >= min_rows:
        runs.append(current)

    out = []
    for run in runs:
        flat = [b for row in run for b in row]
        out.append(
            (
                int(min(b[0] for b in flat)),
                int(min(b[1] for b in flat)),
                int(max(b[2] for b in flat)),
                int(max(b[3] for b in flat)),
            )
        )
    return out


def _same_columns(a: list[int], b: list[int], tol: int) -> bool:
    if len(a) != len(b):
        return False
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def _overlaps(a, b) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])
