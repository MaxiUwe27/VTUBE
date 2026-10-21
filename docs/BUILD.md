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
| `--vcam-device /dev/videoN` | Gerät der virtuellen Kamera festlegen (Vorrang vor Umgebungsvariable und Einstellung) |
| `VTUBE_CAM_DEVICE=/dev/videoN` | dasselbe per Umgebungsvariable (Vorrang vor der Einstellung) |
| `--list-devices` / `--vcam-list` | Video-Geräte (v4l2loopback: Pfad, Name, benutzende Prozesse) ausgeben und beenden, ohne Fenster |

Standard: natives Wayland wenn verfügbar (`ozone-platform-hint=auto`), GPU-Blocklist ignoriert
(NVIDIA), Hintergrund-Drosselung aus (Tracking läuft auch bei minimiertem/verdecktem Fenster).

## OBS
- **Browserquelle:** URL `http://127.0.0.1:39540/` (Port in den Einstellungen), Größe z.B. 1920×1080.
  Der Server lauscht nur auf 127.0.0.1. Transparenz: Hintergrund-Modus „transparent“.
- **Virtuelle Kamera** (v4l2loopback + ffmpeg): jedes Programm mit eigener virtueller Kamera braucht
  ein eigenes Gerät. Die virtuelle Kamera von OBS nimmt das erste freie v4l2loopback-Gerät (unabhängig vom
  Namen), deshalb zwei Geräte anlegen und OBS die kleinere Nummer geben:
  ```bash
  sudo dnf install v4l2loopback ffmpeg
  sudo modprobe -r v4l2loopback   # falls schon (z. B. von OBS) geladen; geht nur, wenn kein Programm es benutzt
  sudo modprobe v4l2loopback devices=2 video_nr=9,10 card_label="OBS Virtual Camera,VTube Linux" exclusive_caps=1,1
  # dauerhaft:
  echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
  echo 'options v4l2loopback devices=2 video_nr=9,10 card_label="OBS Virtual Camera,VTube Linux" exclusive_caps=1,1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
  ```
  Listen (`video_nr`, `card_label`, `exclusive_caps`) sind kommagetrennt, ein Eintrag pro Gerät.
  VTube Linux schreibt nur in das konfigurierte Gerät (Standard `/dev/video10`; Vorrang:
  `--vcam-device` > `VTUBE_CAM_DEVICE` > Einstellung > Standard) und wählt nie selbst eines aus.
  Kontrolle: `--list-devices`. In OBS „Videoaufnahmegerät (V4L2)“ → „VTube Linux“.
  Code: `src/main/vcamDevice.ts` (Geräteauflösung, sysfs-/proc-Prüfungen), `src/shared/vcamSetup.ts` (Befehle).

Einstellungen liegen in `~/.config/VTube Linux/settings.json`.
