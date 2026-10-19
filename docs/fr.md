# KEBA KeContact pour Gladys

Suivez votre borne de recharge **KEBA KeContact P20 ou P30** (ou une wallbox
BMW qui en dérive) dans Gladys, par son **interface UDP locale** (port 7090),
sans cloud.

> Intégration non officielle, **jamais testée avec une vraie borne** : elle
> suit la bibliothèque keba-kecontact (celle de Home Assistant) et le guide UDP
> de KEBA. Vos retours sont les bienvenus. Sans lien avec KEBA.

## Ce que vous obtenez

Un appareil par borne (identifiée par son numéro de série), avec :

- **État** de la borne (démarrage, pas prête, prête, en charge, erreur,
  autorisation refusée), **connecteur** et **état de charge** ;
- **prise et câble** : véhicule branché, câble branché sur la borne, câble
  verrouillé ;
- **puissance** (W), **courant** (A) et **tension** (V) de chaque phase ;
- **énergie de la session** et **énergie totale** (kWh) : de simples capteurs,
  jamais un index du suivi énergétique (la borne est déjà derrière votre
  compteur, elle serait comptée deux fois) ;
- **courant maximal autorisé** (A), **charge activée** par la borne et
  **charge autorisée** (« ena »), **mode failsafe** actif ou non,
  **autorisation requise** (RFID) ;
- en option, trois commandes (voir plus bas).

Une borne sans compteur intégré (P20 e-series, P30 « Deutschland Edition »)
ne donne ni puissance, ni courant, ni tension, ni énergie : ces fonctionnalités
restent vides.

## 1. Activer l'interface UDP sur la borne

L'interface UDP (« smart home interface ») est **désactivée en usine**. Sur une
P20 ou une P30 c-series, elle s'active par un **DIP switch** dans la borne :
d'après la documentation KEBA, le commutateur **DSW1.3** sur **ON** (à vérifier
dans le manuel d'installation de votre modèle). Sur une P30 x-series, elle se
règle dans son interface web (paramètre « UDP » / « Smart Home interface »).

**Faites-le faire par un électricien** : il faut ouvrir la borne, hors
tension. Ne touchez pas aux autres commutateurs (courant maximal, etc.).

La borne doit être reliée à votre réseau (câble Ethernet) avec une **adresse
IP fixe** (réservation DHCP dans votre box).

## 2. Configurer l'intégration

1. Dans Gladys, installez l'intégration **KEBA KeContact** depuis le store.
2. Saisissez l'**adresse IP** de la borne (une adresse IPv4 ; plusieurs bornes :
   séparez-les par des virgules, huit au plus), puis enregistrez.
3. Ouvrez l'onglet **Découverte** et ajoutez la borne.

Le bouton **Tester la connexion** lit chaque borne une fois.

## Sécurité : aucune authentification

L'interface UDP de KEBA **n'a aucune authentification** : tout appareil de
votre réseau local peut lire la borne et lui envoyer des commandes, même sans
Gladys. Gardez la borne sur un **réseau local de confiance** (jamais exposée
sur Internet, idéalement sur un réseau séparé des invités et des objets peu
sûrs). Activer les commandes dans Gladys n'ouvre rien de plus sur la borne,
mais permet à Gladys (scènes, chat IA par MCP, comptes Gladys) de les envoyer.

## Commandes (désactivées par défaut)

Avec l'option **Autoriser les commandes** :

- **Autoriser la charge** et **Interdire la charge** : deux boutons qui
  envoient `ena 1` et `ena 0` ;
- **Régler le courant de charge** : une liste de 6 A à la limite matérielle de
  la borne (`curr`).

Jamais d'interrupteur : un « tout éteindre » d'un assistant vocal ou d'une
scène ne peut pas couper la charge. Avant chaque commande, la borne est relue
(rapport 2) et la commande décidée sur cette lecture ; le courant est refusé
au-dessus de la limite matérielle lue à ce moment (`Curr HW`). Une commande sans
réponse est dite « envoyée, sans confirmation » ; un refus de la borne
(`TCH-ERR`) est affiché tel quel : selon KEBA, certains modèles ou réglages
(DIP switches, gestion de charge d'un groupe de bornes) refusent ces commandes.
Un produit que l'intégration ne reconnaît pas (ni KEBA P20/P30, ni BMW) refuse
les commandes.

Le **mode failsafe** est seulement lu : l'intégration ne le modifie jamais.
Démarrer ou arrêter une session avec un badge RFID n'est pas proposé.

Avec les commandes autorisées, le chat IA de Gladys (MCP) peut créer et lancer
une scène qui autorise ou interdit la charge.

## Réseau et Docker

La borne répond au **port UDP 7090 de l'expéditeur**. L'intégration ouvre ce
port dans son conteneur ; les réponses passent par le réseau Docker de Gladys
(NAT) sans réglage. Si un autre programme de la même machine parle déjà à la
borne depuis le port 7090 (Home Assistant en réseau hôte, par exemple), les
réponses peuvent se perdre : n'utilisez qu'un seul des deux. Ce point n'a pas
été vérifié sur une vraie installation.

## Rythme

Chaque borne est lue toutes les 30 s par défaut (10 s à 10 min) : rapport 2
(état), rapport 3 (compteur), et le rapport 1 (identité) une fois par heure.
Une seule requête à la fois, 100 ms au moins entre deux messages (2 s après
`ena 0`), comme keba-kecontact. Une borne qui ne répond plus est relue après
30 s, 1, 2 puis 5 min ; elle apparaît « Borne injoignable ».

## Limites

- Jamais testé avec une vraie borne.
- Adresses IPv4 seulement (une réponse est attribuée à sa requête par son
  adresse source).
- Pas de découverte automatique (le broadcast ne traverse pas le réseau Docker).
- Pas de démarrage par badge RFID, pas de failsafe, pas de bascule de phases,
  pas d'historique des sessions (rapports 1xx).

## Crédits

Le protocole est porté de **keba-kecontact** (MIT, Philipp Danner), la
bibliothèque de l'intégration KEBA de Home Assistant. Voir
`THIRD_PARTY_NOTICES.md`. KEBA et KeContact sont des marques de KEBA AG.
