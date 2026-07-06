# spec/08 — Suggestions Engine

> ⛔ **HORS V1 — reporté.** Le moteur de suggestions proactives est hors
> périmètre v1 (il dépendait du calendrier, lui-même retiré). Contenu conservé
> comme référence pour une phase future. Voir `spec/README.md`.

---

## Vue d'ensemble

Le moteur de suggestions détecte proactivement des actions à faire, basées sur le calendrier et les transcriptions. Il fonctionne en deux étapes :

1. **Règles heuristiques** (Rust pur, pas d'API) : filtrent les événements candidats
2. **Claude** (API) : enrichit et valide les suggestions pour les événements retenus

Claude n'est appelé que si au moins une règle heuristique se déclenche — économie de tokens.

---

## Déclencheurs

Le moteur s'exécute automatiquement :
- Après chaque sync calendrier complète (`calendar-synced`)
- Après chaque transcription complète (`transcription-complete`)
- Au lancement de l'application

---

## Règles heuristiques

### `LUNCH_DINNER_NO_LOCATION`

**Condition :**
- Titre de l'événement contient : `lunch`, `dinner`, `déjeuner`, `dîner`, `repas`, `restaurant` (insensible à la casse)
- ET le champ `location` est vide ou ne contient pas de nom de lieu plausible (< 5 caractères ou seulement des chiffres)
- ET l'événement est dans les 7 prochains jours
- ET aucune suggestion `restaurant_booking` n'existe déjà pour cet `calendar_event_id`

**Action générée :** suggestion de type `restaurant_booking`

### `TRAVEL_NO_TRANSPORT`

**Condition :**
- Titre ou description contient : `flight`, `train`, `voyage`, `déplacement`, `départ`, `arrivée`, `TGV`, `Eurostar`
- ET aucun todo ne contient `billet`, `réserv`, `booking`, `transport` parmi les todos liés à cet event
- ET l'événement est dans les 14 prochains jours
- ET aucune suggestion `transport_check` n'existe déjà pour cet `calendar_event_id`

**Action générée :** suggestion de type `transport_check`

### `NEW_CONTACT_FOLLOW_UP` (depuis transcription)

**Condition :**
- La transcription contient des patterns comme : `rappeler [Prénom]`, `follow up [Name]`, `recontacter`, `envoyer un mail à`
- ET le nom détecté (heuristique simple : mot en majuscule après les patterns) n'est pas déjà dans un todo existant

**Action générée :** suggestion de type `follow_up`

---

## Payload par type (voir aussi spec/01)

### `restaurant_booking`

Le payload doit inclure un numéro de téléphone pour que l'appel Vapi soit possible. Ce numéro est résolu via **Google Places API** au moment de la génération :

```
POST https://maps.googleapis.com/maps/api/place/findplacefromtext/json
  ?input={nom du restaurant suggéré par Claude + ville}
  &inputtype=textquery
  &fields=name,formatted_address,formatted_phone_number,place_id
  &key={GOOGLE_PLACES_API_KEY}
```

La clé Google Places API est stockée dans Keychain (`google_places_api_key`).

Si la résolution échoue (restaurant non trouvé, pas de téléphone), le payload contient `phone_number: null`. La suggestion est quand même créée mais le bouton "Appeler" est désactivé dans l'UI — l'utilisateur peut entrer le numéro manuellement.

### Format complet du payload

Voir spec/01 pour les structures JSON.

---

## Lifecycle des suggestions

```
pending ──── accept() ──► accepted
   │
   └───────── dismiss() ──► dismissed
```

**Règle de non-réapparition :** Une suggestion `dismissed` pour un `(type, calendar_event_id)` ne réapparaît jamais, même après une nouvelle sync. Vérification à la création :

```sql
SELECT id FROM suggestions
WHERE type = ? AND calendar_event_id = ? AND status = 'dismissed'
LIMIT 1;
```

Si un tel record existe → ne pas créer de nouvelle suggestion.

---

## Affichage dans le dashboard

Les suggestions de type `pending` sont affichées dans la colonne centrale du dashboard, sous la synthèse hebdomadaire.

Chaque suggestion affiche :
- Une icône selon le type (🍽️ restaurant, ✈️ transport, 👤 suivi)
- Un texte descriptif
- Deux boutons : **Accepter** / **Ignorer**

Accepter une suggestion `restaurant_booking` ouvre l'écran de confirmation d'appel (spec/09).

---

## Commandes Tauri

```rust
#[tauri::command]
async fn list_suggestions(
    status: Option<String>,  // "pending" | "accepted" | "dismissed" | null (tous)
    state: State<AppState>,
) -> Result<Vec<Suggestion>, String>

#[tauri::command]
async fn dismiss_suggestion(id: String, state: State<AppState>) -> Result<(), String>

#[tauri::command]
async fn accept_suggestion(id: String, state: State<AppState>) -> Result<(), String>

#[tauri::command]
async fn run_suggestions_engine(state: State<AppState>) -> Result<Vec<Suggestion>, String>
```

### Événement

```
"suggestion-ready" → { suggestion_id: string, type: string }
```
