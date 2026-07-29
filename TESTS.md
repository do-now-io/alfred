# Alfred — Cahier de tests v1

Test **manuel** de bout en bout de toutes les fonctionnalités v1. À dérouler dans
l'app buildée (`npm run tauri dev`, ou installeur). Cocher au fur et à mesure.

**Légende** — `[ ]` à tester · `[x]` OK · `[!]` bug (noter dessous).
**Plateforme** — 🪟 Windows · 🍎 macOS · 💻 les deux.
**Icônes** — ⚙️ prérequis · 🎯 résultat attendu.

## Prérequis généraux
- ⚙️ Accès IA configuré (clé perso Claude **ou** abonnement AlfredIA).
- ⚙️ Un vault choisi (dossier avec `alfred-raw/`, `alfred-intelligence/`).
- ⚙️ Pour le **partage** : backend AlfredIA déployé (Coolify) avec la migration `0006`.
- ⚙️ Micro fonctionnel. Pour l'audio système : 🪟 seulement (macOS non implémenté).
- ⚙️ Pour tester **@moi** (Tâches) : profil local (prénom) renseigné dans Réglages → Profil.

---

## 0. Préparation — réinitialiser & installer

### 0.1 Où Alfred stocke ses données (🪟 Windows)
| Quoi | Emplacement |
|---|---|
| État local (config, onboarding, glossaire, métadonnées, partages) | `%APPDATA%\com.alfred.app\alfred.db` (+ `-wal`/`-shm`) |
| Clé IA / token AlfredIA | `%APPDATA%\com.alfred.app\secrets.json` |
| WAV temporaires (avant transfert au vault) | `%APPDATA%\com.alfred.app\recordings\` |
| **Contenu** (notes, transcriptions, comptes-rendus, tâches, audio) | **le vault** (ex. `…\alfred_vault\` : `Contexte Alfred.md`, `alfred-raw/`, `alfred-intelligence/`) |

### 0.2 Repartir de zéro (⚠️ **fermer Alfred d'abord**)
```powershell
# 1) État local. On GARDE secrets.json (ta clé IA) — sinon voir plus bas.
Remove-Item "$env:APPDATA\com.alfred.app\alfred.db*" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\com.alfred.app\recordings\*" -Recurse -Force -ErrorAction SilentlyContinue

# 2) Vider le vault (ADAPTE le chemin à ton vault)
$vault = "$env:USERPROFILE\alfred_vault"  # adapte au chemin de ton vault
Remove-Item "$vault\alfred-raw\*","$vault\alfred-intelligence\*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$vault\Contexte Alfred.md" -Force -ErrorAction SilentlyContinue
```
- Pour **re-tester l'étape « Accès IA »** de l'onboarding à blanc, supprime aussi :
  `Remove-Item "$env:APPDATA\com.alfred.app\secrets.json" -Force`
- **Table rase idéale pour tester l'onboarding complet** : supprime `alfred.db*` (ça oublie le vault → l'onboarding redemandera un dossier) puis, dans l'onboarding, **choisis un dossier vide tout neuf**. Alfred y recrée `alfred-raw/`, `alfred-intelligence/`, `Todo.md`, et sème un **contenu de démarrage** (checklist + 2 notes de démo + une conversation d'exemple).
- ⚠️ Le vault est dans **OneDrive** → les suppressions se **synchronisent dans le cloud**.

### 0.3 Installer / lancer Alfred

**Option A — Mode dev** (rapide, teste le code courant) :
1. Prérequis (une seule fois) : **Rust (toolchain MSVC)**, **Node.js**, **CMake**, **MSVC C++ Build Tools**, **libclang.dll** (`pip install --user libclang` ou LLVM).
2. `./scripts/setup-windows.ps1` (crée la base de compilation + sqlx-cli). Puis `npm install`.
3. Lancer : `./scripts/dev-windows.ps1` (trouve libclang tout seul) — ou `npm run tauri dev`.

**Option B — Installeur** (teste comme un vrai utilisateur) :
1. `./scripts/build-windows.ps1` (récupère le modèle Whisper + `tauri build`).
2. Installeur généré dans **`src-tauri/target/release/bundle/nsis/*.exe`** (et `…/msi/*.msi`).
3. Lancer le `.exe` → installer → ouvrir depuis le menu Démarrer.
4. ⚠️ Build **non signé** → SmartScreen affiche un avertissement : *« Informations complémentaires » → « Exécuter quand même »*.

### 0.4 Ordre conseillé des tests
Onboarding (§1) → Enregistrement (§2) → Transcription (§3) → Ingestion (§4) →
Ingestion augmentée (§5) → Contexte/glossaire (§6) → Notes (§7) → Tâches (§8) →
Chat + dictée (§9) → Brief (§10) → Partage (§11) → Accès IA (§12) → Réglages/Profil/
Feedback (§13) → Nav & indicateur d'état (§14). Le §1 dépend d'un état réinitialisé (0.2).

---

## 1. Onboarding & visite guidée (spec 13) 💻
- [ ] **1re ouverture** (état vierge) → l'onboarding s'affiche. 🎯 2 slides d'intro.
- [ ] Étape **Vault** : choisir un dossier → `alfred-raw/`, `alfred-intelligence/`, `Todo.md` créés. 🎯 pas d'écrasement si déjà présents.
- [ ] Étape **Accès IA** : coller une clé perso (test OK) **ou** lancer l'abonnement AlfredIA. 🎯 clé validée / token récupéré.
- [ ] Étape **Micro** : test → 🎯 prompt OS (macOS) / ouverture WASAPI (Windows), pas d'erreur.
- [ ] Fin d'onboarding → 🎯 **contenu de démarrage semé** : checklist de tâches (À faire/En cours, une dans Fait), 2 notes de démo dans « Projets », une conversation d'exemple dans l'historique du chat.
- [ ] Fin d'onboarding → **la visite guidée démarre** automatiquement.
- [ ] **Téléprompteur** (contexte à la voix) : « Commencer l'enregistrement » → se présenter (nom, entreprise, équipe, jargon).
  - [ ] **Pause / Reprendre** pendant la prise → 🎯 le chrono se fige, la capture s'arrête sans clôturer.
  - [ ] « J'ai terminé » → 🎯 **panneau de revue** (pas de transcription immédiate) : « Recommencer » (jette la prise, on relance) / « Continuer » (lance la transcription mode contexte).
- [ ] 🎯 Pendant la transcription/structuration, la visite **enchaîne les spotlights** de l'app (Notes → Tâches → Graphe → Alfred/enregistrer) **sans s'interrompre**, même si le contexte finit d'être prêt entre-temps.
- [ ] 🎯 La pop-up **« Alfred vous connaît, vérifiez »** n'apparaît **qu'à la fin** de la dernière étape de découverte — immédiatement si le contexte était déjà prêt, sinon elle attend l'événement. **Un seul bouton : « Revoir / corriger »**.
- [ ] « Revoir / corriger » → 🎯 ouvre **`/resolve` en mode contexte** (4 sections éditables : entreprise/équipe/vocabulaire/projets + réécoute du WAV), pas la note brute dans `/notes`.
- [ ] **Valider** → carte de clôture « Vous êtes équipé » → onglet Alfred → suggestion « Que sais-tu de mon équipe… ».
- [ ] **Réglages → Système → « Revoir la visite guidée »** relance la visite. « Revoir l'introduction » relance le wizard (sans la visite).

## 2. Enregistrement (spec 03) 💻
- [ ] **Micro** : clic logo → page de guidage `/recording`, **timer + volume live**.
- [ ] Carte d'enregistrement de l'accueil = 2e point d'entrée (même comportement).
- [ ] **Conseils de captation par type** : sélecteur en tête (Note perso / Réunion client / One-to-one / Réunion d'équipe / Libre) → 🎯 phrase d'ouverture + conseils changent selon le type choisi. « Modifier » édite le type sélectionné.
- [ ] **Pause / Reprendre** pendant l'enregistrement (bandeau + page `/recording`) → 🎯 chrono figé, pas de transcription lancée.
- [ ] **Annuler** pendant l'enregistrement → 🎯 confirmation (« Supprimer cet enregistrement ? ») puis retour à l'état repos, **aucun** traitement lancé, WAV jeté.
- [ ] **« Terminer »** → 🎯 **panneau de revue** (pas de lancement direct) :
  - [ ] **Supprimer** → jette la prise, retour à l'état repos.
  - [ ] **Continuer** avec les 3 cases **Transcription / Compte-rendu / Tâches** cochées par défaut → 🎯 pipeline complet.
  - [ ] Décocher **Transcription** → 🎯 les 2 autres cases se grisent (dépendance).
  - [ ] Décocher seulement **Tâches** (ou seulement **Compte-rendu**) → 🎯 seule la section demandée est produite après transcription.
  - [ ] Décocher les 3 → 🎯 seul le WAV est conservé dans le vault, **aucun appel IA**.
- [ ] 🪟 **Audio système** (`system_only`) : régler la source → enregistrer un son système → 🎯 capté.
- [ ] 🪟 **Mixte** (`mixed`) : micro + système mélangés dans le WAV final.
- [ ] 🍎 Audio système macOS → **non disponible** (message explicite attendu). *(hors périmètre v1)*
- [ ] 💻 **Import de fichier audio** : `/recording` → « Importer un audio » → choisir un **.wav** → transcription. 🎯 un .mp3 est refusé avec message (convertir en WAV).
- [ ] 💻 **Indicateur d'état** (sous le logo) : « Tout ouïe… » → « Je prends note… » → « Je cogite… » → **« Je note les tâches… »** (bref, pendant l'écriture de `Todo.md`) → « À votre service ».

## 3. Transcription Whisper (spec 04/17) 💻
- [ ] Enregistrement court (< 15 min) → transcription en **passe unique**, texte cohérent.
- [ ] **Qualité** : voix claire → peu d'erreurs ; silences → pas d'hallucinations inventées.
- [ ] **Glossaire** : après avoir rempli `Contexte Alfred.md`, les **noms propres** du contexte sont bien orthographiés dans la transcription.
- [ ] **Long fichier (> 15 min, idéalement ~1 h)** : 🎯 console dev affiche `… → N tranches, N workers × N threads` (transcription **parallèle**). Temps sensiblement réduit vs séquentiel.
- [ ] Recollage : le texte long est continu, sans doublon ni trou aux jointures ; timestamps cohérents.
- [ ] **Threads** : `set_config('whisper_threads','14')` → transcription plus rapide (aucune perte de qualité).
- [ ] **Modèle** : Réglages → Whisper → `base` → plus rapide (qualité moindre) ; retour `small`.
- [ ] **Langue** : forcer `language_hint` (ex. `en`) → transcription dans la bonne langue ; `auto` détecte.

## 4. Ingestion (spec 05) 💻
- [ ] Après transcription (case Compte-rendu cochée) → 🎯 compte-rendu créé dans `alfred-intelligence/{sujet}.md` — **nommé par sujet court** (pas par la date). La transcription brute, elle, garde son nom daté.
- [ ] Après transcription (case Tâches cochée) → **tâches** extraites → ajoutées à `alfred-intelligence/Todo.md` (dédup par titre).
- [ ] **Responsable** rappelé quand nommé à l'oral ; jamais inventé sinon.
- [ ] **Frontmatter** du compte-rendu : `participants` peuplés, `project` **une liste** (0, 1 ou plusieurs projets) si clairement identifiable(s) (spec 07).
- [ ] **Provenance** : la tâche générée porte un **wikilink** vers son compte-rendu source (ou la note brute si le compte-rendu n'a pas été demandé) + une date, visible dans la fiche tâche (§8).
- [ ] **Ré-ingérer** (bouton Notes sur une note) → régénère le compte-rendu.
- [ ] Échec IA (clé invalide) → **bandeau d'erreur visible** (pas d'échec silencieux).

## 5. Ingestion augmentée — écran de correction (spec 17 §3) 💻
- [ ] ⚙️ Flag `augmented_ingestion` **ON par défaut**.
- [ ] Enregistrement avec noms propres douteux → **bandeau « Alfred a N points à vérifier »** (bas-gauche).
- [ ] « Vérifier maintenant » → écran `/resolve` : texte éditable (CodeMirror) à gauche, **cartes** à droite (corrections, phrases floues, responsable manquant, faits de contexte).
- [ ] **Appliquer** une correction → remplacée dans le texte ; **Ignorer** → carte grisée ; **Revenir** → réactive.
- [ ] **🔊 Réécouter** un passage → joue le segment audio [start, end].
- [ ] Champ **responsable** sur une tâche → injecté dans le texte.
- [ ] Cases **faits de contexte** → à la finalisation, écrits dans `## Appris automatiquement` de `Contexte Alfred.md` + glossaire régénéré.
- [ ] **Finaliser** → compte-rendu écrit sur le texte corrigé, en respectant les cases Compte-rendu/Tâches cochées au panneau de revue (§2).
- [ ] Rien à signaler → finalise **automatiquement** (pas d'écran).
- [ ] **Reprise après quitter** : quitter sans finaliser → relancer l'app → sur la note d'enregistrement, bouton **« Vérifier / corriger »** → rouvre `/resolve`.

## 6. Contexte interne & glossaire (spec 16/17) 💻
- [ ] Réglages → « Contexte interne » → **Ouvrir la note** → `Contexte Alfred.md`.
- [ ] Éditer la note (corriger un nom, ex. « Ulis » → « Ulysse ») + sauvegarder → 🎯 **glossaire régénéré automatiquement** ~4 s après (débouncé).
- [ ] Bouton **« Régénérer le glossaire »** → affiche « ~N termes ».
- [ ] Contexte injecté dans l'ingestion (orthographe des prénoms/termes dans le compte-rendu).
- [ ] **Contexte créé à la voix sur une note encore vierge** (template jamais édité) → 🎯 le template est **remplacé entièrement** (pas de sections vides dupliquées, pas de section « Appris à l'oral » sur une note vierge). Sur une note **déjà remplie** par l'utilisateur → le nouveau contenu s'ajoute sous « Appris à l'oral (date) », rien n'est écrasé.

## 7. Notes / vault (spec 07) 💻
- [ ] Onglet **Notes** : arbre de fichiers (dossiers + `.md`), sélection → éditeur.
- [ ] Éditeur **CodeMirror** : édition + **auto-save** ; panneau **Properties** (frontmatter).
- [ ] **Wikilinks** `[[Note]]` cliquables.
- [ ] Créer / renommer / supprimer une note.
- [ ] 🎯 **Icône de type** à l'œil dans l'arbre **et** les Récents : transcription audio (onde), compte-rendu (synthèse Alfred), tâche, contexte (`Contexte Alfred.md`), note libre — sans ouvrir la note.
- [ ] **Récents** (sidebar) : icône + nom + **date/heure en secondaire** (distingue deux enregistrements du même jour).
- [ ] **Properties → Projets** : champ **multi-sélection** (combobox) → liste les projets existants du vault + autocomplétion + création d'un nouveau. Modifier → la note apparaît immédiatement sous chaque projet choisi.
- [ ] **Properties → Participants** : ajout libre.
- [ ] **Properties → Tags** : 🎯 suggestions des tags existants affichées + autocomplétion (taper `te` propose `test`), clic pour ajouter.
- [ ] ⚙️ Profil local configuré (§13) → un participant qui matche le prénom du profil s'affiche **« Moi »** dans la liste.
- [ ] **Bascule « Dossiers / Projets »** :
  - [ ] Vue Projets → notes groupées par `project` ; une note avec **plusieurs projets** apparaît sous **chacun** ; « Sans projet » en dernier.
  - [ ] 🎯 **Paire transcription + compte-rendu** (même enregistrement) affichée **ensemble** dans un groupe de projet — la transcription n'atterrit plus isolée dans « Sans projet ».
  - [ ] **Glisser-déposer** une note sur un groupe de projet → 🎯 le projet est ajouté au frontmatter (fonctionne — voir note DnD au §8). Déposer sur « Sans projet » vide le champ.
- [ ] **Récents** (sidebar) : 5 notes récemment modifiées.
- [ ] **Graphe** (onglet) : nœuds = notes, liens = wikilinks + tags.
  - [ ] 🎯 **Paire transcription ↔ compte-rendu** reliée **nativement** (même `recording_id`), même si leurs noms de fichiers diffèrent (transcription datée, compte-rendu nommé par sujet).
  - [ ] Recherche/Ctrl+F dans l'éditeur de note (§14) fonctionne toujours.

## 8. Tâches (spec 06) 💻
- [ ] Onglet **Tâches** : **une seule vue Kanban** ; le bouton **« Markdown »** n'est plus une 2e vue — 🎯 il ouvre `Todo.md` dans l'écran **Notes** (même fichier, même éditeur que n'importe quelle note).
- [ ] **Vue Kanban** : colonnes **À faire / En cours / Fait / Archivé** (Archivé **repliée par défaut**, dépliable). Plus de colonne « Prioritaire ».
  - [ ] ⚠️ **Glisser-déposer une carte d'une colonne à l'autre** → 🎯 **fonctionne** (bug corrigé : `dragDropEnabled` de Tauri bloquait tout le HTML5 DnD du webview). La carte change de section dans `Todo.md`. 🎯 **Déposer dans Fait coche** la case ; **en sortir la décoche**.
  - [ ] Déposer une carte **sur une autre** (même colonne) → réordonnancement.
  - [ ] Carte : titre (markdown inline rendu, pas de `**` bruts) + case à cocher (🎯 cocher **déplace la carte vers Fait** ; décocher la renvoie vers À faire) + puce **responsable** colorée + badge **échéance** coloré selon la proximité (en retard / aujourd'hui / cette semaine) + badge **priorité** + badge **projet**.
  - [ ] **« + »** en tête de colonne → ajout rapide dans la section correspondante ; compteur à jour.
  - [ ] Filtres : **recherche texte** (titre/responsable, insensible casse/accents), **responsable**, **échéance**, **projet**, **priorité**. 🎯 Tri intra-colonne par priorité (haute en haut).
  - [ ] Ouvrir un vieux `Todo.md` (colonne `Prioritaire`, tâches `[x]` égarées hors Fait/Archivé) → 🎯 **migré automatiquement** à la 1ʳᵉ lecture : `Prioritaire` fusionne dans `À faire`, les `[x]` égarés rejoignent `Fait`.
- [ ] Ouvrir `Todo.md` via Notes → 🎯 **structuré statut → projet → priorité** : chaque section `## ` regroupe ses tâches par `### Projet` (ordre alphabétique, « Sans projet » en dernier — pas d'en-tête `###` s'il n'y a qu'un seul groupe), triées par `!priorité` dans chaque groupe.
- [ ] **Fiche tâche** — cliquer une carte (Kanban) → 🎯 ouvre la fiche :
  - [ ] Édition **titre / responsable / échéance / projet (`+Projet`) / priorité / estimation** — auto-sauvegarde.
  - [ ] **Sous-tâches libres** (ajout/édition/suppression) + **description longue** (texte multi-lignes) — 🎯 persistées sous la ligne dans `Todo.md`, toujours lisibles/éditables dans Obsidian.
  - [ ] Si la tâche vient d'un enregistrement → 🎯 **provenance affichée** (compte-rendu source + date), boutons **« Ouvrir la note »** et **« Voir dans le graphe »** (centre + surligne le nœud). Provenance jamais éditable.
  - [ ] Bouton **« Rassembler le contexte »** → 🎯 action IA à la demande (pas automatique) qui résume compte-rendu source + notes liées ; réponse avec wikilinks cliquables.
  - [ ] ⚙️ Profil local configuré → bouton **« M'assigner »** à côté du champ responsable → remplit avec son propre prénom.
- [ ] Bloc **tâches sur l'accueil** (dépliable, À faire/En cours) + « voir toutes les tâches » → `/tasks`.

## 9. Chat / RAG (spec 05/07b) 💻
- [ ] Onglet **Alfred** : poser une question sur les notes → réponse **citant les sources** en `[[wikilink]]`.
- [ ] Suggestions d'amorces cliquables (dont « Que sais-tu de mon équipe… »).
- [ ] **Historique** : liste des conversations passées ; sélection rouvre le fil ; **Nouvelle conversation** ; suppression.
- [ ] Retour d'état `chat-progress` (« recherche… » / « lecture… »).
- [ ] **Dictée vocale** (bouton micro dans la barre de saisie, chat **et** teaser accueil) :
  - [ ] Clic → capture (icône passe en « stop » / état d'écoute) → clic à nouveau → 🎯 texte transcrit **inséré dans le champ**, éditable, **pas d'envoi automatique**.
  - [ ] Pendant un enregistrement de réunion en cours → 🎯 bouton dictée **désactivé** (et inversement).
  - [ ] Quitter l'écran en pleine dictée → 🎯 annulation propre (pas de fichier résiduel, pas de note créée).

## 10. Brief quotidien (spec 05/10) 💻
- [ ] Accueil, bloc **« Aujourd'hui »** : 1er lancement du jour → brief généré (todos + notes récentes).
- [ ] Bouton **Régénérer** ; « Généré le {date} » ; wikilinks cliquables.

## 11. Partage de notes (spec 18) 💻
- [ ] ⚙️ Backend déployé.
- [ ] Sur une note → **Partager** → 1re fois : **confirmation** (le contenu quitte le vault) → lien **copié**.
- [ ] Ouvrir le lien dans un navigateur → note **rendue** (titre, corps Markdown, tables/cases). 🎯 frontmatter **absent** (pas de `recording_id`).
- [ ] Éditer la note, re-**Partager** → **même URL**, contenu à jour.
- [ ] **Ne plus partager** → l'URL renvoie **404**.
- [ ] **Tâches** : bouton Partager sur `/tasks` → lien du `Todo.md` rendu (fonctionne dans les deux vues Kanban/Markdown).
- [ ] Sécurité : injecter `<script>` dans une note → **non exécuté** sur la page partagée.
- [ ] Footer de la page partagée : « Partagé via Alfred » + lien `alfred.do-now.io` + logo.

## 12. Accès IA & backend (repo privé alfred-backend) 💻
- [ ] **Clé perso** : requêtes via `api.anthropic.com`.
- [ ] **AlfredIA** : abonnement Stripe (20 €/mois) → token loopback auto → requêtes via le proxy.
- [ ] `test_api_key` valide clé perso / token.
- [ ] Bascule entre les deux modes dans Réglages.
- [ ] `401` (clé invalide) → l'UI propose de reconfigurer.

## 13. Réglages, Profil & Feedback (spec 10/11/14) 💻
- [ ] 🎯 **Plus de menu profil** en haut à droite de la topbar (avatar+nom+flèche qui ne faisait rien) — retiré.
- [ ] **Réglages → Profil** : renseigner un **prénom** + un **avatar** (image) → 🎯 persistés en local (pas de compte serveur). Réutilisés : bouton « M'assigner » et badge « moi » sur les tâches (§8), reconnaissance « Moi » parmi les participants d'une note (§7).
- [ ] **Réglages** : accès IA, Whisper (modèle/langue/threads), dossiers vault, Todo.
- [ ] **Lancement au démarrage** (Système) : activer/désactiver → 🎯 macOS utilise désormais le label `com.alfred.app` (aligné sur l'identifiant de l'app).
- [ ] **Feedback** (écran) : texte + images (collage) + email → envoyé (Postgres backend).
- [ ] 🟡 **Widget feedback** topbar (si livré par Tanguy) : envoi rapide + vue courante.
- [ ] **Métriques** : `install_created` / `app_launched` / `recording_completed` / `ingestion_completed` remontés (vérif SQL côté backend).

## 14. Nav & UX (spec 10) 💻
- [ ] Nav : Aujourd'hui / Tâches / Notes / Graphe / Alfred / Feedback / Paramètres. Pas de recherche globale.
- [ ] Aucune route morte (Réunions / Calendrier retirées).
- [ ] Bandeau d'enregistrement **persistant** pendant l'enregistrement (timer + volume + **Annuler** + **Pause** + Terminer).
- [ ] **Indicateur d'état = où Alfred travaille** :
  - [ ] Pendant une transcription/analyse, 🎯 un **point ambre** apparaît sur la note **en cours de traitement** dans les Récents (pas sur la note simplement sélectionnée — le highlight suffit pour ça).
  - [ ] Cliquer le libellé sous le logo (« Je cogite… », etc.) quand un point est actif → 🎯 navigue vers la note/l'écran concerné. Au repos (« À votre service »), non cliquable.

---

## Packaging & distribution (spec 12/E) — **pas encore fait**
- [ ] 🪟 Build Windows + **signature Authenticode** *(besoin du certificat — bloqué, pas de secret disponible)*.
- [ ] 🍎 Build macOS : entitlements + Developer ID + **notarisation** *(macOS — bloqué, pas de compte développeur/certificat disponible)*.
- [x] 💻 Lancement au démarrage (label `com.alfred.app`) — corrigé.

## Hors v1 (ne pas tester)
Calendrier · Appels (Vapi) · Suggestions · Transcription live · Ingest CLI ·
Audio système macOS · Rangement physique des notes par projet · Signature de
partage avec le prénom du profil (nécessiterait de faire évoluer le backend
séparé — pas fait).

---
*Noter les bugs sous chaque ligne `[!]`, ou dans un tableau en bas.*
