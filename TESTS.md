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

---

## 1. Onboarding & visite guidée (spec 13) 💻
- [ ] **1re ouverture** (état vierge) → l'onboarding s'affiche. 🎯 2 slides d'intro.
- [ ] Étape **Vault** : choisir un dossier → `alfred-raw/`, `alfred-intelligence/`, `Todo.md` créés. 🎯 pas d'écrasement si déjà présents.
- [ ] Étape **Accès IA** : coller une clé perso (test OK) **ou** lancer l'abonnement AlfredIA. 🎯 clé validée / token récupéré.
- [ ] Étape **Micro** : test → 🎯 prompt OS (macOS) / ouverture WASAPI (Windows), pas d'erreur.
- [ ] Fin d'onboarding → **la visite guidée démarre** automatiquement.
- [ ] **Visite guidée = contexte à la voix** : téléprompteur affiché → « Commencer l'enregistrement » → se présenter (nom, entreprise, équipe, jargon) → « J'ai terminé ».
- [ ] 🎯 Étapes pilotées : transcription → structuration → écran **« Alfred vous connaît »** avec *N sections + N termes glossaire*.
- [ ] « Relire / corriger » ouvre `Contexte Alfred.md` (sections remplies). « Continuer » → onglet Alfred → suggestion « Que sais-tu de mon équipe… ».
- [ ] **Réglages → Système → « Revoir la visite guidée »** relance la visite. « Revoir l'introduction » relance le wizard (sans la visite).

## 2. Enregistrement (spec 03)
- [ ] 💻 **Micro** : clic logo → page de guidage `/recording`, **timer + volume live** ; stop → transcription lancée.
- [ ] 💻 Carte d'enregistrement de l'accueil = 2e point d'entrée (même comportement).
- [ ] 🪟 **Audio système** (`system_only`) : régler la source → enregistrer un son système → 🎯 capté.
- [ ] 🪟 **Mixte** (`mixed`) : micro + système mélangés dans le WAV final.
- [ ] 🍎 Audio système macOS → **non disponible** (message explicite attendu). *(hors périmètre v1)*
- [ ] 💻 **Import de fichier audio** : `/recording` → « Importer un audio » → choisir un **.wav** → transcription. 🎯 un .mp3 est refusé avec message (convertir en WAV).
- [ ] 💻 **Indicateur d'état** (sous le logo) : « Tout ouïe… » → « Je prends note… » → « Je cogite… » → « À votre service ».

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
- [ ] Après transcription → **compte-rendu** créé dans `alfred-intelligence/{titre}.md` (résumé + points clés).
- [ ] **Tâches** extraites → ajoutées à `alfred-intelligence/Todo.md` (dédup par titre).
- [ ] **Responsable** rappelé quand nommé à l'oral ; jamais inventé sinon.
- [ ] **Frontmatter** du compte-rendu : `participants` peuplés, `project` si clairement identifiable (spec 07).
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
- [ ] **Finaliser** → compte-rendu écrit sur le texte corrigé.
- [ ] Rien à signaler → finalise **automatiquement** (pas d'écran).
- [ ] **Reprise après quitter** : quitter sans finaliser → relancer l'app → sur la note d'enregistrement, bouton **« Vérifier / corriger »** → rouvre `/resolve`.

## 6. Contexte interne & glossaire (spec 16/17) 💻
- [ ] Réglages → « Contexte interne » → **Ouvrir la note** → `Contexte Alfred.md`.
- [ ] Éditer la note (corriger un nom, ex. « Ulis » → « Ulysse ») + sauvegarder → 🎯 **glossaire régénéré automatiquement** ~4 s après (débouncé).
- [ ] Bouton **« Régénérer le glossaire »** → affiche « ~N termes ».
- [ ] Contexte injecté dans l'ingestion (orthographe des prénoms/termes dans le compte-rendu).

## 7. Notes / vault (spec 07) 💻
- [ ] Onglet **Notes** : arbre de fichiers (dossiers + `.md`), sélection → éditeur.
- [ ] Éditeur **CodeMirror** : édition + **auto-save** ; panneau **Properties** (frontmatter).
- [ ] **Wikilinks** `[[Note]]` cliquables.
- [ ] Créer / renommer / supprimer une note.
- [ ] **Bascule « Dossiers / Projets »** : vue Projets → notes groupées par `project` (dossiers virtuels), « Sans projet » en dernier. Clic → ouvre la note.
- [ ] **Récents** (sidebar) : 5 notes récemment modifiées.
- [ ] **Graphe** (onglet) : nœuds = notes, liens = wikilinks.

## 8. Tâches (spec 06) 💻
- [ ] Onglet **Tâches** : sections Prioritaire / En cours / À faire / Archivé (depuis `Todo.md`).
- [ ] Cocher / décocher une tâche → persiste dans `Todo.md`.
- [ ] Éditer une tâche (titre / responsable / échéance).
- [ ] Bloc **tâches sur l'accueil** (dépliable) + « voir toutes les tâches » → `/tasks`.

## 9. Chat / RAG (spec 05/07b) 💻
- [ ] Onglet **Alfred** : poser une question sur les notes → réponse **citant les sources** en `[[wikilink]]`.
- [ ] Suggestions d'amorces cliquables (dont « Que sais-tu de mon équipe… »).
- [ ] **Historique** : liste des conversations passées ; sélection rouvre le fil ; **Nouvelle conversation** ; suppression.
- [ ] Retour d'état `chat-progress` (« recherche… » / « lecture… »).

## 10. Brief quotidien (spec 05/10) 💻
- [ ] Accueil, bloc **« Aujourd'hui »** : 1er lancement du jour → brief généré (todos + notes récentes).
- [ ] Bouton **Régénérer** ; « Généré le {date} » ; wikilinks cliquables.

## 11. Partage de notes (spec 18) 💻
- [ ] ⚙️ Backend déployé.
- [ ] Sur une note → **Partager** → 1re fois : **confirmation** (le contenu quitte le vault) → lien **copié**.
- [ ] Ouvrir le lien dans un navigateur → note **rendue** (titre, corps Markdown, tables/cases). 🎯 frontmatter **absent** (pas de `recording_id`).
- [ ] Éditer la note, re-**Partager** → **même URL**, contenu à jour.
- [ ] **Ne plus partager** → l'URL renvoie **404**.
- [ ] **Tâches** : bouton Partager sur `/tasks` → lien du `Todo.md` rendu.
- [ ] Sécurité : injecter `<script>` dans une note → **non exécuté** sur la page partagée.

## 12. Accès IA & backend (spec 15) 💻
- [ ] **Clé perso** : requêtes via `api.anthropic.com`.
- [ ] **AlfredIA** : abonnement Stripe (20 €/mois) → token loopback auto → requêtes via le proxy.
- [ ] `test_api_key` valide clé perso / token.
- [ ] Bascule entre les deux modes dans Réglages.
- [ ] `401` (clé invalide) → l'UI propose de reconfigurer.

## 13. Réglages & Feedback (spec 11/14) 💻
- [ ] **Réglages** : accès IA, Whisper (modèle/langue/threads), dossiers vault, Todo.
- [ ] **Feedback** (écran) : texte + images (collage) + email → envoyé (Postgres backend).
- [ ] 🟡 **Widget feedback** topbar (si livré par Tanguy) : envoi rapide + vue courante.
- [ ] **Métriques** : `install_created` / `app_launched` / `recording_completed` / `ingestion_completed` remontés (vérif SQL côté backend).

## 14. Nav & UX (spec 10) 💻
- [ ] Nav : Aujourd'hui / Tâches / Notes / Graphe / Alfred / Feedback / Paramètres. Pas de recherche globale.
- [ ] Aucune route morte (Réunions / Calendrier retirées).
- [ ] Bandeau d'enregistrement **persistant** pendant l'enregistrement (timer + volume + stop).

---

## Packaging & distribution (spec 12/E) — **pas encore fait**
- [ ] 🪟 Build Windows + **signature Authenticode** *(besoin du certificat)*.
- [ ] 🍎 Build macOS : entitlements + Developer ID + **notarisation** *(macOS)*.
- [ ] 💻 Lancement au démarrage (label `com.alfred.app`).

## Hors v1 (ne pas tester)
Calendrier · Appels (Vapi) · Suggestions · Transcription live · Ingest CLI ·
Audio système macOS · Rangement physique des notes par projet.

---
*Noter les bugs sous chaque ligne `[!]`, ou dans un tableau en bas.*
