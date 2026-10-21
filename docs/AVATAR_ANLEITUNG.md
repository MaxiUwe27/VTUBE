# Avatar-Anforderungen für VTube Linux (Konvertierung in Unity)

Auftrag für den Konvertierer (Mensch oder KI mit Unity-Zugriff): Aus dem VRChat-Avatar eine **VRM-Datei**
erzeugen, die in VTube Linux (three.js + @pixiv/three-vrm) **ohne automatische Notlösungen** voll funktioniert.
Die App läuft im Webbrowser-Kern – also gelten glTF/WebGL-Grenzen, nicht Unity-Grenzen.

## 1. Werkzeug & Format
- **UniVRM**, aktuelle stabile Version (vrm-c/UniVRM, Releases auf GitHub), in einem dazu passenden Unity (aktuell 2022.3 LTS).
- Export als **VRM 1.0** (bevorzugt) oder VRM 0.x. Beides wird unterstützt; VRM 1.0 hat eindeutigere Ausdrucksnamen.
- **Nicht** `.vsfavatar` (VSeeFace-eigenes Format) – das kann nur VSeeFace lesen.

## 2. Skelett (Humanoid)
- Unity-Rig auf **Humanoid**, Avatar-Mapping vollständig und ohne Warnungen.
- Pflicht: Hips, Spine, Head, Arme, Beine. **Unbedingt zusätzlich zuweisen:** Neck, Chest, (UpperChest falls vorhanden),
  **LeftEye/RightEye**, Schultern, alle Finger.
- Vor dem Export **T-Pose**, UniVRM-Option „Pose freeze / Normalize“ aktiv lassen. Keine Skalierung ≠ 1 an Wurzel-Objekten.

## 3. Gesichtsausdrücke (wichtigster Teil)
Im Export **müssen** alle folgenden Ausdrücke existieren **und tatsächlich Blendshapes enthalten** (keine leeren
Standard-Clips!). Gewicht jeweils **100 %** (VRM 0.x: Wert 100, nicht 1).

| Zweck | VRM 1.0 Preset | VRM 0.x Preset | Typische Quelle beim VRChat-Avatar |
|---|---|---|---|
| Blinzeln beide | `blink` | `Blink` | `Blink` / `vrc.blink` / まばたき |
| Blinzeln links | `blinkLeft` | `Blink_L` | ウィンク / `vrc.blink_left` |
| Blinzeln rechts | `blinkRight` | `Blink_R` | ウィンク右 / `vrc.blink_right` |
| Mund A | `aa` | `A` | `vrc.v_aa` / あ |
| Mund I | `ih` | `I` | `vrc.v_ih` / い |
| Mund U | `ou` | `U` | `vrc.v_ou` / う |
| Mund E | `ee` | `E` | `vrc.v_e` / え |
| Mund O | `oh` | `O` | `vrc.v_oh` / お |
| Fröhlich | `happy` | `Joy` | 笑い (+ にこり) |
| Wütend | `angry` | `Angry` | 怒り |
| Traurig | `sad` | `Sorrow` | 困る |
| Entspannt | `relaxed` | `Fun` | にこり / なごみ |
| Überrascht | `surprised` | (VRM 0.x: Custom „Surprised“) | びっくり |

Regeln:
- **Blink links/rechts aus Sicht des Avatars** (blinkLeft = linkes Auge des Avatars). Einmal im Preview prüfen.
- Jeder Ausdruck bindet die Blendshape auf **allen** Meshes/Submeshes, die sie enthalten (Gesicht ist oft geteilt).
- Keine doppelten Clip-Namen, keine leeren Clips, keine Preset-Namen in falscher Schreibweise.
- **Overrides (VRM 1.0)**: Bei Emotionen, die die Augen schließen (z. B. `happy` mit 笑い), `overrideBlink = block`.
  Bei `surprised` `overrideBlink = blend`. Mund-Overrides nicht setzen.
- `isBinary` aus (sonst springen Ausdrücke statt weich zu blenden).
- LookUp/LookDown/LookLeft/LookRight nur anlegen, wenn der Blick über Blendshapes statt Augenknochen läuft.

## 4. Perfect Sync (dringend empfohlen – deutlich natürlichere Mimik)
- Das Gesichts-Mesh braucht die **52 ARKit-Blendshapes** mit exakt diesen Namen (`eyeBlinkLeft`, `jawOpen`,
  `mouthSmileLeft`, `browInnerUp`, …; vollständige Liste: Apple ARFaceAnchor.BlendShapeLocation).
- Für **jede** dieser 52 Blendshapes einen **benutzerdefinierten VRM-Ausdruck mit genau demselben Namen** anlegen,
  Gewicht 100 %. (Ohne diese Ausdrücke ignoriert der VRM-Standard die Blendshapes.)
- Hat der Avatar keine ARKit-Blendshapes, müssen sie erst im 3D-Programm erstellt werden (z. B. Blender-Add-on
  „Faceit“ oder fertige Perfect-Sync-Erweiterungen für die Avatar-Basis auf Booth). Ist das zu aufwendig: weglassen –
  dann reichen die Ausdrücke aus Abschnitt 3.
- Ab 40 vorhandenen ARKit-Ausdrücken schaltet VTube Linux automatisch auf Perfect Sync.

## 5. Blick (LookAt)
- Typ **Bone** mit zugewiesenen Augenknochen (oder Typ Expression, siehe oben).
- Bereiche sinnvoll setzen (VRM 1.0 `rangeMapHorizontalOuter/Inner/VerticalUp/Down`): Eingang 90°, Ausgang ≈ 10–15°
  bei Knochen bzw. 1.0 bei Blendshapes. Im Preview prüfen, dass die Augen nicht ins Weiße drehen.

## 6. Physik (SpringBones)
- Haare, Ohren, Schwanz, Kordeln/Jacke als **VRM SpringBone** (VRChat-PhysBones werden nicht übernommen – neu anlegen).
- Collider an Kopf, Hals, Brust, Oberarmen, damit Haare nicht durch den Körper fallen.
- Nicht zu weich (Stiffness ~1–2, Drag ~0.4–0.6), sonst schwingen Haare bei Kopfdrehung zu stark nach.

## 7. Materialien & Größe
- Shader **MToon** (VRM-Standard) oder Unlit; lilToon/Poiyomi werden beim Export ersetzt – Aussehen danach prüfen
  (Umrisse, Schattenfarbe, Transparenz bei Haaren: Cutout statt Transparent, wo möglich).
- Texturen max. 2048 px (Gesicht ggf. 4096). Dateigröße möglichst **< 50 MB**.
- **Unbenutzte Blendshapes löschen** (z. B. `shrink_*`, `vrc.v_sil/ch/dd/ff/kk/nn/pp/rr/ss/th`, MMD-Extras, die nicht
  gebraucht werden) – das spart Grafikspeicher erheblich (beim alten Avatar: 97 MB Morph-Daten).
- Meshes sinnvoll zusammenfassen (Kleidung zu wenigen Meshes), Gesicht als eigenes Mesh lassen.

## 8. Meta
- Titel, Autor, Version, Nutzungsrechte (VRM-Lizenzfelder) ausfüllen.

## 9. Abnahme / Prüfliste
1. In Unity: UniVRM-Export ohne Fehler/Warnungen; Datei in einem leeren Projekt wieder importieren und
   jeden Ausdruck im Preview auf 100 % ziehen – Gesicht reagiert sichtbar.
2. In VTube Linux: **Modell → Ausdrücke (Diagnose)** aufklappen:
   - alle Ausdrücke aus Abschnitt 3 stehen als **„Preset“** mit Bindungen > 0,
   - **keine** Einträge „leer“ und keine „Automatisch zugeordnet“ nötig,
   - mit Perfect Sync: „Perfect Sync: Ja“.
   - Mit den Test-Reglern jeden Ausdruck einmal prüfen.
3. Kalibrieren (`C`), dann Blinzeln, Zwinkern links/rechts, A-I-U-E-O, Lächeln, Brauen hoch testen.
