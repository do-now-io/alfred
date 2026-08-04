# spec/24 — Connexion e-mails (extraction de tâches & contexte)

> **Statut :** 🚧 partiellement construit. Connexion IMAP + extraction
> batchée **construites** (§1-4 ci-dessous, inchangées). **Extension écrite,
> rien de codé pour les nouvelles parties** : §5 écran de validation
> (revient sur "tout automatique sans confirmation") et §6 Q&A sur les mails
> en chat. Post-v1. Pivot de la vision « projets unifiés » (ROADMAP Phase G).

## Vue d'ensemble

Alfred se connecte à une boîte mail en **IMAP** (protocole universel), scanne
une **fenêtre glissante** de mails récents, et pour chacun :
- **propose des tâches** détectées → validées puis écrites dans `Todo.md`
  (spec/06), avec provenance (§5 — **revient sur** l'automatisation totale) ;
- **détecte le(s) projet(s) concerné(s)** (comme pour une réunion, spec/16b)
  et rattache tâches + faits appris ;
- **propose des faits de contexte** (global ou projet, mêmes règles que
  spec/16b) — également soumis à validation (§5).

**Les mails ne deviennent pas des notes du vault** (décision explicite) —
contrairement aux transcriptions. Conséquence directe : le modèle de
provenance des tâches (`source_note`, un wikilink vers une note, spec/06) ne
peut pas s'appliquer tel quel à un mail. Voir §3.

> **⚠️ Révision (retour utilisateur) : plus "tout automatique".** La version
> initiale de cette spec écrivait tâches et faits de contexte **directement**,
> sans confirmation ("se connecter = consentement suffisant"). Retour :
> l'utilisateur veut **valider** chaque proposition avant qu'elle n'atterrisse
> dans `Todo.md`/le contexte — comme `/resolve` pour les réunions (spec/17),
> mais pour les mails. Voir §5, qui **remplace** ce comportement.

## 1. Connexion — IMAP

- **Config** (`secrets.json`, même fichier/mécanisme que la clé Anthropic
  perso, spec/00) : `imap_host`, `imap_port`, `imap_username`,
  `imap_password`, `imap_use_ssl`.
- **Dossier scanné** : `INBOX` uniquement pour cette v1 de la feature —
  **décision par défaut proposée** (pas plusieurs dossiers/labels
  sélectionnables au départ, pour limiter la complexité ; à rouvrir si le
  signal utile se trouve ailleurs, ex. un dossier "Clients").
- **Crate suggérée** : `async-imap` (ou équivalent Rust mature) + TLS.

### 1.1 Révision UI — sélection du fournisseur d'abord (retour utilisateur)

> **Constat** : demander directement host/port/username/password (formulaire
> IMAP générique) n'est pas clair pour l'utilisateur — il ne sait pas où
> trouver ces informations ni ce qu'est un "mot de passe d'application".
> **Nouvelle UI en 2 étapes.**

**Étape 1 — Choisir le fournisseur** (Réglages → Connexion e-mails) :
cartes/boutons **Gmail**, **iCloud Mail**, **Yahoo Mail**, **Autre serveur
IMAP**. Le choix détermine `imap_host`/`imap_port`/`imap_use_ssl`
**automatiquement** (tableau ci-dessous) — l'utilisateur n'a **plus à les
connaître ni les saisir** pour les 3 fournisseurs reconnus.

| Fournisseur | `imap_host` | `imap_port` | `imap_use_ssl` |
|---|---|---|---|
| Gmail | `imap.gmail.com` | 993 | `true` |
| iCloud Mail | `imap.mail.me.com` | 993 | `true` |
| Yahoo Mail | `imap.mail.yahoo.com` | 993 | `true` |
| Autre (générique) | *saisi par l'utilisateur* | *saisi* | *saisi* |

> **⚠️ Outlook / Microsoft 365 volontairement absent du sélecteur.**
> Microsoft a désactivé l'authentification "basique" IMAP pour la quasi
> totalité des comptes (depuis 2023) et **les mots de passe d'application
> cessent de fonctionner** (retrait complet, plus de génération possible)
> au **30 avril 2026** — seule l'authentification **OAuth2** reste
> possible, explicitement **hors scope** de cette spec (§7, "pas de
> fournisseurs OAuth dédiés"). Proposer Outlook mènerait à une impasse ; à
> reconsidérer uniquement si un chantier OAuth dédié est fait un jour
> (rupture du modèle "IMAP générique uniquement" de cette spec).

**Étape 2 — Écran de configuration guidé, spécifique au fournisseur choisi**
(pas un simple formulaire — des instructions numérotées avec des liens
directs, ouverts dans le navigateur système comme les autres liens externes
de l'app, ex. le portail Stripe/AlfredIA, `tauri_plugin_opener`) :

**Gmail** :
1. Vérifier que la **double authentification** est activée → [myaccount.google.com/security](https://myaccount.google.com/security)
2. Générer un **mot de passe d'application** → [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (nécessite l'étape 1)
3. Coller l'adresse e-mail + le mot de passe généré (16 caractères) dans les 2 champs ci-dessous.

**iCloud Mail** :
1. Ouvrir [appleid.apple.com](https://appleid.apple.com) → section "Connexion et sécurité" → "Mots de passe pour application"
2. Générer un mot de passe pour application (nécessite la double authentification, déjà obligatoire sur un compte Apple récent)
3. Coller l'Apple ID (adresse e-mail) + le mot de passe généré ci-dessous.

**Yahoo Mail** :
1. Ouvrir [login.yahoo.com/account/security](https://login.yahoo.com/account/security)
2. Section "Connexions externes" → "Créer un mot de passe d'application"
3. Coller l'adresse e-mail + le mot de passe généré ci-dessous.

**Autre serveur IMAP** : formulaire classique (host, port, SSL, identifiant,
mot de passe) — comportement générique conservé pour le self-hosted / les
fournisseurs non listés.

- Pour les 3 fournisseurs reconnus, **seuls 2 champs sont demandés à
  l'utilisateur** : adresse e-mail + mot de passe d'application (le reste
  est pré-rempli, invisible). `connect_imap_account` (commande Tauri,
  inchangée) reçoit toujours `host`/`port`/`use_ssl`/`username`/`password` —
  c'est le **frontend** qui les pré-remplit selon le fournisseur choisi,
  pas un nouveau paramètre côté backend.
- **Test de connexion** avant de sauvegarder (`connect_imap_account` doit
  déjà le faire, spec/24 §"Commandes" — vérifie que l'échec renvoie un
  message actionnable, ex. "mot de passe refusé — vérifie que tu utilises
  bien le mot de passe d'application généré, pas ton mot de passe habituel"
  plutôt qu'une erreur IMAP brute).

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
- **Écriture — DIFFÉRÉE, voir §5.** L'ancienne version écrivait ici
  directement dans `Todo.md`/le contexte. **Remplacé** : le résultat du
  batch est stocké en **attente de validation** (`pending_email_reviews`,
  §5) — rien n'est écrit dans `Todo.md` ni dans une note de contexte avant
  que l'utilisateur ait validé.
- **Marquer les mails du batch comme "analysés"** (`processed_emails`)
  **après l'appel Claude réussi** (pas après l'écriture, qui est maintenant
  différée) — pour ne jamais **ré-analyser** (ré-appeler Claude) un mail
  déjà passé en revue, qu'il soit déjà validé ou encore en attente.

## 5. Écran de validation — remplace "tout automatique"

> **Révision explicite** : l'ancien comportement ("tout automatique, sans
> écran de confirmation, connecter = consentement") est **abandonné**.
> Chaque tâche et chaque fait de contexte proposés par un batch de mails
> passe désormais par une validation, comme `/resolve` le fait pour les
> réunions (spec/17) — mais sur un écran séparé, puisqu'un batch de mails
> n'est pas rattaché à un `recording_id`.

- **Nouvelle table `pending_email_reviews`** (remplace l'écriture directe
  de l'ancien §4) : une ligne par **item proposé** (pas par batch) —
  `id, message_id, subject, email_date, kind ("task"|"context"), payload
  JSON (la tâche ou le context_addition complet, schéma inchangé de §4),
  status ("pending"|"accepted"|"rejected"), created_at`.
- **Nouvel écran `/resolve-emails`** (ou section dédiée, à trancher au
  design UI — même famille visuelle que `/resolve`) : liste chaque item
  `pending` sous forme de carte — objet du mail + date en provenance,
  contenu proposé (titre de tâche, ou le fait de contexte + le(s) projet(s)
  ciblé(s)), **case cochée par défaut** (Claude reste la proposition de
  départ, l'utilisateur décoche ce qu'il ne veut pas — cohérent avec le
  reste de l'app où l'IA propose et l'humain corrige, pas l'inverse).
- **Bouton "Valider"** : pour chaque item **cochés** → écrit réellement
  dans `Todo.md` (avec provenance §3 + `+Projet`) ou route vers le contexte
  (global/projet, spec/16b) — **exactement** la logique d'écriture que
  l'ancien §4 faisait directement. Items **décochés** → passent à
  `status: "rejected"` (conservés en base pour traçabilité/dédoublonnage,
  jamais réécrits/reproposés).
- **Notification** : même pattern que spec/25/27 — un **badge** (compteur
  d'items `pending`) vérifié **au démarrage de l'app** et juste après
  chaque `sync_emails()` réussi. Affiché dans Réglages → section mails
  et/ou dans le bandeau existant (à trancher au design UI).
- **Granularité item par item, pas batch par batch** — décision actée :
  l'utilisateur doit pouvoir garder une tâche d'un mail et rejeter le fait
  de contexte du même mail, pas tout accepter/rejeter d'un coup.

## 6. Poser des questions sur ses mails (chat, spec/07b)

> **Nouvelle capacité** — distincte du croisement "mails déjà extraits +
> notes + tâches par projet" (spec/28, toujours hors scope de cette spec,
> voir §7). Ici : interroger le **contenu brut** des mails directement,
> à la demande, en langage naturel.

- **Nouvel outil de chat, read-only** : `search_emails(query)` /
  `read_email(message_id)` — même famille que `search_notes`/`read_note`
  (spec/07b) et `get_calendar_events` (spec/02), mais interroge **l'IMAP en
  direct** (pas un cache local) au moment de la question.
- **Aucune persistance du contenu** — cohérent avec la décision "mails hors
  vault" (§ Vue d'ensemble) : la recherche/lecture se fait à la volée,
  rien n'est stocké au-delà du temps de répondre à la question.
- **Fenêtre de recherche plus large que l'extraction** — décision par
  défaut proposée : la fenêtre glissante `email_sync_window_days` (§2,
  14 jours) sert à l'extraction automatique de tâches/contexte, mais une
  question posée en chat ("qu'a dit Marc dans son dernier mail sur le
  contrat ?") peut légitimement viser un mail plus ancien. Utiliser une
  fenêtre de recherche dédiée, plus large (ex. 90 jours, config séparée
  `email_search_window_days`), indépendante de la fenêtre d'extraction.
- **Coût** : pas de préoccupation de batching ici — la recherche est
  déclenchée **à la demande** par une question utilisateur (donc peu
  fréquente par nature), pas un balayage périodique en tâche de fond.
- **Citation des sources** : `read_email` retourne assez d'info (objet,
  expéditeur, date) pour que Claude cite le mail comme source dans sa
  réponse (même style que les citations `[[titre]]` de notes) — sans lien
  cliquable, cohérent avec la provenance non-navigable déjà actée §3
  (rien à ouvrir dans le vault derrière un mail).

## 7. Ce que cette spec NE couvre PAS (hors scope explicite)

- **Chat/RAG croisant mails déjà extraits + notes + tâches par projet**
  ("Projets unifiés", spec/28 — dépend de celle-ci, mais reste distincte
  de la Q&A directe sur le contenu des mails ci-dessus, §6).
- **Multi-comptes e-mail** — un seul compte IMAP configuré à la fois.
- **Pièces jointes** — ignorées (corps du mail uniquement, extraction §4
  ET Q&A §6).
- **Écriture/réponse aux mails** — lecture seule, jamais d'action sortante.
- **Fournisseurs OAuth dédiés** (Gmail API, Microsoft Graph) — IMAP générique
  uniquement pour cette v1 (décision : IMAP couvre déjà Gmail/Outlook/autres
  sans code spécifique par fournisseur).

## Commandes Tauri

| Commande | Rôle | Statut |
|---|---|---|
| `connect_imap_account(host, port, username, password, use_ssl)` | teste la connexion, stocke en `secrets.json` | ✅ construit |
| `disconnect_imap_account()` | retire les credentials | ✅ construit |
| `get_imap_status() -> {connected, last_synced_at}` | statut pour Réglages | ✅ construit |
| `sync_emails()` | fenêtre glissante + dédoublonnage + batchs Claude → **stocke en attente** (plus d'écriture directe, §5) | 🚧 à modifier |
| `list_pending_email_reviews() -> Vec<PendingEmailReview>` | pour l'écran `/resolve-emails` | 📝 à créer |
| `resolve_email_reviews(accepted_ids: Vec<i64>, rejected_ids: Vec<i64>)` | écrit les acceptés, marque les rejetés | 📝 à créer |
| `get_pending_email_review_count() -> usize` | badge de notification | 📝 à créer |

Outil de chat (`ai/chat.rs`, même fichier que `search_notes`/`read_note`) :

| Outil | Rôle | Statut |
|---|---|---|
| `search_emails(query)` | recherche IMAP en direct, fenêtre `email_search_window_days` | 📝 à créer |
| `read_email(message_id)` | lecture d'un mail précis, pour citation | 📝 à créer |

## Migration SQLite

- `processed_emails (message_id TEXT PRIMARY KEY, processed_at TEXT)` — ✅
  déjà en place (marque "analysé", pas "écrit" — voir §4 révisé).
- **Nouvelle** : `pending_email_reviews (id INTEGER PRIMARY KEY, message_id
  TEXT, subject TEXT, email_date TEXT, kind TEXT, payload TEXT, status
  TEXT, created_at TEXT)` (§5).
