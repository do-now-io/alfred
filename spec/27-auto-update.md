# spec/27 — Mise à jour automatique de l'app

> **Statut :** 📝 spec écrite (décisions prises, dont fréquence de check =
> démarrage uniquement), rien de codé. Post-v1. Étend le packaging
> (spec/12) — s'appuie sur le pipeline de release existant (`.github/workflows/
> desktop-build.yml`, tags `v*`), sans nouvelle infra.

## Constat

Aujourd'hui, **aucun mécanisme de mise à jour** n'existe dans l'app : pas de
`tauri-plugin-updater`, pas de vérification de version au démarrage. La CI
publie les binaires sur une **release GitHub** à chaque tag `v*` ; le site
(`alfred.do-now.io`) va chercher le dernier tag lui-même (revalidation
horaire), mais ça ne notifie **que le site**, pas l'app installée. Un
utilisateur en 0.2.10 n'est prévenu de rien et doit aller télécharger/réinstaller
manuellement le nouvel installeur.

## Solution : `tauri-plugin-updater`

Plugin officiel Tauri, gratuit. Réutilise le pipeline de release déjà en
place (tags `v*` → build 3 OS → release GitHub) — pas de nouvelle infra à
héberger, pas de coût.

### 1. Signature updater (distincte de la signature OS)

- **Nouvelle paire de clés** (`tauri signer generate`), **différente** de la
  signature Authenticode (Windows, SSL.com eSigner) et Developer ID (macOS,
  spec/12) déjà en place — celle-ci signe le **contenu** de la mise à jour
  pour que le plugin vérifie son intégrité, pas l'OS.
- Clé privée en secret CI (`TAURI_SIGNING_PRIVATE_KEY` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, même famille que les secrets déjà
  utilisés pour la signature Windows). Clé publique dans
  `tauri.conf.json` (`plugins.updater.pubkey`).

### 2. Manifest `latest.json`

- Généré par la CI à chaque release (le build Tauri produit déjà les
  fichiers `.sig` par artefact quand la signature updater est configurée) :
  version, notes, et par plateforme `{url, signature}` pointant vers les
  binaires déjà uploadés sur la release GitHub.
- **Hébergé comme asset de la release GitHub elle-même** (pas de nouveau
  serveur) — `tauri.conf.json` pointe son `endpoints` vers l'URL stable
  `https://github.com/do-now-io/alfred/releases/latest/download/latest.json`
  (GitHub résout toujours `latest` vers la dernière release publiée).

### 3. Côté app

- `tauri-plugin-updater` + `tauri-plugin-process` (pour `relaunch()`) ajoutés
  (Cargo + npm), capacités `updater:default` + `process:default` dans
  `src-tauri/capabilities/`.
- **Vérification au démarrage** (`check()`), silencieuse, non bloquante.
- **Bandeau non intrusif** (cohérent avec le ton "majordome", spec/10) si une
  mise à jour est dispo : « Une nouvelle version d'Alfred est prête » + bouton
  **« Mettre à jour »** → télécharge, installe, propose `relaunch()`.
  **Aucune installation silencieuse sans clic explicite** — l'utilisateur
  garde la main, cohérent avec le pattern `window.confirm` déjà utilisé pour
  les actions notables de l'app (partage, suppression de projet spec/07…).
- Entrée manuelle **« Vérifier les mises à jour »** dans Réglages (spec/11),
  pour forcer un check sans attendre le prochain démarrage.

### 4. macOS — dépendance connue

L'update téléchargée doit être **signée** pour que Gatekeeper l'accepte à
l'installation — la signature Developer ID est déjà en place (Phase E), donc
ça devrait passer. Mais tant que la **notarisation reste bloquée** (ROADMAP
Phase E, en pause), l'expérience d'installation de la mise à jour sur macOS
gardera probablement le même type d'avertissement Gatekeeper qu'un
téléchargement manuel aujourd'hui — **pas un blocage pour construire cette
feature**, juste une UX qui restera imparfaite sur macOS jusqu'au déblocage
de la notarisation.

### 5. Amorçage (bootstrap) — les testeurs déjà installés en 0.2.x

Le mécanisme ne peut prévenir que les installations qui l'embarquent déjà.
Les ~10 utilisateurs test actuellement en 0.2.x **ne recevront aucune
notification pour LA MISE À JOUR QUI INTRODUIT CE MÉCANISME** — il faut les
prévenir **manuellement une dernière fois** (message direct) pour cette
version-là ; toutes les suivantes seront détectées automatiquement.

## Décisions

- **Fréquence de check : démarrage uniquement** (+ bouton manuel dans
  Réglages) — pas de check périodique en cours de session.
- **Linux (AppImage/deb/rpm)** : le plugin supporte l'auto-update mais avec
  des nuances par format ; à l'échelle actuelle (~10 testeurs, surtout
  Windows/macOS), pas prioritaire de creuser le cas Linux dans un premier
  temps.

## Commandes / fichiers à créer ou modifier

| Élément | Rôle |
|---|---|
| `src-tauri/tauri.conf.json` | `plugins.updater.pubkey` + `endpoints` |
| `src-tauri/capabilities/` | `updater:default`, `process:default` |
| `.github/workflows/desktop-build.yml` | étape de signature updater + génération/upload `latest.json` |
| Frontend (bandeau + Réglages) | `check()`, `downloadAndInstall()`, `relaunch()` (`@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`) |

## Hors scope

- Auto-update **silencieux** sans confirmation utilisateur.
- Canal de mise à jour bêta/stable séparé (une seule release = une seule
  version, comme aujourd'hui).
