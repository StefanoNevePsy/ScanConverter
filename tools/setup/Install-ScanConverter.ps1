<#
.SYNOPSIS
    Installa gli accessori locali di ScanConverter dove decidi tu.

.DESCRIPTION
    ScanConverter gira nel browser (o nella sua finestra desktop) e non può
    installare programmi da sé: quello che segue è il lavoro che l'app
    dovrebbe fare e non può, raccolto in un file solo, parametrico sulla
    cartella di destinazione.

    Cosa mette dove:

      <Root>\ollama        il programma Ollama
      <Root>\models        i modelli linguistici scaricati (la parte pesante)
      <Root>\typst         il compilatore Typst nativo
      <Root>\hf-cache      i pesi del modello OCR, se usi il sidecar
      <Root>\sidecar       il codice del sidecar OCR

    Nessuno di questi percorsi è C:. È il punto: su un portatile con il disco
    di sistema pieno, o su una chiavetta che porti fra due computer, tutta la
    parte grossa sta dove dici tu.

    Lo script è RIESEGUIBILE. Se qualcosa c'è già lo salta; se la lettera del
    disco è cambiata (succede con i dischi esterni) rilanciarlo con la nuova
    lettera rimette a posto le variabili d'ambiente senza riscaricare nulla.

.PARAMETER Root
    Cartella base. Esempio: D:\ScanConverter

.PARAMETER Model
    Modello linguistico da scaricare. Default qwen3:8b (~5 GB): multilingue,
    la resa migliore sull'italiano fra quelli che entrano in 10 GB di VRAM.

.PARAMETER Components
    Cosa installare: ollama, typst, sidecar. Default: ollama e typst — cioè
    tutto quello che non richiede WSL2.

.PARAMETER SkipModel
    Prepara Ollama ma non scarica il modello (utile per riscaricare i modelli
    dopo, o se li hai già altrove).

.EXAMPLE
    .\Install-ScanConverter.ps1 -Root D:\ScanConverter

.EXAMPLE
    .\Install-ScanConverter.ps1 -Root E:\SC -Model mistral-small -Components ollama,typst,sidecar
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $Root,

    [string] $Model = 'qwen3:8b',

    [ValidateSet('ollama', 'typst', 'sidecar')]
    [string[]] $Components = @('ollama', 'typst'),

    [switch] $SkipModel
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TypstVersion = '0.15.1'

# ------------------------------------------------------------------ output

function Write-Step   ($m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Write-Ok     ($m) { Write-Host "  ok   $m" -ForegroundColor Green }
function Write-Skip   ($m) { Write-Host "  --   $m (già presente)" -ForegroundColor DarkGray }
function Write-Warn2  ($m) { Write-Host "  !    $m" -ForegroundColor Yellow }

# ------------------------------------------------------------------ utilità

function Resolve-Root {
    param([string] $Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $drive = [System.IO.Path]::GetPathRoot($full)
    if (-not (Test-Path -LiteralPath $drive)) {
        throw "Il disco $drive non è collegato. Se è un disco esterno, inseriscilo e rilancia."
    }
    return $full.TrimEnd('\')
}

function New-Dir {
    param([string] $Path)
    if (Test-Path -LiteralPath $Path) { return }
    if ($PSCmdlet.ShouldProcess($Path, 'Crea cartella')) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

<#
    Le variabili d'ambiente vanno scritte a livello UTENTE, non di processo:
    devono sopravvivere alla chiusura di questa finestra, perché è Ollama —
    avviato da Windows all'accensione — a doverle leggere.
#>
function Set-UserEnv {
    param([string] $Name, [string] $Value)
    $current = [Environment]::GetEnvironmentVariable($Name, 'User')
    if ($current -eq $Value) { Write-Skip "$Name = $Value"; return }
    if ($PSCmdlet.ShouldProcess("$Name = $Value", 'Imposta variabile utente')) {
        [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
        Set-Item -Path "Env:$Name" -Value $Value
        if ($current) { Write-Ok "$Name aggiornata: $current -> $Value" }
        else { Write-Ok "$Name = $Value" }
    }
}

function Get-Download {
    param([string] $Uri, [string] $OutFile)
    Write-Host "       scarico $Uri"
    $progress = $ProgressPreference
    # Senza questo Invoke-WebRequest ridisegna la barra a ogni blocco e un
    # download da 700 MB diventa più lento della rete.
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing }
    finally { $ProgressPreference = $progress }
}

function Test-Command {
    param([string] $Name)
    return [bool] (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ------------------------------------------------------------------ Ollama

function Install-Ollama {
    param([string] $Root)

    Write-Step 'Modello linguistico (Ollama)'
    $programDir = Join-Path $Root 'ollama'
    $modelsDir = Join-Path $Root 'models'
    New-Dir $programDir
    New-Dir $modelsDir

    # PRIMA la variabile, POI il download: al contrario i modelli finirebbero
    # in C:\Users\...\.ollama e andrebbero riscaricati da capo.
    Set-UserEnv -Name 'OLLAMA_MODELS' -Value $modelsDir

    $exe = Join-Path $programDir 'ollama.exe'
    if (Test-Path -LiteralPath $exe) {
        Write-Skip "Ollama in $programDir"
    }
    elseif ($PSCmdlet.ShouldProcess($programDir, 'Installa Ollama')) {
        $installer = Join-Path $env:TEMP 'OllamaSetup.exe'
        Get-Download -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $installer
        Write-Host "       installo (l'installer chiede conferma)..."
        # `Start-Process -Wait` aspetta anche i processi discendenti. Ollama
        # avvia l'app e il server al termine dell'installazione, quindi quel
        # comando non tornerebbe finché Ollama resta aperto. Il Process .NET,
        # invece, aspetta soltanto l'installer vero e proprio.
        $installProcess = Start-Process -FilePath $installer `
            -ArgumentList "/DIR=`"$programDir`"" -PassThru
        $installProcess.WaitForExit()
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $exe) { Write-Ok "Ollama installato in $programDir" }
        else { Write-Warn2 "Ollama non risulta in ${programDir}: controlla la destinazione scelta nell'installer." }
    }

    if ($SkipModel) { Write-Warn2 'Modello non scaricato (-SkipModel).'; return }

    Write-Step "Modello $Model"
    $ollama = if (Test-Path -LiteralPath $exe) { $exe } elseif (Test-Command 'ollama') { 'ollama' } else { $null }
    if (-not $ollama) {
        Write-Warn2 "Ollama non trovato: apri un terminale nuovo e lancia «ollama pull $Model»."
        return
    }
    # `ollama list` non fa distinzione fra "assente" e "server spento": si
    # tenta il pull comunque, che è idempotente e riprende i download parziali.
    if ($PSCmdlet.ShouldProcess($Model, 'Scarica modello')) {
        & $ollama pull $Model
        if ($LASTEXITCODE -eq 0) { Write-Ok "$Model pronto in $modelsDir" }
        else { Write-Warn2 "«ollama pull $Model» è uscito con codice $LASTEXITCODE." }
    }
}

# ------------------------------------------------------------------- Typst

function Install-Typst {
    param([string] $Root)

    Write-Step "Compilatore Typst $TypstVersion"
    $dir = Join-Path $Root 'typst'
    $exe = Join-Path $dir 'typst.exe'
    New-Dir $dir

    if (Test-Path -LiteralPath $exe) {
        Write-Skip $exe
    }
    elseif ($PSCmdlet.ShouldProcess($dir, 'Installa Typst')) {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
        $asset = "typst-$arch-pc-windows-msvc.zip"
        $zip = Join-Path $env:TEMP $asset
        Get-Download -Uri "https://github.com/typst/typst/releases/download/v$TypstVersion/$asset" -OutFile $zip
        $staging = Join-Path $env:TEMP "typst-staging-$(Get-Random)"
        Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
        $found = Get-ChildItem -Path $staging -Filter 'typst.exe' -Recurse | Select-Object -First 1
        if (-not $found) { throw "L'archivio Typst non contiene typst.exe." }
        Copy-Item -LiteralPath $found.FullName -Destination $exe -Force
        foreach ($extra in @('LICENSE', 'NOTICE', 'README.md')) {
            $file = Join-Path $found.Directory.FullName $extra
            if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $dir -Force }
        }
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Write-Ok "Typst installato in $dir"
    }

    # Il processo desktop cerca questa variabile prima del binario impacchettato:
    # è il modo per usare il Typst sul disco esterno invece di quello nella build.
    Set-UserEnv -Name 'SCANCONVERTER_TYPST_PATH' -Value $exe
}

# ----------------------------------------------------------------- sidecar

function Install-Sidecar {
    param([string] $Root)

    Write-Step 'Sidecar OCR (Nemotron OCR v2)'
    $dir = Join-Path $Root 'sidecar'
    $cache = Join-Path $Root 'hf-cache'
    New-Dir $dir
    New-Dir $cache
    Set-UserEnv -Name 'HF_HOME' -Value $cache

    # Questo pezzo NON si installa da Windows: la scheda del modello richiede
    # Linux amd64 con CUDA, quindi gira dentro WSL2. Preparare qui le cartelle
    # e la variabile serve comunque — WSL vede D:\ come /mnt/d.
    $wsl = Test-Command 'wsl'
    if (-not $wsl) {
        Write-Warn2 'WSL2 non risulta installato. Da un terminale amministratore: wsl --install'
    }

    $drive = ($Root.Substring(0, 1)).ToLower()
    $linuxRoot = "/mnt/$drive" + ($Root.Substring(2) -replace '\\', '/')

    Write-Host ''
    Write-Host '  Il sidecar richiede Linux con CUDA: si completa dentro Ubuntu (WSL2).' -ForegroundColor DarkGray
    Write-Host '  Se Ubuntu non è installato, da PowerShell come amministratore:' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host "    wsl --update" -ForegroundColor White
    Write-Host "    wsl --install -d Ubuntu --location '$Root\wsl\Ubuntu'" -ForegroundColor White
    Write-Host ''
    Write-Host '  Dopo il primo avvio di Ubuntu, installa toolkit, codice e modello:' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '    sudo apt update' -ForegroundColor White
    Write-Host '    sudo apt install -y wget git git-lfs build-essential python3-venv python3-pip' -ForegroundColor White
    Write-Host '    wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb' -ForegroundColor White
    Write-Host '    sudo dpkg -i cuda-keyring_1.1-1_all.deb' -ForegroundColor White
    Write-Host '    sudo apt update && sudo apt install -y cuda-toolkit-12-8' -ForegroundColor White
    Write-Host '    export CUDA_HOME=/usr/local/cuda-12.8' -ForegroundColor White
    Write-Host '    export PATH="$CUDA_HOME/bin:$PATH"' -ForegroundColor White
    Write-Host "    export SC_ROOT=$linuxRoot" -ForegroundColor White
    Write-Host "    export HF_HOME=$linuxRoot/hf-cache" -ForegroundColor White
    Write-Host "    git clone --branch claude/pipeline-locale --single-branch https://github.com/StefanoNevePsy/ScanConverter.git $linuxRoot/sidecar/ScanConverter" -ForegroundColor White
    Write-Host '    git lfs install' -ForegroundColor White
    Write-Host "    git clone https://huggingface.co/nvidia/nemotron-ocr-v2 $linuxRoot/sidecar/nemotron-ocr-v2" -ForegroundColor White
    Write-Host "    python3 -m venv --copies $linuxRoot/sidecar/.venv" -ForegroundColor White
    Write-Host "    source $linuxRoot/sidecar/.venv/bin/activate" -ForegroundColor White
    Write-Host '    python -m pip install --upgrade pip' -ForegroundColor White
    Write-Host '    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128' -ForegroundColor White
    Write-Host '    pip install hatchling editables setuptools ninja' -ForegroundColor White
    Write-Host "    pip install --no-build-isolation -v $linuxRoot/sidecar/nemotron-ocr-v2/nemotron-ocr" -ForegroundColor White
    Write-Host "    pip install -r $linuxRoot/sidecar/ScanConverter/tools/local-ocr/requirements.txt" -ForegroundColor White
    Write-Host "    export NEMOTRON_OCR_MODEL_ROOT=$linuxRoot/sidecar/nemotron-ocr-v2" -ForegroundColor White
    Write-Host "    cd $linuxRoot/sidecar/ScanConverter/tools/local-ocr" -ForegroundColor White
    Write-Host '    python server.py' -ForegroundColor White
}

# ------------------------------------------------------------------- esito

<#
    Un file di esito che l'app desktop legge all'avvio per proporre gli
    indirizzi giusti senza farli ridigitare. Non contiene chiavi né dati del
    documento: solo percorsi e indirizzi locali.
#>
function Write-Manifest {
    param([string] $Root, [string[]] $Installed)

    $appData = Join-Path $env:APPDATA 'ScanConverter'
    New-Dir $appData
    $manifest = @{
        schemaVersion    = 1
        writtenAt        = (Get-Date).ToString('o')
        root             = $Root
        components       = $Installed
        model            = if ($SkipModel) { '' } else { $Model }
        localEndpoint    = 'http://localhost:11434/v1/chat/completions'
        localOcrEndpoint = 'http://localhost:8000/ocr'
        typstPath        = if ($Installed -contains 'typst') { Join-Path $Root 'typst\typst.exe' } else { '' }
    }
    $path = Join-Path $appData 'local-setup.json'
    if ($PSCmdlet.ShouldProcess($path, 'Scrivi esito')) {
        $manifest | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
        Write-Ok "Esito scritto in $path"
    }
}

# -------------------------------------------------------------------- main

$Root = Resolve-Root -Path $Root
Write-Host "ScanConverter — installazione locale in $Root" -ForegroundColor White
New-Dir $Root

if ($Components -contains 'ollama')  { Install-Ollama  -Root $Root }
if ($Components -contains 'typst')   { Install-Typst   -Root $Root }
if ($Components -contains 'sidecar') { Install-Sidecar -Root $Root }

Write-Manifest -Root $Root -Installed $Components

Write-Step 'Fatto'
$finalMessage = @"
  Nell'app: Impostazioni -> Motori per fase -> scegli «Locale» dove vuoi.
  Gli indirizzi predefiniti (Ollama su 11434, sidecar su 8000) vanno già bene.

  Le variabili d'ambiente valgono dal PROSSIMO avvio dei programmi: chiudi
  Ollama dalla barra delle applicazioni e riaprilo, e riavvia ScanConverter.

  Disco esterno: se un domani cambia lettera, rilancia questo script con la
  nuova (-Root E:\...). Non riscarica nulla, rimette solo a posto i percorsi.
"@
Write-Host $finalMessage -ForegroundColor DarkGray
