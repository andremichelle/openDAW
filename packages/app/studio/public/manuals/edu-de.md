# openDAW

openDAW ist eine browserbasierte Digital Audio Workstation, die mit klarem Fokus auf Bildung, Datenschutz und Offenheit
entwickelt wurde.
Sie ermöglicht professionelle Musikproduktion im Unterricht ohne Account, ohne Registrierung, ohne Tracking und ohne
Abhängigkeit von kommerziellen Plattformen.

---

![studio.png](../images/studio.png)

---

## Was ist openDAW?

### Open-Source Musikproduktion für Bildungseinrichtungen

openDAW ist Open Source und kann vollständig unter eigener Kontrolle betrieben werden. Damit eignet sich die Plattform
besonders für Musikschulen, Verbände und öffentliche Bildungsträger, die Wert auf Datenschutz, Nachhaltigkeit und
technische Souveränität legen.

### Pädagogische Kernfeatures von openDAW

openDAW wurde so gestaltet, dass musikalische Konzepte sichtbar, hörbar und nachvollziehbar werden. Die
Benutzeroberfläche und Arbeitsweise orientieren sich an etablierten Standards professioneller DAWs. Konzepte wie
Timeline, Mixer, Routing, Automation und MIDI-Editing sind universell übertragbar. Wer openDAW erlernt, kann später
problemlos auf andere Software wie Ableton Live, Logic Pro oder Cubase umsteigen.

### Open Source, Datenschutz und Kontrolle

* Open Source [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html), Quellcode vollständig einsehbar und auditierbar
* Keine Benutzerkonten erforderlich
* Keine personenbezogenen Daten
* Keine Tracking- oder Analyse-Dienste
* Betrieb unter eigener Infrastruktur möglich

### Projektbasiertes Arbeiten

* Musik entsteht in klar abgegrenzten Projekten
* Projekte lassen sich speichern, teilen und weiterentwickeln
* Live-Kollaboration möglich
* Ideal für Aufgaben, Workshops und Gruppenarbeit

### Audio- und MIDI-Aufnahme

openDAW unterstützt die Aufnahme von Audio und MIDI direkt im Browser:

* Aufnahme von Mikrofon, Line-In oder anderen Audio-Eingängen
* MIDI-Aufnahme von externen Keyboards und Controllern
* Mehrspuraufnahme: Gleichzeitige Aufnahme mehrerer Eingänge möglich

### Keine Ablenkung durch soziale oder kommerzielle Mechaniken

* Keine Social-Feeds
* Keine Likes, Rankings oder Veröffentlichungszwang
* Kein Gamification-Druck

---

### Vergleichstabelle zu anderer Musikproduktions-Software

| Kriterium                                          | openDAW | BandLab | Soundtrap | Ableton Live |
|----------------------------------------------------|---------|---------|-----------|--------------|
| Einstieg ohne Account möglich                      | ✓       | –       | –         | –            |
| Sofort arbeitsfähig im Browser                     | ✓       | ✓       | ✓         | –            |
| Keine personenbezogenen Daten nötig                | ✓       | –       | –         | △            |
| DSGVO-freundlich im Unterricht einsetzbar          | ✓       | △       | –         | △            |
| Volle Datensouveränität                            | ✓       | –       | –         | ✓            |
| Open Source                                        | ✓       | –       | –         | –            |
| Self-hosting möglich                               | ✓       | –       | –         | –            |
| Integration in bestehende Systeme (z.B. Nextcloud) | ✓       | –       | –         | –            |
| Keine Installation oder Lizenzverwaltung           | ✓       | –       | –         | –            |
| Plattformunabhängig (Browser)                      | ✓       | ✓       | ✓         | –            |
| Für Bildungsarbeit konzipiert                      | ✓       | △       | △         | –            |

### Legende

* ✓ = voll erfüllt
* △ = eingeschränkt / abhängig vom Setup
* – = nicht vorgesehen

---

## Technische Voraussetzungen

### Browser-Unterstützung

openDAW läuft in allen modernen Browsern. Es gibt jedoch Unterschiede in der Unterstützung einzelner Web-APIs:

| Funktion             | Chrome | Firefox | Safari |
|----------------------|--------|---------|--------|
| Audio-Ausgang wählen | ✓      | –       | –      |
| MIDI-Geräte          | ✓      | ✓       | –      |
| Dateisystem (OPFS)   | ✓      | △       | △      |

Chrome bietet die umfassendste Unterstützung und wird für den Einsatz im Unterricht empfohlen.

### iPad-Unterstützung

openDAW läuft auch auf dem iPad (Safari). Für eine präzise Bedienung wird eine angeschlossene Maus oder ein Trackpad
empfohlen.

### Datenspeicherung

Projekte und Samples werden lokal im Browser gespeichert (Origin Private File System). Es werden keine Daten auf externe
Server übertragen. Die Daten verbleiben vollständig auf dem Gerät des Nutzers.

## Einsatz im Unterricht

### Sofort einsatzbereit

openDAW kann direkt unter [opendaw.studio](https://opendaw.studio) genutzt werden. Es ist keine Installation, keine
Registrierung und keine Konfiguration erforderlich. Lernende können sofort mit der Musikproduktion beginnen.

### Self-Hosting

Für Einrichtungen mit besonderen Anforderungen an Datenschutz oder Netzwerkinfrastruktur kann openDAW auf eigenen
Servern betrieben werden. Der vollständige Quellcode ist auf GitHub verfügbar.

## Angebot für Bildungseinrichtungen

Wir bieten Schulungen und Unterstützung bei der Servereinrichtung an. Für die Nutzung von openDAW im institutionellen Rahmen fällt eine faire Lizenzgebühr an.

### Kontakt

Für Fragen, Feedback oder Kooperationsanfragen:

* Homepage: [opendaw.org](https://opendaw.org)
* Discord: [discord.opendaw.studio](https://discord.opendaw.studio)
* GitHub: [github.com/andremichelle/opendaw](https://github.com/andremichelle/opendaw)
* E-Mail: [andre.michelle@opendaw.org](mailto:andre.michelle@opendaw.org)