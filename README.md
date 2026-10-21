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
- **Virtuelle Kamera** (für Discord etc.): siehe nächster Abschnitt.

## Virtuelle Kamera (v4l2loopback)

**Jedes Programm mit eigener virtueller Kamera braucht ein eigenes Gerät.** Ein v4l2loopback-Gerät
trägt genau einen Bildstrom, und sein Name (`card_label`) gehört zum Gerät, nicht zum Programm.
Die virtuelle Kamera von OBS fragt nicht nach – sie nimmt das erste freie v4l2loopback-Gerät.
Gibt es nur eines, schreiben OBS und VTube Linux in dasselbe Gerät: Bild kaputt, falscher Name,
oder eines der Programme startet nicht. VTube Linux selbst wählt **nie** automatisch ein Gerät,
sondern schreibt nur in das eingestellte (Standard `/dev/video10`).

Darum zwei Geräte anlegen; OBS bekommt die kleinere Nummer, damit es sein eigenes zuerst findet:
```bash
sudo dnf install v4l2loopback ffmpeg
sudo modprobe -r v4l2loopback   # nur nötig, falls schon geladen (z. B. von OBS); vorher OBS/Discord/Browser schließen
sudo modprobe v4l2loopback devices=2 video_nr=9,10 card_label="OBS Virtual Camera,VTube Linux" exclusive_caps=1,1
```
Dauerhaft (beim Systemstart mit diesen Optionen laden):
```bash
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback devices=2 video_nr=9,10 card_label="OBS Virtual Camera,VTube Linux" exclusive_caps=1,1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
```
Ergebnis: `/dev/video9` „OBS Virtual Camera“ (für OBS), `/dev/video10` „VTube Linux“ (für diese App).
In Discord/OBS-Quelle/Zoom dann die Kamera „VTube Linux“ wählen.

**Gerät festlegen** (Vorrang von oben nach unten):

| Weg | Beispiel |
|---|---|
| Startoption | `./VTube-Linux-*.AppImage --vcam-device /dev/video10` (oder `--vcam-device=/dev/video10`) |
| Umgebungsvariable | `VTUBE_CAM_DEVICE=/dev/video10 ./VTube-Linux-*.AppImage` |
| App | „Ausgabe → Virtuelle Kamera → Gerät“ (Auswahl zeigt Name, Pfad und ob belegt) |
| Standard | `/dev/video10` |

Ist das Gerät per Startoption/Umgebungsvariable festgelegt, zeigt die App es als „festgelegt“ an und
die Einstellung ist gesperrt. Vor dem Start prüft die App: Gerät vorhanden, wirklich v4l2loopback,
Schreibrechte, und ob schon ein anderes Programm hineinschreibt – dann bricht sie mit Meldung
(Programmname + PID) ab, statt das andere Bild zu überschreiben.

**Geräte anzeigen:** `./VTube-Linux-*.AppImage --list-devices` (Alias `--vcam-list`) listet alle
v4l2loopback-Geräte mit Pfad, Name und benutzenden Prozessen und beendet sich sofort (kein Fenster).

## Probleme

| Symptom | Lösung |
|---|---|
| Schwarzes Fenster / Absturz beim Start (GPU) | `./VTube-Linux…AppImage --disable-gpu` oder `--ozone-platform=x11` |
| Tracking langsam | In „Kamera & Tracking“ GPU-Beschleunigung an/aus testen; 640×480 reicht völlig |
| Avatar schaut schräg | Neu kalibrieren; „Spiegeln“ prüfen |
| Mund bewegt sich beim Reden zu wenig | Lip-Sync aktivieren, Mund-Empfindlichkeit erhöhen |
| Virtuelle Kamera heißt „OBS Virtual Camera“ / Bild von OBS kaputt | Nur ein v4l2loopback-Gerät vorhanden → zwei anlegen (siehe oben), `--list-devices` prüfen |
| AppImage startet nicht (FUSE) | `sudo dnf install fuse fuse-libs` oder `--appimage-extract-and-run` |

Einstellungen: `~/.config/VTube Linux/settings.json`.

## Technik

Electron 38, three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm), [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe).
Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
