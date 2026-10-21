# my-PV

Affiche votre routeur solaire my-PV dans Gladys : AC•THOR, AC•THOR i,
AC•THOR 9s, AC ELWA 2, SOL•THOR, HEA•THOR IoT (y compris les versions
Viessmann, Greenheiss et Tuxhorn). La logique est reprise de
[py-mypv](https://github.com/my-pv/py-mypv), la bibliothèque officielle de
my-PV (Apache-2.0), utilisée par Home Assistant.

Intégration non officielle, sans lien avec my-PV. **Jamais testé avec un vrai
appareil** : les réponses ont été reconstituées à partir de py-mypv. Vos retours
sont les bienvenus.

## Ce que vous obtenez

Un appareil par routeur, avec, selon ce que votre modèle donne :

- l'état (veille, chauffe, boost, chauffe terminée, erreur, blocage…) ;
- la puissance de chauffe (W) ; la puissance et la tension solaires (SOL•THOR) ;
- la puissance au compteur (« surplus », en W, telle que l'appareil la donne :
  son signe n'est pas documenté par my-PV) ;
- les températures 1 à 4 (la sonde 1 est celle du ballon) et la température
  de l'appareil ;
- la charge du ballon d'eau chaude (%) ;
- chauffe activée, boost en cours (lecture seule) ;
- la consigne d'eau chaude et la consigne du boost ;
- les boutons « Démarrer le boost » et « Arrêter le boost ».

Il n'y a pas d'index d'énergie : l'appareil n'en donne pas.

## Connexion : le local d'abord

1. Donnez une adresse IP fixe à l'appareil dans votre box.
2. Dans la configuration de l'intégration, laissez **Connexion** sur
   « Locale », saisissez l'**adresse IP**.
3. Si l'interface web de l'appareil demande un mot de passe (micrologiciel
   récent, en HTTPS), saisissez-le dans **Mot de passe de l'appareil**. Il est
   gardé par Gladys dans sa base, jamais réaffiché, et envoyé seulement à votre
   appareil. L'appareil présente un certificat auto-signé : à la première
   connexion, l'intégration retient son empreinte, et refuse ensuite tout autre
   certificat (le mot de passe n'est alors pas envoyé). Si vous remplacez ou
   réinitialisez l'appareil, utilisez le bouton **Faire confiance au nouveau
   certificat**.
4. Enregistrez, puis ajoutez l'appareil depuis l'onglet **Découverte**.

Sans mot de passe, l'API locale n'a aucune protection : gardez l'appareil sur
un réseau de confiance.

### Le cloud my-PV (facultatif)

Seulement si l'appareil n'est pas sur votre réseau : choisissez « Cloud
my-PV », saisissez le **numéro de série** (affiché sur live.my-pv.com) et un
**jeton** créé dans votre compte my-PV. Le jeton est gardé par Gladys dans sa
base, jamais réaffiché, envoyé seulement à api.my-pv.com et jamais écrit dans
les journaux. Par le cloud, l'appareil est lu au plus une fois par minute.
L'appareil garde le même identifiant en local et par le cloud : passer de l'un
à l'autre garde son historique.

## Commandes de l'eau chaude (désactivées par défaut)

Risque de brûlure : l'eau chaude est **plafonnée à 55 °C par défaut**
(réglable de 40 à 60 °C, **jamais plus de 60 °C**, quoi qu'on saisisse).

- **Autoriser la consigne d'eau chaude** : Gladys peut changer la consigne
  (degrés entiers, de 10 °C au plafond).
- **Autoriser le démarrage du boost** : Gladys peut démarrer un boost manuel
  (chauffe sur le réseau jusqu'à la consigne du boost réglée sur l'appareil).
  Le démarrage est refusé si cette consigne du boost dépasse le plafond, si le
  mode boost est désactivé sur l'appareil, si l'appareil est arrêté ou sans
  sonde 1, ou en mode chauffage (AC•THOR).
- **Arrêter le boost** est toujours permis, sans option, même quand
  l'appareil demande de ralentir (un seul essai alors). Il annule un démarrage
  pas encore envoyé, et il est renvoyé une fois si un démarrage était en cours,
  ou si une relecture montre encore le boost en marche (dans les 90 s).

En local, une commande exige que les réglages de l'appareil donnent son numéro
de série (`serialno`) : si votre micrologiciel ne le donne pas, les commandes
sont refusées avec un message qui le dit (signalez-le, avec la version du
micrologiciel).

Chaque commande relit les réglages juste avant d'agir, vérifie à nouveau les
options et le plafond juste avant l'envoi, part dans les 3,5 s ou est refusée
sans être envoyée. Une commande qui a pu atteindre l'appareil sans réponse
claire est annoncée « envoyée, sans confirmation », puis l'appareil est relu
5 et 20 s plus tard. Une seule consigne ou un seul démarrage à la fois.

Les boutons et la consigne ne sont jamais des interrupteurs : un « éteins
tout » d'un assistant vocal ou d'une scène ne les atteint pas.

Le programme anti-légionelles de l'appareil (qui peut chauffer plus haut) n'est
pas piloté par Gladys : réglez-le sur l'appareil.

## Erreurs et limites

- Mot de passe ou jeton refusé : les lectures s'arrêtent (l'état est gardé
  dans /data), nouvel essai au plus une fois par heure, tout de suite si vous
  changez le mot de passe ou le jeton, ou avec **Tester la connexion**. Un
  refus d'une commande (401/403 sur une écriture) n'arrête pas les lectures.
- 429 ou erreur serveur : pause des lectures et des commandes (Retry-After,
  de 1 min à 6 h, 1 min sans Retry-After en local, gardée dans /data), sauf
  « Arrêter le boost ». Par le cloud, un 429 sur une commande n'est jamais
  renvoyé et met aussi en pause.
- Jamais de lecture plus rapide que l'intervalle, même après un redémarrage,
  un enregistrement ou un clic sur **Tester la connexion** (seuls une nouvelle
  adresse, un nouveau mot de passe ou un nouveau jeton lisent tout de suite).
- Appareil injoignable : nouvel essai après 30 s à 5 min, jamais plus vite que
  l'intervalle.
- Un AC ELWA 2 en mode de compatibilité AC ELWA-E n'est pas pris en charge
  (comme dans py-mypv).

## Dépannage

**Tester la connexion** lit l'appareil et affiche son état (ou, avant
l'intervalle, le dernier état et l'heure de la prochaine lecture). Les journaux de
l'intégration ne contiennent ni mot de passe, ni jeton, ni cookie.
