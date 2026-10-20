# Build, Start & Packaging

## Entwicklung
```bash
npm ci
npm start          # build (assets + main + renderer) und Electron starten
npm run dev        # dasselbe + DevTools (--dev); Strg+R lädt neu
npm run electron   # nur starten, ohne neu zu bauen
npm run typecheck
```
`scripts/run-electron.mjs` hängt `--no-sandbox` nur an, wenn als root gestartet wird (Container).
F12 bzw. Strg+Umschalt+I öffnet jederzeit die DevTools.

## AppImage
```bash
npm run dist       # -> release/VTube-Linux-<version>-x86_64.AppImage
chmod +x release/VTube-Linux-*.AppImage && ./release/VTube-Linux-*.AppImage
```
Ohne FUSE (z.B. Container): `./VTube-Linux-*.AppImage --appimage-extract-and-run`.
Auf Fedora/Nobara ist FUSE normalerweise vorhanden (`sudo dnf install fuse fuse-libs` falls nicht).
Icon neu erzeugen: `npm run icon` (`scripts/make-icon.mjs` → `build/icon.png`).

GitHub Actions (`.github/workflows/build.yml`) baut bei jedem Push ein AppImage (Artifact);
ein Tag `v*` erzeugt zusätzlich ein GitHub-Release.

## Start-Optionen
| Option | Wirkung |
|---|---|
| `--dev` | DevTools öffnen |
| `--disable-gpu` oder `VTUBE_DISABLE_GPU=1` | Hardwarebeschleunigung aus (bei GPU-/Treiberproblemen) |
| `--ozone-platform=x11` | XWayland statt nativem Wayland erzwingen |
| `VTUBE_FFMPEG=/pfad/ffmpeg` | alternatives ffmpeg für die virtuelle Kamera |

Standard: natives Wayland wenn verfügbar (`ozone-platform-hint=auto`), GPU-Blocklist ignoriert
(NVIDIA), Hintergrund-Drosselung aus (Tracking läuft auch bei minimiertem/verdecktem Fenster).

## OBS
- **Browserquelle:** URL `http://127.0.0.1:39540/` (Port in den Einstellungen), Größe z.B. 1920×1080.
  Der Server lauscht nur auf 127.0.0.1. Transparenz: Hintergrund-Modus „transparent“.
- **Virtuelle Kamera** (v4l2loopback + ffmpeg):
  ```bash
  sudo dnf install v4l2loopback ffmpeg
  sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="VTube Linux" exclusive_caps=1
  # dauerhaft:
  echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
  echo 'options v4l2loopback devices=1 video_nr=10 card_label="VTube Linux" exclusive_caps=1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
  ```
  Danach in der App Gerät `/dev/video10` wählen und starten; in OBS „Videoaufnahmegerät (V4L2)“ → „VTube Linux“.

Einstellungen liegen in `~/.config/VTube Linux/settings.json`.
