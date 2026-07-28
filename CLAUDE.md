# CLAUDE.md — Alfred

Instructions pour **tous les agents Claude Code** travaillant sur ce repo. Lues
automatiquement à chaque session.

## Contexte

Alfred = app desktop **Tauri (Rust + React/TS)**, cross-platform (Windows + macOS).
Objectif : livrer une **v1** rapidement à ~10 utilisateurs.

- **Specs** = source de vérité (le *quoi* / *comment*) : dossier `spec/`. Index +
  statut de chaque module : `spec/README.md`.
- **Backlog v1** (le *où on en est*) : `ROADMAP.md` (racine).

## Workflow de session — OBLIGATOIRE

On travaille **directement sur `main`** (code **et** ROADMAP), à deux. Le but : que
chacun voie en temps réel ce que l'autre fait.

**Au début de chaque session :**
1. `git pull` (synchro — aussi déclenché par le hook SessionStart).
2. Dans `ROADMAP.md`, marquer les tâches que tu attaques `[~]` (en cours) + tes
   initiales dans la colonne **Qui**.
3. `git commit` + **`git push` sur `main` tout de suite** (signal de coordination).

**Pendant la session :**
- Travailler directement sur `main`. Commiter et pousser régulièrement.

**Quand une tâche / spec est terminée :**
1. Mettre à jour `ROADMAP.md` : passer la tâche à `[x]` (et le statut dans
   `spec/README.md` si pertinent).
2. `git commit` + **`git push` sur `main` tout de suite**.

## Règles

- **Nouveau besoin non couvert par une spec** → écrire / mettre à jour la spec dans
  `spec/` **d'abord**, puis ajouter la tâche dans `ROADMAP.md`.
- **Éditer `ROADMAP.md` de façon ciblée** (une ligne = une tâche) pour limiter les
  conflits de merge à deux.
- Si un `push` est rejeté → `git pull --rebase` puis re-push.
- **Respecter le périmètre v1** : ce qui est marqué **« Hors v1 »** dans les specs
  ne se code pas.

## Repères techniques

- Identifiant app : `com.alfred.app`.
- IA : **API Claude uniquement** (jamais de CLI) — `claude-sonnet-5` (ingestion /
  chat), `claude-haiku-4-5` ; deux modes d'accès (clé perso / proxy AlfredIA). Voir `spec/05` ; le proxy/backend AlfredIA vit dans le repo privé `alfred-backend`.
- Vault : `alfred-raw/` (transcriptions), `alfred-intelligence/` (comptes-rendus +
  `Todo.md`). SQLite = config / état local uniquement.
