# Kontak v24

Messagerie temps réel et appels audio/vidéo (WebRTC), en créole haïtien.
Servie par **Cloudflare Workers** : un Worker (`src/worker.js`), un Durable Object
`KontakRoom` pour les WebSockets, une base **D1** (`kontak`), un bucket **R2** privé
(`kontak-media`, notes vocales et photos) et les fichiers statiques de `public/`.

Production : https://kontak.pipoxdavensonazor.workers.dev

## Démarrer en local

```sh
npm ci
npm run vapid:gen -- --dotenv > .dev.vars   # clés de test, fichier ignoré par git
npm run db:migrate:local
npm run dev                                  # wrangler dev sur http://localhost:8787
```

## Tests

```sh
npm test            # vitest + @cloudflare/vitest-plugin (runtime Workers, D1 local)
```

La CI GitHub Actions (`.github/workflows/ci.yml`) lance `npm ci`, les tests,
`npm audit --audit-level=high` et `wrangler deploy --dry-run`.

## Secrets requis (jamais dans le dépôt)

| Nom | Rôle | Obligatoire |
| --- | --- | --- |
| `VAPID_PUBLIC` | clé publique Web Push (base64url) | oui, sinon `/vapid` répond 503 et pas de notifications |
| `VAPID_JWK` | clé privée VAPID au format JWK (JSON) | oui |
| `TURN_KEY_ID` / `TURN_API_TOKEN` | relais TURN Cloudflare Calls (Realtime) | non : sans eux, `/turn` donne STUN seul |
| `ALLOWED_ORIGINS` | origines WebSocket en plus du domaine du Worker (liste séparée par des virgules) | non |

```sh
npm run vapid:gen                       # imprime une nouvelle paire, n'écrit rien
npx wrangler secret put VAPID_PUBLIC    # coller la valeur
npx wrangler secret put VAPID_JWK
```

Changer la paire VAPID est sans risque : l'application compare la clé du serveur à celle
de son abonnement et se réabonne toute seule ; les abonnements morts (404/410) sont supprimés.

## Déployer

```sh
npm test
npm run deploy          # wrangler deploy
```

## Base D1

Les migrations sont dans `migrations/` (`npm run db:migrate:local` / `npm run db:migrate:remote`).
`0004_push_calls.sql` déclare les tables `push_subs` et `calls`, autrefois créées seulement
au démarrage ; tout y est en `IF NOT EXISTS`.

## Notes vocales et photos (v24)

- Bouton 🎤 dans la conversation : appuyer pour enregistrer, puis **Anile** ou **Voye**. 2 minutes maximum.
  Opus/webm (repli AAC/mp4 sur iPhone), mono, 24 kbit/s (12 kbit/s en mode **Rezo fèb**), soit ~180 Ko pour 1 minute.
- Bouton 📷 : la photo est réduite dans le téléphone (1280 px, 800 px en Rezo fèb, JPEG) avant l'envoi.
- `POST /media?convId=&kind=voice|photo&duration=` (session obligatoire, membre de la conversation, 1,5 Mo max),
  puis message WebSocket `sendMessage { convId, mediaId }`.
- `GET /media/<id>` : réservé aux membres de la conversation (404 sinon), identifiants aléatoires de 128 bits, jamais d'URL publique.
- Lecture dans la bulle : rien n'est téléchargé avant d'appuyer sur ▶. En Rezo fèb, les photos ne se chargent qu'à la demande.
- Les anciens clients (v23) voient un texte « 🎤 Not vokal (0:12) » / « 📷 Foto ».
- Les métadonnées sont dans la table D1 `media` (migration 0005).

## Ce que v23 change

- Notifications : clés VAPID uniquement en secrets (plus de clé dans `wrangler.toml`), réabonnement automatique après rotation.
- Appels : plus de secret Open Relay dans le code ; TURN Cloudflare Calls si configuré, sinon STUN.
- Mot de passe d'au moins 8 caractères pour les nouveaux comptes (les anciens comptes se connectent toujours, hash migré en PBKDF2).
- Vie privée : la recherche par nom masque les numéros ; la recherche par numéro exige le numéro complet ; les photos ne sont visibles que par les contacts, conversations et résultats de recherche.
- Chaque message WebSocket est validé par un schéma Zod ; les connexions WebSocket sans `Origin` ou d'une autre origine sont refusées.
- Nettoyage : anciens fichiers Express/Render retirés, scripts npm Wrangler, tests et CI.

Les numéros ne sont pas vérifiés par SMS. Ce n'est pas un chiffrement de bout en bout.
