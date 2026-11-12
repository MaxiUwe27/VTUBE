# Fahrplan & offene Punkte

Was als Nächstes kommt und was bekannt nicht perfekt ist. Reihenfolge = Priorität.
Wünsche und Fehlerberichte gerne als Issue.

## 1. Gesichtstracking – Nachbesserungen
Umgesetzt in `solver/adaptive.ts`, `faceGeometry.ts`, `faceInputs.ts`, `PoseSolver.ts`, `mapping.ts`; Landmarks
gehen ohne Kopie über `FaceFrame.landmarks`. Neue Einstellungen ohne UI: `tracking.adaptiveTracking`, `irisGaze`,
`headDeadzone` (0,3°).
- [x] Adaptive Grundwerte pro Person (Median im Ruhezustand, mit Kalibrierung max. ±0,1 Drift).
- [x] Blinzeln: Blendshape + Augen-Seitenverhältnis, Blick-nach-unten-Ausgleich, fernes Auge folgt bei Kopfdrehung > 15°.
- [x] Blick: 60 % Iris + 40 % Blendshapes, Neutral aus Kalibrierung bzw. Median.
- [x] Mund: jawOpen + Lippenabstand, gelernter Bereich (Reden v1: Median 0,00 → 0,32).
- [x] Kopf: Totzone, schnellerer Filter, Auto-Neutral ohne Kalibrierung (Zittern ca. halbiert).
- [ ] **GPU-Hänger**: Hängt die erste GPU-Erkennung (im Test unter SwiftShader 12 s keine Bilder), gibt es keinen
      CPU-Rückfall – nur für „zu langsam“ und Fehler. Zeit-Wächter in `FaceTracker.ts`/`faceWorker.ts` ergänzen.
- [ ] Blinzeln v4: 1 Fehlauslösung mehr als vorher; Iris-Vertikale nur an 3 Clips abgestimmt.
- [ ] Dauerlächler verlieren ohne Kalibrierung teils „Fröhlich“ (Grundwert lernt Lächeln mit).
- [ ] Regler für die drei neuen Einstellungen in „Kamera & Tracking → Mehr Einstellungen“.

## 2. Ausdrucks-Tasten (z. B. „Blep“ / Zunge)
MediaPipe liefert **kein** `tongueOut` → Zunge nur per Taste möglich.
- [ ] Tastenkürzel (z. B. 1–9) auf beliebige Modell-Ausdrücke legen, Umschalten oder Halten, weich ein-/ausblenden.
- [ ] Gilt auch für OBS-Seite (läuft über AvatarPose automatisch). UI: kleiner Abschnitt „Ausdruck-Tasten“.
- [ ] Hinweis: globale Tasten (wenn App nicht im Fokus) brauchen unter Wayland das GlobalShortcuts-Portal.

## 3. Noch nicht mit echter Hardware getestet (Rückmeldungen willkommen)
- [ ] Gesichtstracking mit echter Webcam (Emotions-Schwellen ggf. nachregeln).
- [ ] Perfect-Sync-Modelle (kein Testmodell mit ARKit-Blendshapes vorhanden).
- [ ] Virtuelle Kamera mit echtem v4l2loopback + OBS gleichzeitig.
- [ ] Handy als Kamera (IP Webcam / VDO.Ninja).
- [ ] Minimieren unter KWin/Wayland: läuft OBS-Ausgabe weiter?
- [ ] Avatar-Export aus Unity nach `docs/AVATAR_ANLEITUNG.md`.

## 4. Bekannte Einschränkungen / später
- Lip-Sync: O/U-Verwechslung, braucht einige Sekunden Sprache zur Anpassung; `noiseSuppression` evtl. abschaltbar machen.
- Ubuntu 24.04+: Start nur mit `--no-sandbox` (AppArmor) – ggf. AppArmor-Profil mitliefern.
- Kein englisches UI (bewusst).
- Virtuelle-Kamera-Auslesen ist synchron (`readPixels`) – bei Ruckeln auf `readRenderTargetPixelsAsync` umstellen.
