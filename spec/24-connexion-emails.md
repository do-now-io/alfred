# spec/24 — Connexion e-mails (extraction de tâches & contexte)

> **Statut :** ✅ construit. Post-v1. Pivot de la vision
> « projets unifiés » (ROADMAP Phase G) — **cette spec se limite** à
> l'extraction de tâches + rattachement projet + alimentation du contexte
> (spec/16b). Le chat/RAG croisant mails + notes + tâches par projet est une
> tâche **séparée** ("Projets unifiés", dépend de celle-ci).

## Vue d'ensemble

Alfred se connecte à une boîte mail en **IMAP** (protocole universel, marche
avec Gmail/Outlook/tout fournisseur qui l'expose), scanne une **fenêtre
glissante** de mails récents, et pour chacun :
- **extrait les tâches** détectées → `Todo.md` (spec/06), avec provenance ;
- **détecte le(s) projet(s) concerné(s)** (comme pour une réunion, spec/16b)
  et rattache tâches + faits appris ;
- **alimente le contexte** (global ou projet, mêmes règles que spec/16b).

**Les mails ne deviennent pas des notes du vault** (décision explicite) —
contrairement aux transcriptions. Conséquence directe : le modèle de
provenance des tâches (`source_note`, un wikilink vers une note, spec/06) ne
peut pas s'appliquer tel quel à un mail. Voir §3.

**Tout est automatique, décidé par Claude, sans écran de confirmation** (pas
d'équivalent `/resolve` pour les mails) — cohérent avec la décision de ne pas
ajouter de consentement spécifique au-delà de la connexion du compte
lui-même : se connecter, c'est déjà accepter que le contenu soit traité par
l'IA comme pour un enregistrement.

## 1. Connexion — IMAP

- **Config** (`secrets.json`, même fichier/mécanisme que la clé Anthropic
  perso, spec/00) : `imap_host`, `imap_port`, `imap_username`,
  `imap_password` (mot de passe applicatif recommandé pour Gmail/Outlook —
  documenté dans l'UI de connexion, pas géré programmatiquement), `imap_use_ssl`.
- **UI** : nouvelle section dans Réglages (spec/11) — formulaire de connexion
  IMAP + statut (connecté/erreur) + bouton **déconnecter**.
- **Dossier scanné** : `INBOX` uniquement pour cette v1 de la feature —
  **décision par défaut proposée** (pas plusieurs dossiers/labels
  sélectionnables au départ, pour limiter la complexité ; à rouvrir si le
  signal utile se trouve ailleurs, ex. un dossier "Clients").
- **Crate suggérée** : `async-imap` (ou équivalent Rust mature) + TLS.

## 2. Fenêtre glissante & dédoublonnage

- **Config `email_sync_window_days`** (défaut proposé : 14 jours) : à chaque
  sync, on ne considère que les mails dont la date est dans cette fenêtre —
  pas de scan rétroactif de tout l'historique.
- **Dédoublonnage** : la fenêtre étant glissante, un même mail peut être vu à
  plusieurs syncs successifs tant qu'il reste dans la fenêtre. Table SQLite
  `processed_emails` (état local, cohérent avec le principe "SQLite =
  config/état", spec/00) — clé **`Message-ID`** (header IMAP, stable et
  unique) — marque un mail comme déjà traité, jamais retraité même s'il
  réapparaît dans la fenêtre.
- **Déclencheurs de sync** — **une fois au lancement de l'app** + un
  **bouton "Vérifier les mails"** dans Réglages pour forcer une sync
  immédiate. Pas de polling périodique en arrière-plan (même logique que
  spec/27, cohérence avec l'app qui reste simple).

## 3. Provenance — pas de note, pas de wikilink

`source_note` (spec/06) est un wikilink `[[Titre]]` vers une **note du
vault** — un mail n'en est pas une. Plutôt que de forcer le modèle existant,
on introduit une provenance **non navigable** :

- Nouveau champ de provenance sur la tâche, stocké en texte simple dans
  `Todo.md` (pas un wikilink) : **`✉️ <objet du mail> (<date>)`** — visible,
  identifie la source, mais **non cliquable** (il n'y a rien à ouvrir dans
  le vault). Décision cohérente avec "hors vault" : on n'invente pas une
  fausse note ou un faux lien pour faire semblant.
- Le filtre "par réunion" du Kanban (spec/06, `source_note`) **n'inclut pas**
  les tâches issues de mails dans sa logique de regroupement wikilink — à
  minima, elles n'ont pas d'entrée dans ce filtre (pas de note source à
  lister). **Décision par défaut proposée** : les exclure de ce filtre
  plutôt que de lui ajouter une branche spéciale ; elles restent filtrables
  par **projet** normalement (`+Projet`, inchangé).

## 4. Extraction — un appel Claude **par batch**, pas par mail

Pour limiter le coût (une boîte active peut avoir des dizaines de mails/jour,
la plupart sans tâche) :

- Les mails non traités de la fenêtre sont regroupés en **batchs** (défaut
  proposé : jusqu'à ~15 mails ou un budget de tokens équivalent à ce qui est
  déjà fait pour le glossaire/contexte — à ajuster en test) envoyés en **un
  seul appel Claude par batch**, pas un appel par mail.
- **Schéma de sortie par batch** (tool call, comme `analyze_tool` spec/17) :
  pour chaque mail du batch (identifié par son `Message-ID`) → liste de
  tâches détectées (`title`, `responsable?`, `échéance?`), `projects: string[]`
  (projets concernés, même logique de détection que spec/16b §1),
  `context_additions` (mêmes champs `scope`/`projects` que spec/16b §2 —
  **réutilise exactement le même schéma et les mêmes critères durable/
  ponctuel**, pas de nouvelle logique à inventer).
- **Mails sans rien d'exploitable** (newsletters, notifications, spam,
  échanges sans tâche ni fait) → simplement absents de la sortie structurée,
  aucune trace n'est créée. Pas de pré-filtre par mots-clés/expéditeur avant
  l'appel IA pour cette v1 — le tri se fait **dans** l'appel Claude, pas
  avant (plus simple, le batching limite déjà le coût).
- **Écriture** : comme pour l'ingestion (spec/05), tâches → `Todo.md` avec la
  provenance §3 + marqueur `+Projet` ; `context_additions` → routées vers le
  contexte global ou la note de projet exactement comme spec/16b (même
  fonction d'écriture, réutilisée telle quelle).
- **Marquer les mails du batch comme traités** (`processed_emails`) **après**
  écriture réussie — pas avant, pour pouvoir retraiter en cas d'échec de
  l'appel IA.

## 5. Ce que cette spec NE couvre PAS (hors scope explicite)

- **Chat/RAG croisant mails + notes + tâches par projet** ("Projets unifiés",
  tâche séparée du ROADMAP Phase G, dépend de celle-ci).
- **Multi-comptes e-mail** — un seul compte IMAP configuré à la fois.
- **Pièces jointes** — ignorées (corps du mail uniquement).
- **Écriture/réponse aux mails** — lecture seule, jamais d'action sortante.
- **Fournisseurs OAuth dédiés** (Gmail API, Microsoft Graph) — IMAP générique
  uniquement pour cette v1 (décision : IMAP couvre déjà Gmail/Outlook/autres
  sans code spécifique par fournisseur).

## Commandes Tauri à créer

| Commande | Rôle |
|---|---|
| `connect_imap_account(host, port, username, password, use_ssl)` | teste la connexion, stocke en `secrets.json` |
| `disconnect_imap_account()` | retire les credentials |
| `get_imap_status() -> {connected, last_synced_at}` | statut pour Réglages |
| `sync_emails()` | fenêtre glissante + dédoublonnage + batchs Claude + écriture (Todo.md + contexte) — appelée au démarrage et par le bouton manuel |

## Migration SQLite

Nouvelle table `processed_emails (message_id TEXT PRIMARY KEY, processed_at TEXT)`.
