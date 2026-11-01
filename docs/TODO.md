# Offene Punkte (Stand 2026-11-01)

Kurzüberblick, wo als Nächstes angesetzt wird. Reihenfolge = Priorität.

## 1. Gesichtstracking verbessern (vorbereitet, noch nicht umgesetzt)
Testumgebung steht: `scratchpad/track2/` (Extraktions-Harness `hx/server.mjs`, Testvideos `dl/blink.webm`,
`v1`–`v4.webm`, Vorher-Stand `orig/src`). Messdaten: neutrale Gesichter liegen oft weit über den eingebauten
Grundwerten (z. B. browOuterUp ≈ 0,62 statt 0,05, mouthPucker ≈ 0,45 statt 0,15) → ohne Kalibrierung falsches
„Überrascht“, zu schwacher Mund.
- [ ] **Adaptive Grundwerte/Bereiche pro Person** (Brauen, Mund-Spitzen, Lächeln, Mundöffnung): langsame Mediane im
      Ruhezustand, robuste Min/Max für Öffnen/Schließen. Datei: `src/renderer/solver/mapping.ts`, `PoseSolver.ts`.
- [ ] **Blinzeln**: Blendshape + Augen-Seitenverhältnis (Lid-Landmarks) fusionieren, adaptiver Offen/Zu-Bereich,
      Ausgleich bei Kamera über dem Monitor (Blick nach unten).
- [ ] **Blick über Iris-Landmarks** (468–477) statt nur eyeLook-Blendshapes; nur benötigte Punkte als Float32Array
      aus dem Worker (`src/renderer/tracking/faceWorker.ts`, `landmarkerCore.ts`).
- [ ] **Mund**: jawOpen + normierter Lippenabstand, adaptiver Bereich (Reden sichtbar, weit offen = 1).
- [ ] **Kopf**: One-Euro-Feinabstimmung, kleine Totzone gegen Zittern, Auto-Neutral für Neigung ohne Kalibrierung.
- [ ] Vorher/Nachher messen: Blink-Trefferquote, Blickbereich, Mundbereich, Kopf-Zittern, Latenz.

## 2. Ausdrucks-Tasten (z. B. „Blep“ / Zunge)
MediaPipe liefert **kein** `tongueOut` → Zunge nur per Taste möglich.
- [ ] Tastenkürzel (z. B. 1–9) auf beliebige Modell-Ausdrücke legen, Umschalten oder Halten, weich ein-/ausblenden.
- [ ] Gilt auch für OBS-Seite (läuft über AvatarPose automatisch). UI: kleiner Abschnitt „Ausdruck-Tasten“.
- [ ] Hinweis: globale Tasten (wenn App nicht im Fokus) brauchen unter Wayland das GlobalShortcuts-Portal.

## 3. Vom Nutzer noch zu testen / Rückmeldung nötig
- [ ] Gesichtstracking mit echter Webcam (Emotions-Schwellen ggf. nachregeln).
- [ ] Neues Design (hell, Styleguide) – gefällt es? Perfect-Sync-Anzeige ungetestet (kein Testmodell).
- [ ] Virtuelle Kamera mit echtem v4l2loopback + OBS gleichzeitig.
- [ ] Handy als Kamera (IP Webcam / VDO.Ninja).
- [ ] Minimieren unter KWin/Wayland: läuft OBS-Ausgabe weiter?
- [ ] Neuer Avatar aus Unity nach `docs/AVATAR_ANLEITUNG.md`.

## 4. Bekannte Einschränkungen / später
- Lip-Sync: O/U-Verwechslung, braucht einige Sekunden Sprache zur Anpassung; `noiseSuppression` evtl. abschaltbar machen.
- Ubuntu 24.04+: Start nur mit `--no-sandbox` (AppArmor) – ggf. AppArmor-Profil mitliefern.
- Kein englisches UI (bewusst).
- Virtuelle-Kamera-Auslesen ist synchron (`readPixels`) – bei Ruckeln auf `readRenderTargetPixelsAsync` umstellen.
- Unabhängige Gesamtprüfung nach Design-Umbau wurde auf Wunsch übersprungen.
