# VTube Linux

VTuber-App für Linux: VRM-Avatar (VRM 0.x und 1.0) per Drag & Drop laden, mit normaler Webcam steuern.

- **Face-Tracking** (MediaPipe Face Landmarker, 52 ARKit-Blendshapes, läuft in einem Web Worker):
  Kopf, Hals und Oberkörper folgen dem Kopf; Blinzeln inkl. Zwinkern; Augen-/Blickrichtung; Mund (aa/ih/ou/ee/oh).
- **Automatische Emotionen**: Fröhlich, Wütend, Traurig, Entspannt, Überrascht – aus Ihrer echten Mimik, einzeln regelbar.
- **Perfect Sync**: Hat das Modell ARKit-Blendshapes, werden diese direkt angesteuert.
- **Lip-Sync per Mikrofon** zusätzlich zum Kamera-Mund (Mischung einstellbar).
- **Kalibrierung** auf Ihr neutrales Gesicht (Taste `C`).
- **Ausgabe**: OBS-Browserquelle (transparent), Chroma-Key-Hintergrund für Fenstererfassung, virtuelle Kamera (v4l2loopback).
- SpringBones (Haare/Kleidung), Atmung/Idle-Animation, Arme natürlich gesenkt, Auto-Framing (Kopf/Oberkörper/Ganzkörper).

## Installation (AppImage)

AppImage aus dem GitHub-Release bzw. dem Actions-Artifact laden, dann:
```bash
chmod +x VTube-Linux-*-x86_64.AppImage
./VTube-Linux-*-x86_64.AppImage
```
Selbst bauen: `npm ci && npm run dist` → `release/VTube-Linux-<version>-x86_64.AppImage` (Details: [docs/BUILD.md](docs/BUILD.md)).

## Erste Schritte

1. App starten, Kamerazugriff wird automatisch erteilt.
2. `.vrm` ins Fenster ziehen (oder „VRM öffnen…“ / `Strg+O`). Das zuletzt genutzte Modell wird beim Start wieder geladen.
3. Gerade in die Kamera schauen, neutrales Gesicht → **Kalibrieren** (`C`). Das ist wichtig: ohne Kalibrierung ist z. B. eine Kamera über dem Monitor als „Kopf gesenkt“ sichtbar.
4. Feintuning im Seitenpanel (`Tab`/`F1` blendet es aus): Glättung, Stärken, Emotionen. Doppelklick auf einen Regler setzt ihn zurück.

## OBS

- **Browserquelle (empfohlen):** URL `http://127.0.0.1:39540/`, 1920×1080. Für Transparenz in der App
  „Ansicht → Hintergrund → Transparent“ wählen, oder URL-Parameter `?bg=transparent` nutzen.
- **Fenstererfassung + Chroma-Key:** Hintergrund Grün (Standard), Panel mit `Tab` ausblenden.
- **Virtuelle Kamera** (für Discord etc.):
  ```bash
  sudo dnf install v4l2loopback
  sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="VTube Linux" exclusive_caps=1
  ```
  Dann in der App „Ausgabe → Virtuelle Kamera“ starten (Gerät `/dev/video10`). Benötigt `ffmpeg`.

## Probleme

| Symptom | Lösung |
|---|---|
| Schwarzes Fenster / Absturz beim Start (GPU) | `./VTube-Linux…AppImage --disable-gpu` oder `--ozone-platform=x11` |
| Tracking langsam | In „Kamera & Tracking“ GPU-Beschleunigung an/aus testen; 640×480 reicht völlig |
| Avatar schaut schräg | Neu kalibrieren; „Spiegeln“ prüfen |
| Mund bewegt sich beim Reden zu wenig | Lip-Sync aktivieren, Mund-Empfindlichkeit erhöhen |
| AppImage startet nicht (FUSE) | `sudo dnf install fuse fuse-libs` oder `--appimage-extract-and-run` |

Einstellungen: `~/.config/VTube Linux/settings.json`.

## Technik

Electron 38, three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm), [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe).
Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
