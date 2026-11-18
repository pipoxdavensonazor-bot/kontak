# Kontak — Messagerie + Appels vidéo

Application web autonome inspirée du projet Perchance « Kontak ».

## Fonctionnalités

- Inscription / connexion (numéro de téléphone + mot de passe)
- Recherche de contacts
- Conversations 1-à-1 en temps réel
- Indicateur « ap ekri… »
- Présence en ligne
- Appels vidéo WebRTC (360p) et appels audio
- Mode SAT (audio uniquement pour économiser les données)
- File d’attente hors-ligne (messages sauvegardés localement)
- Interface créole / français
- Configuration TURN pour les réseaux mobiles (Ayiti)

## Base de données

Les données sont stockées dans **SQLite** (`kontak.db`).

- Utilisateurs (téléphone, nom, mot de passe hashé)
- Conversations
- Messages

Le fichier `kontak.db` est créé automatiquement au premier lancement.

## Lancer l’application

```bash
cd kontak-app
npm install
npm start
```

Ouvrir http://localhost:3000

Pour tester les appels vidéo :
- Ouvrir deux fenêtres (normale + privée)
- Créer deux comptes
- Rechercher l’autre utilisateur et lancer un appel

**Note** : la caméra nécessite HTTPS ou localhost.

## Déploiement

L’application est un simple serveur Node.js + fichiers statiques.  
Vous pouvez la déployer sur Railway, Render, Fly.io, VPS, etc.

Pour les appels sur réseaux mobiles (NAT), configurez un serveur TURN (coturn) et entrez les identifiants dans le bouton **TURN**.

## Limitations MVP

- Pas de chiffrement de bout en bout
- Pas de groupes, pas de médias
- Pas de vérification SMS (OTP)
- Pas de push notifications

Pour une version production, vous pouvez migrer vers PostgreSQL.
