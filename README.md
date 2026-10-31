# Planning Events — invitations digitales

Plateforme complète de création et de gestion d'invitations numériques : RSVP, QR codes,
gestion des invités, livre d'or, contrôle d'accès à l'entrée et rapports en temps réel.

Marque : **PLANNING EVENTS** — 183 Avenue Dodoma, Commune de Kinshasa (RDC)
WhatsApp : (+243) 808 979 828 / 822 640 274 — Facebook : PlanningEvents

## Site vitrine

`/` présente l'offre (livre d'or, connaissance des goûts des invités, distribution
automatique, scan QR à l'entrée avec rapport en temps réel, gestion digitale des invités,
confirmation de présence, carte d'adresse), trois formules de prix, les coordonnées de
Kinshasa et un formulaire de demande de devis.

## Plateforme

| Page | Rôle |
| --- | --- |
| `/i/:code` | Invitation publique : compte à rebours, programme, accès plan, RSVP, livre d'or |
| `/login` | Accès administrateur (code d'accès) |
| `/admin` | Tableau de bord : statistiques, invités, QR codes, livre d'or, demandes, paramètres |
| `/scan` | Contrôle d'accès : scan caméra (QR) ou saisie du code, historique et compteurs en direct |

### Parcours type

1. Connexion à `/admin` avec le code administrateur.
2. Création d'un événement (hôtes, date, lieu, thème, programme, date limite RSVP).
3. Ajout d'invités (unitaire ou import rapide « Nom ; téléphone ; places »).
4. Pour chaque invité : lien personnel `/i/CODE?g=TOKEN` et QR code PNG (`/api/events/:id/qr.png`)
   partageables par WhatsApp.
5. L'invité confirme sa présence (RSVP) et peut laisser un message au livre d'or.
6. À l'entrée, `/scan` valide le billet ; un billet déjà scanné est signalé (409) avec l'heure
   du premier passage.
7. Les statistiques et l'export CSV (`/api/events/:id/export.csv`) sont disponibles en direct.

## Démarrage

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # rechargement automatique
npm test             # tests d'intégration de l'API (node:test)
```

Un événement de démonstration est créé au premier lancement : code `DEMO2026`,
4 invités, livre d'or et programme pré-remplis.

## Configuration

| Variable | Défaut | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port d'écoute (bind `0.0.0.0`) |
| `ADMIN_CODE` | `PLANNING2026` | Code d'accès administrateur |
| `SESSION_SECRET` | aléatoire | Clé de signature du cookie de session (à fixer en production) |
| `PUBLIC_URL` | déduit de la requête | URL publique utilisée dans les liens et QR codes |
| `DATA_DIR` | `./data` | Répertoire du fichier `db.json` |

> En production, définissez `ADMIN_CODE` et `SESSION_SECRET` (sinon le code de démonstration
> est affiché sur la page de connexion et la clé change à chaque redémarrage).

## Données

Stockage JSON dans `DATA_DIR/db.json`, écriture atomique et sérialisée. Sauvegardez ce
fichier ; montez un volume persistant sur `DATA_DIR` en conteneur.

## Sécurité

- Session signée HMAC-SHA256 dans un cookie `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS.
- Limitation de débit sur la connexion, le contact, le RSVP, le livre d'or et l'ajout d'invités.
- Routes d'administration protégées côté API et côté pages.
- Échappement HTML systématique dans les interfaces (`admin.js`, `scan.js`, `invitation.js`).
- QR code d'invitation public disponible sans authentification ; les routes de gestion restent protégées.

## Déploiement

Le `Dockerfile` fourni construit une image Node 20 (port 3000, données dans `/data`) :

```bash
docker build -t planning-events .
docker run -p 3000:3000 \
  -e ADMIN_CODE=... -e SESSION_SECRET=... -e PUBLIC_URL=https://votre-domaine \
  -v planning-data:/data planning-events
```
