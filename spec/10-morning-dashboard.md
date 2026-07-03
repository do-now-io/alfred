# spec/10 — Morning Dashboard & UI

> **Design de référence** : `spec/Images/page-accueil.png`

---

## Stack frontend

| Technologie | Usage |
|---|---|
| React 18 + TypeScript 5 | Framework UI |
| Zustand | State management (stores par domaine) |
| Tailwind CSS v4 | Styling |
| CodeMirror 6 | Éditeur Markdown dans Notes |
| `@tauri-apps/api` | IPC avec le backend Rust |

---

## Layout général

```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌──────┬──────────────────────────────────────────────────────────┐ │
│  │      │  🔍 Rechercher dans mes notes, réunions, tâches...  ⌘K   │ │
│  │      └─────────────────────────────────────────────────────┬────┘ │
│  │ Side │                                              🔔  👤 Alfred│ │
│  │ bar  ├──────────────────────────────┬──────────────────────┤      │
│  │ 240px│     Contenu principal        │  Panel droit 280px   │      │
│  │      │                              │                      │      │
│  └──────┴──────────────────────────────┴──────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

3 zones :
- **Sidebar gauche** : 240px fixe, navigation + récents
- **Contenu principal** : flex 1, scrollable
- **Panel droit** : 280px fixe, calendrier de la semaine

Pas de barre de recording en bas — l'enregistrement est déclenché via la hero card CTA.

---

## Topbar

Barre persistante en haut du contenu (hors sidebar) :

- **Champ de recherche** globale (centré, flex 1) : placeholder "Rechercher dans mes notes, réunions, tâches..." + raccourci `⌘K`
- **Icône notification** (cloche) à droite
- **Avatar + nom + chevron** à droite (menu déroulant profil)

---

## Sidebar gauche (240px)

### Logo
- Portrait circulaire (style gravure dorée sur fond sombre)
- Texte "**A L F R E D**" en lettres espacées sous le logo

### Navigation principale
Icône + label texte, item actif = fond beige doré (`--active-bg`).

| Icône | Label | Route |
|---|---|---|
| 🏠 | Aujourd'hui | `/` |
| ☑️ | Tâches | `/tasks` |
| 📝 | Notes | `/notes` |
| 🎙️ | Réunions | `/meetings` |
| 📅 | Calendrier | `/calendar` |
| ✦ | Actions IA | `/ai-actions` |

### Section "RÉCENTS"
Label "RÉCENTS" en petites majuscules, couleur secondaire.
Liste des 5 derniers items récemment consultés (notes, réunions, tâches).
Un item peut avoir un indicateur actif (point orange = en cours).

### Bas de sidebar
- ⚙️ Paramètres (lien, en bas, épinglé)

---

## Dashboard — Contenu principal

### 1. Hero card CTA — Enregistrement

Card sombre (fond `#1C1C1C`, coins arrondis 16px) pleine largeur :
- Icône microphone dorée (grand, ~48px) à gauche
- Texte principal : **"Prendre des notes maintenant"** (doré, `font-size: 20px`, `font-weight: 600`)
- Sous-texte : "Enregistre, transcrit et extrait les actions" (gris clair)
- Flèche `→` à droite
- Clic → déclenche `start_recording()` ou navigue vers la vue enregistrement

**États de la hero card :**
- Idle : affichage normal comme ci-dessus
- Recording : fond rouge foncé, texte "Enregistrement en cours…", timer, bouton ⏹ Arrêter
- Processing : "Transcription en cours…" avec spinner

### 2. Section "Ce qui mérite votre attention"

Titre `h2` : **"Ce qui mérite votre attention"**

Liste de tâches prioritaires (max 4 affichées, style liste) :

Chaque ligne :
```
[ ] Titre de la tâche          [Tag coloré]    Heure    🚩
```

- **Checkbox** à gauche (cocher = marquer done)
- **Titre** (texte normal)
- **Badge tag** coloré (fond pastel + texte coloré) — catégorie ou contexte
- **Heure** ou date relative ("Hier", "10:00", etc.)
- **Icône drapeau** (🚩 = flaggé, outline = non flaggé)

Lien en bas : `Afficher tout (N) →` en couleur accent doré.

### 3. Section "Résumé IA"

En dessous de la liste tâches, carte avec :
- Icône ✦ + titre **"Résumé IA"**
- Colonne gauche : résumé textuel court ("Vous avez 4 tâches en attente. 2 réunions prévues aujourd'hui.")
- Colonne droite : dernière réunion avec ses action items (checklist ✓)
- Généré automatiquement au lancement, régénérable manuellement

---

## Panel droit — "Cette semaine" (280px)

### En-tête
- Titre **"Cette semaine"** (accent doré)
- Icône calendrier à droite

### Événements groupés par jour

```
Aujourd'hui – 21 mai
  ● 14:00  Réunion client - Acme
           Salle Meeting Room 2

  ● 16:30  Point équipe produit
           Visio

Demain – 22 mai
  ● 09:00  Webinar AWS
           En ligne
  ...
```

- Séparateur de section par jour (texte bold + date)
- Chaque événement : dot coloré + heure + titre + lieu (grisé en dessous)
- **Couleur des dots** : orange/ambre = présentiel, violet = en ligne
- Scroll vertical si débordement

### Pied de panel
Lien `Afficher le calendrier complet →` en accent doré

---

## Design language & palette

```css
/* Couleurs principales */
--accent: #C8914A;          /* Doré/ambre — logo, liens, icônes actives */
--accent-hover: #B07D3A;
--active-bg: #F5EDD8;       /* Fond item nav actif — beige chaud */
--bg: #F7F7F5;              /* Fond général — blanc cassé */
--card-bg: #FFFFFF;         /* Fond des cartes */
--sidebar-bg: #FFFFFF;      /* Fond sidebar */
--dark-card: #1C1C1C;       /* Hero card sombre */
--text-primary: #1A1A1A;
--text-secondary: #6B6B6B;
--text-muted: #9B9B9B;
--border: #E8E8E6;

/* Tags / badges */
--tag-red-bg: #FEE8E8;    --tag-red-text: #C0392B;   /* Priorité haute */
--tag-blue-bg: #E8F0FE;   --tag-blue-text: #1A56DB;  /* Contexte bleu */
--tag-orange-bg: #FEF3E2; --tag-orange-text: #D97706; /* Finance */
--tag-green-bg: #E8F5E9;  --tag-green-text: #2E7D32; /* Contexte vert */

/* Dots calendrier */
--dot-orange: #F59E0B;   /* Présentiel */
--dot-purple: #7C3AED;   /* En ligne */

/* Police */
font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
```

---

## Stores Zustand

```typescript
// Inchangés par rapport à spec/00 + ajouts :

// stores/uiStore.ts
interface UiStore {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  recentItems: RecentItem[];  // { id, title, type, route }
}
```

---

## Abonnements aux événements Tauri

Initialisés au montage de `App.tsx` :
- `recording-status-changed` → met à jour l'état de la hero card
- `transcription-complete` → rafraîchit todos + résumé IA
- `calendar-synced` → rafraîchit le panel droit

---

## Écrans secondaires (à designer)

| Route | Écran | Statut |
|---|---|---|
| `/tasks` | Tâches | À designer |
| `/notes` | Notes (CodeMirror) | Implémenté v1, à restyler |
| `/meetings` | Réunions + transcriptions | À designer |
| `/calendar` | Vue calendrier complète | À designer |
| `/ai-actions` | Actions IA / suggestions | À designer |
| `/settings` | Paramètres | Implémenté v1, à restyler |
