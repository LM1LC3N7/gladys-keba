// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES, STATE } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.CABLE_STATION]: both('Cable plugged at the station', 'Câble branché sur la borne'),
  [FEATURES.CABLE_LOCKED]: both('Cable locked', 'Câble verrouillé'),
  [FEATURES.POWER]: both('Power', 'Puissance'),
  [FEATURES.CURRENT_L1]: both('Current L1', 'Courant L1'),
  [FEATURES.CURRENT_L2]: both('Current L2', 'Courant L2'),
  [FEATURES.CURRENT_L3]: both('Current L3', 'Courant L3'),
  [FEATURES.VOLTAGE_L1]: both('Voltage L1', 'Tension L1'),
  [FEATURES.VOLTAGE_L2]: both('Voltage L2', 'Tension L2'),
  [FEATURES.VOLTAGE_L3]: both('Voltage L3', 'Tension L3'),
  [FEATURES.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [FEATURES.TOTAL_ENERGY]: both('Total energy', 'Énergie totale'),
  [FEATURES.MAX_CURRENT]: both('Maximum current allowed', 'Courant maximal autorisé'),
  [FEATURES.ENABLED_SYSTEM]: both('Charging enabled (station)', 'Charge activée (borne)'),
  [FEATURES.ENABLED_USER]: both('Charging allowed (ena)', 'Charge autorisée (ena)'),
  [FEATURES.FAILSAFE]: both('Failsafe mode', 'Mode de repli'),
  [FEATURES.AUTH_REQUIRED]: both('Authorization required', 'Autorisation requise'),
  [FEATURES.ENABLE]: both('Allow charging', 'Autoriser la charge'),
  [FEATURES.DISABLE]: both('Forbid charging', 'Interdire la charge'),
  [FEATURES.SET_CURRENT]: both('Set the charging current', 'Régler le courant de charge'),
};

export const STATE_NAMES = {
  [STATE.STARTING]: both('Starting', 'Démarrage'),
  [STATE.NOT_READY]: both('Not ready for charging', 'Pas prête pour la charge'),
  [STATE.READY]: both('Ready for charging', 'Prête pour la charge'),
  [STATE.CHARGING]: both('Charging', 'En charge'),
  [STATE.ERROR]: both('Error', 'Erreur'),
  [STATE.AUTH_REJECTED]: both('Authorization rejected', 'Autorisation refusée'),
};
export const UNKNOWN_STATE = both('Unknown state', 'État inconnu');
export const OFFLINE = both('Station unreachable', 'Borne injoignable');

/** The integration status, the button and the logs a user may read. */
export const T = {
  noAddress: both(
    'Enter the IP address of your KEBA station, then save.',
    "Saisissez l'adresse IP de votre borne KEBA, puis enregistrez.",
  ),
  /** `entries`: `{ text, reason: 'invalid' | 'too_many' }` from normalizeConfig. */
  invalid: (entries) => {
    const list = (language) =>
      entries
        .map(({ text, reason }) =>
          reason === 'too_many'
            ? `${text} (${language === 'en' ? 'eight at most' : 'huit au plus'})`
            : text,
        )
        .join(', ');
    return both(
      `Address ignored (an IPv4 address is expected): ${list('en')}.`,
      `Adresse ignorée (une adresse IPv4 est attendue) : ${list('fr')}.`,
    );
  },
  orphans: (names) =>
    both(
      `Not read any more: ${names} (address removed or not answering).`,
      `Plus lue : ${names} (adresse retirée ou sans réponse).`,
    ),
  connecting: both('Reading the station…', 'Lecture de la borne…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (list, wait) =>
    both(
      `No answer from ${list} (next try in ${wait.en}). Check the address, that the UDP interface of the station is on (DIP switch), and that nothing else on this host uses UDP port 7090.`,
      `Pas de réponse de ${list} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse, que l'interface UDP de la borne est activée (micro-interrupteur DIP), et que rien d'autre sur cet hôte n'utilise le port UDP 7090.`,
    ),
  portBusy: (wait) =>
    both(
      `UDP port 7090 cannot be opened in the container (next try in ${wait.en}).`,
      `Le port UDP 7090 ne peut pas être ouvert dans le conteneur (nouvel essai dans ${wait.fr}).`,
    ),
  noId: both(
    'The station answered without a valid serial number or product: it cannot be added.',
    'La borne a répondu sans numéro de série ou produit valable : elle ne peut pas être ajoutée.',
  ),
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
  /** A command the station accepted (TCH-OK) but never applied. */
  notApplied: (name, kind) => {
    const what =
      kind === 'curr'
        ? both('the charging current', 'le courant de charge')
        : both('allowing / forbidding the charge', "l'autorisation ou l'interdiction de la charge");
    return both(
      `${name} accepted ${what.en} without applying it: model (c-series?) or setting (DSW1.3, load management).`,
      `${name} a accepté ${what.fr} sans l'appliquer : modèle (c-series ?) ou réglage (DSW1.3, gestion de charge).`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  unknownStation: both(
    'This station is not read by the integration (address missing or not answering).',
    "Cette borne n'est pas lue par l'intégration (adresse absente ou sans réponse).",
  ),
  otherStation: both(
    'Another station answers at this address now: command refused, not sent.',
    'Une autre borne répond maintenant à cette adresse : commande refusée, non envoyée.',
  ),
  unsupported: (product) =>
    both(
      `This product (${product}) is not one the integration knows how to drive: command refused, not sent.`,
      `Ce produit (${product}) n'est pas un modèle que l'intégration sait piloter : commande refusée, non envoyée.`,
    ),
  badButton: both('A button only accepts the value 1.', "Un bouton n'accepte que la valeur 1."),
  badCurrent: both(
    'The charging current must be a whole number of amperes.',
    "Le courant de charge doit être un nombre entier d'ampères.",
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be between ${min} and ${max} A for this station: not sent.`,
      `Le courant de charge doit être entre ${min} et ${max} A pour cette borne : non envoyé.`,
    ),
  unknownBounds: both(
    'The station does not give its hardware current limit now (cable unplugged?): command refused, not sent.',
    'La borne ne donne pas sa limite matérielle de courant en ce moment (câble débranché ?) : commande refusée, non envoyée.',
  ),
  stillRunning: both(
    'Another command of this station is still running: not sent.',
    'Une autre commande de cette borne est encore en cours : non envoyée.',
  ),
  disableMeanwhile: both(
    'A "forbid charging" of this station arrived meanwhile: this command is not sent.',
    "Une « interdiction de charge » de cette borne est arrivée entre-temps : cette commande n'est pas envoyée.",
  ),
  tooSlow: both(
    'The station answered too slowly to send the command in time: not sent.',
    'La borne a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  channelBusy: both(
    'The link to the stations was busy (other reads or commands in progress): command not sent, try again.',
    'La liaison avec les bornes était occupée (autres lectures ou commandes en cours) : commande non envoyée, réessayez.',
  ),
  currTooOften: (wait) =>
    both(
      `The charging current is changed at most once a minute per station (next possible in ${wait.en}): not sent. "Forbid charging" stays available.`,
      `Le courant de charge se change au plus une fois par minute et par borne (prochain possible dans ${wait.fr}) : non envoyé. « Interdire la charge » reste disponible.`,
    ),
  unsureState: both(
    'The answer of the station may be a late one of an earlier read: command not sent, try again in a few seconds.',
    "La réponse de la borne est peut-être celle, en retard, d'une lecture précédente : commande non envoyée, réessayez dans quelques secondes.",
  ),
  noSerial: both(
    'The station does not give its serial number in its state report: it is read only, commands refused.',
    "La borne ne donne pas son numéro de série dans son rapport d'état : elle est en lecture seule, commandes refusées.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the station could not be read just before (${reason}): command not sent.`,
      `L'état de la borne n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  missing: both(
    'The station did not give the state this command needs: not sent.',
    "La borne n'a pas donné l'état dont cette commande a besoin : non envoyée.",
  ),
  notSent: (reason) =>
    both(
      `The command could not be sent (${reason}).`,
      `La commande n'a pas pu être envoyée (${reason}).`,
    ),
  refused: both(
    'The station refused the command (TCH-ERR): its model or its configuration (DIP switches, UDP interface, load management) may not allow it.',
    'La borne a refusé la commande (TCH-ERR) : son modèle ou sa configuration (micro-interrupteurs DIP, interface UDP, gestion de charge) ne le permet peut-être pas.',
  ),
  sentUnconfirmed: both(
    'Command sent, without confirmation (no sure answer from the station): check its state in a few seconds.',
    'Commande envoyée, sans confirmation (pas de réponse sûre de la borne) : vérifiez son état dans quelques secondes.',
  ),
};

/** The one-line summary of a station: "KEBA P30 1234: Charging, 7200 W, maximum 16 A". */
export function summaryOf({ name, state, power, maxCurrent }) {
  const label = STATE_NAMES[state] ?? UNKNOWN_STATE;
  const en = [label.en];
  const fr = [label.fr];
  if (power !== undefined) {
    en.push(`${power} W`);
    fr.push(`${power} W`);
  }
  if (maxCurrent !== undefined) {
    en.push(`maximum ${maxCurrent} A`);
    fr.push(`maximum ${maxCurrent} A`);
  }
  return both(`${name}: ${en.join(', ')}.`, `${name} : ${fr.join(', ')}.`);
}
