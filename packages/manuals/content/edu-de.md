# openDAW

openDAW ist eine browserbasierte Digital Audio Workstation, die mit klarem Fokus auf Bildung, Datenschutz und Offenheit
entwickelt wurde.
Sie ermöglicht **DSGVO-konforme** Musikproduktion im Unterricht – ohne Account, ohne Registrierung, ohne Tracking und
ohne Abhängigkeit von kommerziellen Plattformen.

---

![studio.png](../images/studio.png)

---

## Was ist openDAW?

### Open-Source Musikproduktion für Bildungseinrichtungen

openDAW ist Open Source und kann vollständig unter eigener Kontrolle betrieben werden. Damit eignet sich die Plattform
besonders für Musikschulen, Verbände und öffentliche Bildungsträger, die Wert auf Datenschutz, Nachhaltigkeit und
technische Souveränität legen.

### Pädagogische Kernfeatures von openDAW

Die Benutzeroberfläche und Arbeitsweise orientieren sich an etablierten Standards professioneller DAWs. Konzepte wie
Timeline, Mixer, Routing, Automation und MIDI-Editing sind universell übertragbar. Wer openDAW erlernt, kann später
problemlos auf andere Software wie Ableton Live, Logic Pro oder Cubase umsteigen.

### DSGVO-konform und datenschutzfreundlich

* **DSGVO-konform**: Keine Erhebung personenbezogener Daten, keine Benutzerkonten, kein Tracking
* Open Source [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html), Quellcode vollständig einsehbar und auditierbar
* Keine Registrierung erforderlich
* Keine Tracking- oder Analyse-Dienste
* Betrieb unter eigener Infrastruktur möglich

### Projektbasiertes Arbeiten

* Musik entsteht in klar abgegrenzten Projekten
* Projekte lassen sich speichern, teilen und weiterentwickeln
* Live-Kollaboration möglich
* Ideal für Aufgaben, Workshops und Gruppenarbeit

### Neue Möglichkeiten jenseits klassischer DAWs

openDAW eröffnet als browserbasierte Plattform Anwendungsfälle, die mit herkömmlicher Desktop-Software nicht oder nur
schwer umsetzbar sind:

#### Onlineunterricht und Fernlehre

* Songwriting-Sessions im Videocall: Lehrkraft und Schüler arbeiten gemeinsam am selben Projekt
* Hausaufgaben und Übungen können als Projektdatei ausgetauscht werden
* Kein Software-Setup auf Schülerseite erforderlich – nur ein Browser

#### Kooperationen zwischen Musikschulen

* Musikschulen können projektweise zusammenarbeiten, ohne IT-Hürden
* Gemeinsame Workshops oder Wettbewerbe über Standorte hinweg
* Einfacher Projektaustausch ohne Kompatibilitätsprobleme

#### Internationale Projekte

* Projekte mit der Musikschule der Partnerstadt
* Länderübergreifende Kompositionsprojekte
* Kultureller Austausch durch gemeinsames Musizieren

#### Inklusion und Barrierefreiheit

* Kein teures Equipment nötig
* Zugang über Schulcomputer, Tablets oder private Geräte
* Gleiche Voraussetzungen für alle Teilnehmenden

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
| DSGVO-konform im Unterricht einsetzbar             | ✓       | △       | –         | △            |
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

### Kostenlose Nutzung

openDAW ist für die allgemeine Nutzung kostenlos verfügbar. Einzelpersonen, Lehrende und Lernende können die Plattform
unter [opendaw.studio](https://opendaw.studio) ohne Einschränkungen nutzen.

### Institutionelle Lizenz

Für Musikschulen, Bildungsträger und Verbände bieten wir ein faires Lizenzmodell an. Die Lizenzgebühren fließen
vollständig in die Weiterentwicklung von openDAW und sichern die langfristige Verfügbarkeit der Plattform.

Das institutionelle Angebot umfasst:

* Nutzung im gesamten Einrichtungsbetrieb
* Schulungen für Lehrkräfte
* Unterstützung bei der Servereinrichtung (Self-Hosting)
* Priorisierter Support

Sprechen Sie uns an für ein individuelles Angebot, das zu Ihrer Einrichtung passt.

### Kontakt

Für Fragen, Feedback oder Kooperationsanfragen:

* Homepage: [opendaw.org](https://opendaw.org)
* Discord: [discord.opendaw.studio](https://discord.opendaw.studio)
* GitHub: [github.com/andremichelle/opendaw](https://github.com/andremichelle/opendaw)
* E-Mail: [andre.michelle@opendaw.org](mailto:andre.michelle@opendaw.org)