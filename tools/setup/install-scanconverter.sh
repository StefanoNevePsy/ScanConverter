#!/usr/bin/env sh
#
# Installa gli accessori locali di ScanConverter dove decidi tu (macOS/Linux).
#
# Gemello di Install-ScanConverter.ps1: stesse cartelle, stesse variabili,
# stesso file di esito. Vedi quello per il perché di ogni scelta.
#
#   ./install-scanconverter.sh --root /Volumes/Esterno/ScanConverter
#   ./install-scanconverter.sh --root ~/sc --model qwen3:4b --components ollama
#
# Rieseguibile: quello che c'è già viene saltato. Se un disco esterno cambia
# punto di mount, rilanciarlo con il nuovo percorso rimette a posto le
# variabili senza riscaricare nulla.

set -eu

TYPST_VERSION='0.15.1'
ROOT=''
MODEL='qwen3:8b'
COMPONENTS='ollama typst'
SKIP_MODEL=0

cyan()  { printf '\n=== %s\n' "$1"; }
ok()    { printf '  ok   %s\n' "$1"; }
skip()  { printf '  --   %s (già presente)\n' "$1"; }
warn()  { printf '  !    %s\n' "$1"; }

usage() {
  sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root)       ROOT="${2:?--root richiede un percorso}"; shift 2 ;;
    --model)      MODEL="${2:?--model richiede un nome}"; shift 2 ;;
    --components) COMPONENTS="$(echo "${2:?}" | tr ',' ' ')"; shift 2 ;;
    --skip-model) SKIP_MODEL=1; shift ;;
    -h|--help)    usage 0 ;;
    *)            printf 'Opzione sconosciuta: %s\n' "$1" >&2; usage 1 ;;
  esac
done

[ -n "$ROOT" ] || { printf '%s\n' 'Manca --root.' >&2; usage 1; }

case "$ROOT" in
  '~'/*) ROOT="$HOME/${ROOT#\~/}" ;;
esac
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"

has() { command -v "$1" >/dev/null 2>&1; }
wants() { case " $COMPONENTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Il file di profilo giusto dipende dalla shell: su macOS il default è zsh,
# su Linux quasi sempre bash. Scrivere nel posto sbagliato significa che la
# variabile non viene letta e i modelli finiscono di nuovo nella home.
profile_file() {
  case "${SHELL:-}" in
    */zsh)  printf '%s\n' "$HOME/.zshrc" ;;
    */bash) [ -f "$HOME/.bash_profile" ] && printf '%s\n' "$HOME/.bash_profile" \
              || printf '%s\n' "$HOME/.bashrc" ;;
    *)      printf '%s\n' "$HOME/.profile" ;;
  esac
}

# Idempotente: se la riga c'è già con lo stesso valore non fa niente; se il
# valore è cambiato (disco esterno rimontato altrove) la sostituisce.
set_env() {
  name="$1"; value="$2"; file="$(profile_file)"
  line="export $name=\"$value\""
  if [ -f "$file" ] && grep -qxF "$line" "$file"; then
    skip "$name=$value"
  else
    [ -f "$file" ] && grep -v "^export $name=" "$file" > "$file.sc-tmp" 2>/dev/null \
      && mv "$file.sc-tmp" "$file" || true
    printf '%s\n' "$line" >> "$file"
    ok "$name=$value (in $file)"
  fi
  export "$name=$value"
}

install_ollama() {
  cyan 'Modello linguistico (Ollama)'
  mkdir -p "$ROOT/models"
  # Prima la variabile, poi il download: al contrario i modelli finirebbero
  # in ~/.ollama e andrebbero riscaricati.
  set_env OLLAMA_MODELS "$ROOT/models"

  if has ollama; then
    skip "ollama ($(command -v ollama))"
  elif [ "$(uname -s)" = 'Darwin' ]; then
    warn 'Ollama non installato: scaricalo da https://ollama.com/download e rilancia.'
    warn 'Su macOS è un.app: si installa in /Applications, ma i MODELLI seguono OLLAMA_MODELS.'
    return
  else
    printf '       installo Ollama…\n'
    curl -fsSL https://ollama.com/install.sh | sh
    has ollama && ok 'Ollama installato' || { warn 'Installazione non riuscita.'; return; }
  fi

  [ "$SKIP_MODEL" -eq 1 ] && { warn 'Modello non scaricato (--skip-model).'; return; }
  cyan "Modello $MODEL"
  if ollama pull "$MODEL"; then ok "$MODEL pronto in $ROOT/models"
  else warn "«ollama pull $MODEL» non è riuscito."; fi
}

install_typst() {
  cyan "Compilatore Typst $TYPST_VERSION"
  dir="$ROOT/typst"
  mkdir -p "$dir"
  if [ -x "$dir/typst" ]; then
    skip "$dir/typst"
  else
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64)         asset='typst-aarch64-apple-darwin.tar.xz' ;;
      Darwin-x86_64)        asset='typst-x86_64-apple-darwin.tar.xz' ;;
      Linux-aarch64|Linux-arm64) asset='typst-aarch64-unknown-linux-musl.tar.xz' ;;
      Linux-x86_64)         asset='typst-x86_64-unknown-linux-musl.tar.xz' ;;
      *) warn "Typst nativo non disponibile per $(uname -s)-$(uname -m)."; return ;;
    esac
    staging="$(mktemp -d)"
    printf '       scarico %s\n' "$asset"
    curl -fsSL "https://github.com/typst/typst/releases/download/v$TYPST_VERSION/$asset" \
      | tar -xJ -C "$staging"
    found="$(find "$staging" -name typst -type f -print | head -n 1)"
    [ -n "$found" ] || { warn 'L’archivio non contiene il compilatore.'; rm -rf "$staging"; return; }
    cp "$found" "$dir/typst"
    for extra in LICENSE NOTICE README.md; do
      [ -f "$(dirname "$found")/$extra" ] && cp "$(dirname "$found")/$extra" "$dir/" || true
    done
    chmod 755 "$dir/typst"
    rm -rf "$staging"
    ok "Typst installato in $dir"
  fi
  # Il processo desktop cerca questa variabile prima del binario impacchettato.
  set_env SCANCONVERTER_TYPST_PATH "$dir/typst"
}

install_sidecar() {
  cyan 'Sidecar OCR (Nemotron OCR v2)'
  mkdir -p "$ROOT/sidecar" "$ROOT/hf-cache"
  set_env HF_HOME "$ROOT/hf-cache"
  if [ "$(uname -s)" = 'Darwin' ]; then
    warn 'Il modello OCR richiede una GPU NVIDIA con CUDA: su Mac non gira.'
    warn 'Tieni l’OCR su Gemini o NVIDIA e usa il locale per le fasi testuali.'
    return
  fi
  if [ ! -d "$ROOT/sidecar/ScanConverter" ]; then
    git clone --depth 1 https://github.com/StefanoNevePsy/ScanConverter.git \
      "$ROOT/sidecar/ScanConverter"
  else
    skip "$ROOT/sidecar/ScanConverter"
  fi
  printf '\n  Per completare, dalla cartella del sidecar:\n'
  printf '    cd %s/sidecar/ScanConverter/tools/local-ocr\n' "$ROOT"
  printf '    pip install torch --index-url https://download.pytorch.org/whl/cu124\n'
  printf '    pip install -r requirements.txt\n'
  printf '    python server.py\n'
}

# Esito che l'app desktop legge all'avvio: solo percorsi e indirizzi locali,
# nessuna chiave e nessun dato dei documenti.
write_manifest() {
  case "$(uname -s)" in
    Darwin) dir="$HOME/Library/Application Support/ScanConverter" ;;
    *)      dir="${XDG_CONFIG_HOME:-$HOME/.config}/ScanConverter" ;;
  esac
  mkdir -p "$dir"
  typst_path=''
  wants typst && [ -x "$ROOT/typst/typst" ] && typst_path="$ROOT/typst/typst"
  model=''
  [ "$SKIP_MODEL" -eq 0 ] && model="$MODEL"
  cat > "$dir/local-setup.json" <<JSON
{
  "schemaVersion": 1,
  "writtenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "root": "$ROOT",
  "components": "$COMPONENTS",
  "model": "$model",
  "localEndpoint": "http://localhost:11434/v1/chat/completions",
  "localOcrEndpoint": "http://localhost:8000/ocr",
  "typstPath": "$typst_path"
}
JSON
  ok "Esito scritto in $dir/local-setup.json"
}

printf 'ScanConverter — installazione locale in %s\n' "$ROOT"
wants ollama  && install_ollama
wants typst   && install_typst
wants sidecar && install_sidecar
write_manifest

cyan 'Fatto'
cat <<'TXT'
  Nell'app: Impostazioni -> Motori per fase -> scegli «Locale» dove vuoi.
  Gli indirizzi predefiniti (Ollama su 11434, sidecar su 8000) vanno già bene.

  Le variabili valgono dal prossimo terminale: apri una finestra nuova, e
  riavvia Ollama e ScanConverter.

  Disco esterno: se cambia punto di mount, rilancia con il nuovo --root.
  Non riscarica nulla, rimette solo a posto i percorsi.
TXT
