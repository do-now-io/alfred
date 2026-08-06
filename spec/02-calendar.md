# spec/02 — Calendar Integration (Google uniquement)

> **Statut :** 📝 spec réécrite (rouverte), rien de codé. Post-v1, ROADMAP
> Phase G. **Google Calendar uniquement** — Apple Calendar est explicitement
> **hors scope** de cette réouverture (voir §0). Contexte **actif** : le
> calendrier n'est pas qu'un affichage, il nourrit la détection de projet
> (spec/16b), le brief quotidien (spec/05) et le chat (spec/07b/22).

## §0 — Pourquoi Google seul, et pas Apple Calendar

L'ancienne version de cette spec couvrait Google **et** Apple Calendar (via
AppleScript). **Apple Calendar est retiré de cette réouverture** :

- L'entitlement macOS `com.apple.security.automation.apple-events` (et
  `NSAppleEventsUsageDescription`) qu'il nécessite a été **explicitement
  retiré** du packaging v1 (spec/12, durcissement du périmètre de
  permissions pour la distribution). Le rouvrir pour Apple Calendar
  annulerait ce durcissement — pas fait ici.
- Google Calendar seul couvre déjà l'usage principal, sans ce compromis, et
  sans le parsing AppleScript (fragile, macOS uniquement).

**Windows n'a jamais eu d'équivalent Apple Calendar** — Google Calendar
couvre donc les deux OS de façon uniforme, ce qu'Apple Calendar ne faisait
pas.

## Vue d'ensemble

Une source de calendrier : **Google Calendar**, via REST API + OAuth2. Sync
**pull-based** (Alfred interroge Google, pas de webhook). Les événements sont
mis en cache dans une table SQLite locale (état/cache, pas du contenu vault —
cohérent avec spec/00 : le vault reste la source de vérité du contenu
*produit* par l'utilisateur, le calendrier est une donnée *externe* mise en
cache).

## §1 — OAuth Google (repris de l'ancienne version, inchangé)

### Prérequis — Google Cloud Console

1. Projet Google Cloud (celui d'Alfred/DoNow) ; API **Google Calendar API**
   activée.
2. Identifiants OAuth 2.0 type **"Desktop application"** — autorise
   `http://127.0.0.1` en redirect URI sans enregistrement explicite du port
   (RFC 8252, exception loopback de Google).
3. Client ID + Client Secret **embarqués à la compilation** (même mécanisme
   que la clé anti-spam metrics, `option_env!` + secret CI — pas dans le
   code source). Un client "Desktop application" est un **client public** :
   Google ne traite pas son secret comme confidentiel (documentation
   officielle), l'embarquer dans le binaire distribué est la pratique
   attendue pour ce type de client.

> **Publication du client OAuth — décision par défaut proposée.** Le scope
> `calendar.readonly` est un "scope sensible" chez Google : le mettre en
> production déclenche une **vérification Google** (revue manuelle, délais
> de plusieurs semaines, exigences supplémentaires). Pour ~10 utilisateurs
> test, garder le client Google Cloud en statut **"Testing"** (limite ~100
> comptes test, ajoutés explicitement par email dans la console) **évite
> complètement cette vérification** — chaque testeur voit un écran de
> consentement "app non vérifiée" à la 1ʳᵉ connexion (avertissement, pas un
> blocage), acceptable à cette échelle. Passer en publication réelle sera à
> reconsidérer si Alfred dépasse ~100 utilisateurs connectés à Google.

### Flow (inchangé par rapport à l'ancienne version)

```
1. Réglages → "Connecter Google Calendar"
2. Rust ouvre un serveur HTTP local sur port 0 (OS choisit le port)
3. Ouverture navigateur système sur l'URL d'autorisation Google
   (scope: https://www.googleapis.com/auth/calendar.readonly, access_type=offline)
4. Callback sur le serveur local → récupère `code`
5. Échange `code` → { access_token, refresh_token, expires_in }
6. Stockage dans secrets.json (même mécanisme que la clé Anthropic perso,
   spec/00 keychain.rs) : access_token, refresh_token, expires_at
7. Fermeture du serveur local (ou timeout 5 min)
```

### Refresh automatique

Avant chaque appel API : si `expires_at - now < 5 min`, refresh via
`refresh_token` (`POST https://oauth2.googleapis.com/token`,
`grant_type=refresh_token`).

## §2 — Sync

- **Déclencheurs : au lancement de l'app + toutes les 15 minutes**
  (`tokio::time::interval`, décision actée — pas la même logique
  "démarrage + bouton manuel" que spec/24/27, le calendrier a besoin d'être
  plus frais qu'une boîte mail : événements qui bougent en cours de
  journée) + bouton manuel "Synchroniser" dans Réglages.
- **Fenêtre récupérée** : aujourd'hui → +7 jours (comme l'ancienne version),
  `GET .../calendars/primary/events?timeMin=...&timeMax=...&singleEvents=true&orderBy=startTime`,
  pagination via `nextPageToken`.
- **Cache SQLite** — nouvelle table `calendar_events` (recréée, migration
  dédiée ; l'ancienne a été droppée en Phase D) : upsert par
  `(source='google', external_id)`. Champs : `title`, `start_at`, `end_at`,
  `location`, `description`, `attendees` (JSON), `all_day`.
- **Comportement au sleep** : si l'OS suspend l'app, l'intervalle se
  déclenche au réveil plutôt qu'à l'heure exacte — acceptable, pas de
  rattrapage.

## §3 — Contexte actif (le vrai objectif de cette réouverture)

Le calendrier ne se contente pas d'être affiché — il **aide activement** :

### a) Nouvel écran "Agenda"

Nouvel onglet de navigation (§4) : liste des événements du jour + de la
semaine (titre, heure, participants, lieu). Lecture seule — pas de création/
modification d'événement depuis Alfred.

**Échéances des tâches (`Todo.md`, spec/06) affichées dans le même écran** —
constat post-implémentation : un utilisateur qui pose une échéance (`📅`) sur
une tâche ne la voyait nulle part dans l'Agenda, alors que c'est la même
notion de "chose à ce moment-là" que les événements calendrier. Les tâches
**en attente** (`get_todos` — non cochées, hors `Archivé`) avec une `echeance`
tombant dans la période affichée (jour ou semaine) sont mêlées aux
événements, visuellement distinguées (icône tâche vs événement) — sans
horaire précis (juste une date), elles s'affichent en tête de journée plutôt
qu'à une heure donnée. Clic → écran Tâches. Toujours lecture seule côté
calendrier ; **aucune donnée n'est écrite dans `calendar_events`** — c'est un
assemblage à l'affichage (front), pas une fusion de sources en base.

### b) Brief quotidien enrichi (spec/05)

`generate_daily_brief` gagne une section **Agenda** : nombre de réunions du
jour + liste (titre + heure), dans le même style que le reste du brief.
Simple ajout de données au prompt existant, pas de nouvelle logique IA.

### c) Indice de détection de projet (spec/16b, spec/17 §3)

Au moment de l'**analyse** d'une transcription (`analyze_transcription`), si
un événement du calendrier **chevauche la fenêtre de l'enregistrement**
(commencé avant/pendant, pas fini depuis trop longtemps — tolérance ±15 min
proposée par défaut), son **titre + participants** sont ajoutés au prompt
comme **indice supplémentaire** pour `projects_detected` — ça n'ajoute pas
un nouveau champ, ça enrichit l'entrée du même mécanisme déjà construit pour
spec/16b (aucun changement de schéma de sortie).

### d) Nouvel outil de lecture dans le chat agentique (spec/07b/22)

Nouvel outil **read-only** (même famille que les 15 outils de spec/22, mais
lecture, pas mutation) : `get_calendar_events(period: "today"|"week")` →
permet à Alfred de répondre à « qu'est-ce que j'ai aujourd'hui/cette
semaine ? » en chat.

## §4 — UI

- **Nouvel onglet de navigation "Agenda"** (nav réduite, spec/10 — à
  réintroduire spécifiquement pour cette feature, contrairement au reste de
  la nav qui a été volontairement simplifiée en Phase D).
- **Réglages** (spec/11) : section "Connecter Google Calendar" (statut
  connecté/déconnecté, bouton connecter/déconnecter, bouton "Synchroniser
  maintenant").

## Commandes Tauri

| Commande | Rôle |
|---|---|
| `start_google_oauth()` | lance le flow §1 |
| `disconnect_google_calendar()` | retire les tokens de `secrets.json` |
| `get_calendar_auth_status() -> {connected}` | statut Réglages |
| `trigger_calendar_sync()` | sync manuelle (bouton) |
| `get_today_events()` / `get_week_events()` | pour l'écran Agenda + le brief |

### Événement émis après sync

`"calendar-synced" → { event_count, synced_at }`

## Migration SQLite

Nouvelle table `calendar_events` (recréée — l'ancienne a été droppée
Phase D, migration 008).

## Hors scope (explicite)

- **Apple Calendar** (voir §0).
- **Écriture/création d'événements** — lecture seule.
- **Publication du client OAuth en production** (vérification Google) — on
  reste en mode "Testing" tant que ~10 utilisateurs (§1).
