param(
  [string]$BrowserTitlePattern = "Microsoft Edge|Google Chrome",
  [string]$CodexTitlePattern = "^ChatGPT$|Codex",
  [int]$DurationSeconds = 25,
  [int]$FrameRate = 15,
  [string]$Output = "docs/assets/hero-brain-hand.mp4",
  [string]$GifOutput = "",
  [switch]$Preview
)

$ErrorActionPreference = "Stop"

if ($DurationSeconds -lt 1) { throw "DurationSeconds must be at least 1." }
if ($FrameRate -lt 1 -or $FrameRate -gt 60) { throw "FrameRate must be between 1 and 60." }

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  throw "ffmpeg was not found on PATH. Install FFmpeg or add its bin directory to PATH."
}

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DemoWindowNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
'@

function Get-VisibleWindow {
  param(
    [string]$TitlePattern,
    [string]$Description
  )

  $matches = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle -match $TitlePattern
  })

  if ($matches.Count -eq 0) {
    throw "No visible $Description window matched '$TitlePattern'."
  }

  if ($matches.Count -gt 1) {
    $titles = ($matches | ForEach-Object { "[$($_.Id)] $($_.ProcessName): $($_.MainWindowTitle)" }) -join [Environment]::NewLine
    throw "More than one $Description window matched '$TitlePattern'. Use a narrower pattern:`n$titles"
  }

  return $matches[0]
}

function Get-WindowRect {
  param([System.Diagnostics.Process]$Process)

  $rect = New-Object DemoWindowNative+RECT
  if (-not [DemoWindowNative]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
    throw "Could not read the bounds of '$($Process.MainWindowTitle)'."
  }

  return [pscustomobject]@{
    Left = $rect.Left
    Top = $rect.Top
    Right = $rect.Right
    Bottom = $rect.Bottom
    Width = $rect.Right - $rect.Left
    Height = $rect.Bottom - $rect.Top
    Title = $Process.MainWindowTitle
    Process = $Process.ProcessName
    Id = $Process.Id
  }
}

$browser = Get-VisibleWindow -TitlePattern $BrowserTitlePattern -Description "browser"
$codex = Get-VisibleWindow -TitlePattern $CodexTitlePattern -Description "Codex"
$browserRect = Get-WindowRect -Process $browser
$codexRect = Get-WindowRect -Process $codex

$left = [Math]::Min($browserRect.Left, $codexRect.Left)
$top = [Math]::Min($browserRect.Top, $codexRect.Top)
$right = [Math]::Max($browserRect.Right, $codexRect.Right)
$bottom = [Math]::Max($browserRect.Bottom, $codexRect.Bottom)
$width = $right - $left
$height = $bottom - $top

# H.264 requires even dimensions. Reduce by one pixel when needed.
if (($width % 2) -ne 0) { $width -= 1 }
if (($height % 2) -ne 0) { $height -= 1 }

Write-Host "Browser: [$($browserRect.Id)] $($browserRect.Title)"
Write-Host "Codex:   [$($codexRect.Id)] $($codexRect.Title)"
Write-Host "Capture: x=$left y=$top width=$width height=$height duration=${DurationSeconds}s fps=$FrameRate"

if ($Preview) {
  Write-Host "Preview only. No recording was started."
  exit 0
}

function Resolve-OutputPath {
  param([string]$PathValue)

  $full = [IO.Path]::GetFullPath($PathValue)
  if (Test-Path -LiteralPath $full) {
    throw "Refusing to overwrite existing file: $full"
  }
  $parent = Split-Path -Parent $full
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  return $full
}

$outputPath = Resolve-OutputPath -PathValue $Output
$input = "desktop"
$size = "${width}x${height}"

& $ffmpeg.Source -hide_banner -loglevel info `
  -f gdigrab -framerate $FrameRate -offset_x $left -offset_y $top -video_size $size -i $input `
  -t $DurationSeconds -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart $outputPath

if ($LASTEXITCODE -ne 0) {
  throw "ffmpeg failed with exit code $LASTEXITCODE."
}

Write-Host "Wrote $outputPath"

if ($GifOutput) {
  $gifPath = Resolve-OutputPath -PathValue $GifOutput
  & $ffmpeg.Source -hide_banner -loglevel warning -i $outputPath `
    -filter_complex "[0:v]fps=15,scale=1440:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" $gifPath
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg GIF conversion failed with exit code $LASTEXITCODE." }
  Write-Host "Wrote $gifPath"
}
