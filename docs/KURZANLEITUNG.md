# VTube Linux – Kurzanleitung

VTuber-App für Linux: VRM-Avatar laden, Webcam steuert Kopf, Augen, Mund und Mimik.
Kostenlos, MIT-Lizenz. Alles läuft lokal, nichts wird ins Internet geschickt.

## Starten
Download: https://github.com/MaxiUwe27/VTUBE/releases/latest
```bash
chmod +x VTube-Linux-*-x86_64.AppImage
./VTube-Linux-*-x86_64.AppImage
```
Voraussetzung: 64-Bit-Linux (x86_64), Webcam, Grafikkarte mit WebGL 2 (jede aktuelle NVIDIA/AMD/Intel).

**Startet nicht?**

| Distribution / Meldung | Lösung |
|---|---|
| Ubuntu 22.04: „AppImages require FUSE“ | `sudo apt install libfuse2` – oder mit `--appimage-extract-and-run` starten |
| Ubuntu 24.04 und neuer: „AppImages require FUSE“ | `sudo apt install libfuse2t64` – oder mit `--appimage-extract-and-run` starten |
| Ubuntu 24.04+: „No usable sandbox“ / „SUID sandbox helper“ | Ubuntu sperrt die Chromium-Sandbox per AppArmor. Mit `--no-sandbox` starten (etwas weniger abgeschottet; die App lädt nur lokale Dateien und Ihre eigene Browserquellen-URL) |
| Schwarzes Fenster / Absturz (Grafik) | mit `--disable-gpu` oder `--ozone-platform=x11` starten |
| Fedora, Nobara, Arch, openSUSE | läuft normalerweise direkt |

## Benutzen
1. `.vrm`-Datei ins Fenster ziehen.
2. Gerade in die Kamera schauen → **Kalibrieren** (Taste `C`).
3. Feineinstellungen im Seitenpanel (`Tab` blendet es aus). Mit der Maus im Avatar-Fenster die Kamera drehen/zoomen.

## In OBS / Discord
- **OBS:** Quelle „Browser“, URL `http://127.0.0.1:39540/`, 1920×1080 – Hintergrund ist transparent.
  Zeigt die Quelle „WebGL nicht verfügbar“: OBS → Einstellungen → Erweitert → Browserquellen-Hardwarebeschleunigung an.
- **Virtuelle Kamera** (Discord, Zoom …): braucht das Kernelmodul v4l2loopback mit zwei Geräten
  (eins für OBS, eins für VTube) – Befehle stehen in der App unter „Ausgabe → Virtuelle Kamera“.

## Handy als Kamera
Kamera-Auswahl → „Browserquelle (URL) …“, z. B. Android-App „IP Webcam“: `http://<Handy-IP>:8080/video`.

## Eigener Avatar
Normale VRM-Dateien (VRoid, UniVRM) funktionieren direkt. Aus VRChat konvertierte Avatare ohne eingerichtete
VRM-Ausdrücke werden automatisch zugeordnet; am besten ist ein sauber exportierter Avatar mit allen Ausdrücken
(Anforderungen: `AVATAR_ANLEITUNG.md`). Prüfen: „Modell → Ausdrücke (Diagnose)“ mit Test-Reglern.

Einstellungen liegen in `~/.config/VTube Linux/`.
