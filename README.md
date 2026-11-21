# Kontak v21

Application web de messages et d'appels, servie par Cloudflare.

## Déployer

1. Le dépôt est déjà relié à Cloudflare Workers.
2. Secret obligatoire, une seule fois, dans Cloudflare → Workers → kontak → Settings → Variables → Secret :

   Nom : `VAPID_JWK`

   Valeur : le JSON donné avec la version 21. Ne le commite pas.

3. La clé publique est déjà dans `wrangler.toml` (`VAPID_PUBLIC`).
4. Redéploie. La barre doit afficher **v21**.
5. Migration D1, si elle n'est pas déjà appliquée toute seule au premier message :

   `migrations/0003_v21.sql`

## Ce que v21 change

- Notifications : clé privée hors du code, erreur visible si le secret manque.
- Session à la place du mot de passe gardé dans le téléphone.
- Mot de passe ancien converti en PBKDF2 à la prochaine connexion.
- Message confirmé par le serveur avant de quitter la file.
- Appel identifié : un étranger ne peut pas le couper.
- Recherche dans toute la base, pas seulement 50 comptes.
- `/turn` demande une session.
- Mode **Rezo fèb** limite l'audio.
- Le contenu d'un message n'est pas écrit dans la notification.

Les numéros ne sont pas vérifiés par SMS. Ce n'est pas un chiffrement de bout en bout.
