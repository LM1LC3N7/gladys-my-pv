// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, the device status, the
// status of the integration, the answers of the buttons and the command
// errors. Never a password, a token nor an answer of the device.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

export const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

export const join = (parts) =>
  both(parts.map((p) => p.en).join(' '), parts.map((p) => p.fr).join(' '));

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
  [F.STATUS]: both('Status', 'État'),
  [F.HEATING_POWER]: both('Heating power', 'Puissance de chauffe'),
  [F.DEVICE_POWER]: both('Power read by the device (W)', "Puissance lue par l'appareil (W)"),
  [F.PV_POWER]: both('Solar power', 'Puissance solaire'),
  [F.PV_VOLTAGE]: both('Solar voltage', 'Tension solaire'),
  [F.METER_POWER]: both('Meter power, "surplus" (W)', 'Puissance au compteur, « surplus » (W)'),
  [F.TEMP_1]: both('Temperature 1 (tank)', 'Température 1 (ballon)'),
  [F.TEMP_2]: both('Temperature 2', 'Température 2'),
  [F.TEMP_3]: both('Temperature 3', 'Température 3'),
  [F.TEMP_4]: both('Temperature 4', 'Température 4'),
  [F.DEVICE_TEMP]: both('Device temperature', "Température de l'appareil"),
  [F.CHARGE]: both('Hot water charge', "Charge du ballon d'eau chaude"),
  [F.HEATING_ENABLED]: both('Heating enabled', 'Chauffe activée'),
  [F.BOOST_ACTIVE]: both('Boost running', 'Boost en cours'),
  [F.TARGET]: both('Hot water setpoint', "Consigne d'eau chaude"),
  [F.BOOST_TARGET]: both('Boost setpoint (read)', 'Consigne du boost (lue)'),
  [F.BOOST_START]: both('Start the boost', 'Démarrer le boost'),
  [F.BOOST_STOP]: both('Stop the boost', 'Arrêter le boost'),
};

/** screen_mode_flag (py-mypv 000000.json). */
export const SCREEN_NAMES = {
  0: both('Standby', 'Veille'),
  1: both('Heating', 'Chauffe'),
  2: both('Boost', 'Boost'),
  3: both('Heating finished', 'Chauffe terminée'),
  4: both('No connection or disabled', 'Sans connexion ou désactivé'),
  5: both('Error', 'Erreur'),
  6: both('Block active', 'Blocage actif'),
};

export const STATE_TEXTS = {
  unknownScreen: (code) => both(`Unknown status (${code})`, `État inconnu (${code})`),
  offline: both('Device unreachable', 'Appareil injoignable'),
  other: both('Another device answers at this address', 'Un autre appareil répond à cette adresse'),
};

const where = (config) =>
  config.connection === 'cloud'
    ? both('the my-PV cloud', 'le cloud my-PV')
    : both(`the device at ${config.label}`, `l'appareil ${config.label}`);

/** The integration status, the buttons and the logs a user may read. */
export const T = {
  noHost: both(
    'Enter the IP address of your my-PV device, then save.',
    "Saisissez l'adresse IP de votre appareil my-PV, puis enregistrez.",
  ),
  noCloud: both(
    'Enter the serial number of the device and your my-PV cloud token, then save.',
    "Saisissez le numéro de série de l'appareil et votre jeton du cloud my-PV, puis enregistrez.",
  ),
  badToken: both(
    'The cloud token contains characters that cannot be sent: type it again.',
    'Le jeton du cloud contient des caractères impossibles à envoyer : saisissez-le à nouveau.',
  ),
  invalid: ({ field, typed }) =>
    field === 'host'
      ? both(
          `Invalid address: ${typed} (an IPv4 address or a host name, with an optional port).`,
          `Adresse invalide : ${typed} (une adresse IPv4 ou un nom d'hôte, avec un port en option).`,
        )
      : both(
          `Invalid serial number: ${typed} (digits and letters, 6 to 32).`,
          `Numéro de série invalide : ${typed} (chiffres et lettres, de 6 à 32).`,
        ),
  connecting: both('Reading the device…', "Lecture de l'appareil…"),
  connected: (model, serial, via, notes = []) =>
    join([
      both(
        `Connected: ${model} ${serial} (${via === 'cloud' ? 'my-PV cloud' : 'local'}).`,
        `Connecté : ${model} ${serial} (${via === 'cloud' ? 'cloud my-PV' : 'local'}).`,
      ),
      ...notes,
    ]),
  unreachable: (config, reason, wait) => {
    const w = where(config);
    return both(
      `Could not read ${w.en} (${reason}; next try in ${wait.en}).`,
      `Lecture de ${w.fr} impossible (${reason} ; nouvel essai dans ${wait.fr}).`,
    );
  },
  offline: (wait) =>
    both(
      `The my-PV cloud says the device is offline (next try in ${wait.en}).`,
      `Le cloud my-PV indique que l'appareil est hors ligne (nouvel essai dans ${wait.fr}).`,
    ),
  paused: (wait) =>
    both(
      `The device asked to slow down (429 or a server error): reads paused for ${wait.en}.`,
      `L'appareil a demandé de ralentir (429 ou erreur serveur) : lectures en pause pendant ${wait.fr}.`,
    ),
  blocked: {
    auth: (config, wait) =>
      config.connection === 'cloud'
        ? both(
            `The my-PV cloud refused the token: check it, then save (next try in ${wait.en}).`,
            `Le cloud my-PV a refusé le jeton : vérifiez-le, puis enregistrez (nouvel essai dans ${wait.fr}).`,
          )
        : both(
            `The device refused the password: check it, then save (next try in ${wait.en}).`,
            `L'appareil a refusé le mot de passe : vérifiez-le, puis enregistrez (nouvel essai dans ${wait.fr}).`,
          ),
    needs_password: (_config, wait) =>
      both(
        `The device asks for a password (HTTPS): enter the password of its web interface, then save (next try in ${wait.en}).`,
        `L'appareil demande un mot de passe (HTTPS) : saisissez le mot de passe de son interface web, puis enregistrez (nouvel essai dans ${wait.fr}).`,
      ),
    certificate_changed: (_config, wait) =>
      both(
        `The certificate of the device changed since the first connection: the password is not sent. If you replaced or reset the device, press "Trust the new certificate" (next check in ${wait.en}).`,
        `Le certificat de l'appareil a changé depuis la première connexion : le mot de passe n'est pas envoyé. Si vous avez remplacé ou réinitialisé l'appareil, appuyez sur « Faire confiance au nouveau certificat » (nouvelle vérification dans ${wait.fr}).`,
      ),
  },
  unsupported: (serial, wait) =>
    both(
      `Unknown my-PV model (serial number ${serial}): only the AC•THOR, AC ELWA 2, SOL•THOR and HEA•THOR are supported (next try in ${wait.en}).`,
      `Modèle my-PV inconnu (numéro de série ${serial}) : seuls les AC•THOR, AC ELWA 2, SOL•THOR et HEA•THOR sont pris en charge (nouvel essai dans ${wait.fr}).`,
    ),
  compmode: (wait) =>
    both(
      `This AC ELWA 2 runs in an AC ELWA-E compatibility mode, not supported (next try in ${wait.en}).`,
      `Cet AC ELWA 2 fonctionne en mode de compatibilité AC ELWA-E, non pris en charge (nouvel essai dans ${wait.fr}).`,
    ),
  notes: {
    otherDevice: both(
      'The device created in Gladys is not the one read now: add the new device from the Discovery tab.',
      "L'appareil créé dans Gladys n'est pas celui lu maintenant : ajoutez le nouvel appareil depuis l'onglet Découverte.",
    ),
    aboveCap: (target, cap) =>
      both(
        `The hot water setpoint of the device (${target} °C) is above the ceiling of Gladys (${cap} °C).`,
        `La consigne d'eau chaude de l'appareil (${target} °C) dépasse le plafond de Gladys (${cap} °C).`,
      ),
  },
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
  trust: {
    done: both(
      'The certificate will be trusted at the next connection: reading the device now.',
      "Le certificat sera accepté à la prochaine connexion : lecture de l'appareil maintenant.",
    ),
    nothing: both(
      'No certificate is refused: nothing to do.',
      "Aucun certificat n'est refusé : rien à faire.",
    ),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  setpointDisabled: both(
    'The hot water setpoint is disabled: turn on "Allow the hot water setpoint" in the configuration of the integration.',
    "La consigne d'eau chaude est désactivée : activez « Autoriser la consigne d'eau chaude » dans la configuration de l'intégration.",
  ),
  boostDisabled: both(
    'Starting the boost is disabled: turn on "Allow starting the boost" in the configuration of the integration.',
    "Le démarrage du boost est désactivé : activez « Autoriser le démarrage du boost » dans la configuration de l'intégration.",
  ),
  badButton: both(
    'Unexpected button value: not sent.',
    'Valeur de bouton inattendue : non envoyée.',
  ),
  badNumber: both(
    'The setpoint must be a number: not sent.',
    'La consigne doit être un nombre : non envoyée.',
  ),
  badStep: both(
    'The setpoint must be a whole number of °C: not sent.',
    'La consigne doit être un nombre entier de °C : non envoyée.',
  ),
  outOfRange: (min, max) =>
    both(
      `The setpoint must be between ${min} and ${max} °C: not sent.`,
      `La consigne doit être comprise entre ${min} et ${max} °C : non envoyée.`,
    ),
  dhwCap: (cap) =>
    both(
      `Hot water is capped at ${cap} °C (scalding risk, see "Hot water ceiling" in the configuration): not sent.`,
      `L'eau chaude est plafonnée à ${cap} °C (risque de brûlure, voir « Plafond de l'eau chaude » dans la configuration) : non envoyée.`,
    ),
  boostAboveCap: (target, cap) =>
    both(
      `The boost setpoint of the device (${target} °C) is above the hot water ceiling (${cap} °C): lower it on the device first. Not sent.`,
      `La consigne du boost de l'appareil (${target} °C) dépasse le plafond de l'eau chaude (${cap} °C) : baissez-la d'abord sur l'appareil. Non envoyée.`,
    ),
  boostUnavailable: both(
    'The device has no boost now (boost mode off, device off, no temperature sensor 1, or space heating mode): not sent.',
    "L'appareil n'a pas de boost actuellement (mode boost désactivé, appareil arrêté, pas de sonde de température 1, ou mode chauffage) : non envoyée.",
  ),
  unknownDevice: both(
    'This device is not the one read now (device not answering, or another device): not sent.',
    "Cet appareil n'est pas celui lu actuellement (appareil sans réponse, ou autre appareil) : non envoyée.",
  ),
  stillRunning: both(
    'Another command to the device is still running: not sent.',
    "Une autre commande vers l'appareil est encore en cours : non envoyée.",
  ),
  stopMeanwhile: both(
    '"Stop the boost" was pressed meanwhile: the boost is not started.',
    "« Arrêter le boost » a été pressé entre-temps : le boost n'est pas démarré.",
  ),
  paused: (wait) =>
    both(
      `The device asked to slow down: commands paused for ${wait.en} ("Stop the boost" stays allowed). Not sent.`,
      `L'appareil a demandé de ralentir : commandes en pause pendant ${wait.fr} (« Arrêter le boost » reste permis). Non envoyée.`,
    ),
  blocked: both(
    'The device or the cloud refused the credentials (see the status of the integration): not sent.',
    "L'appareil ou le cloud a refusé les identifiants (voir l'état de l'intégration) : non envoyée.",
  ),
  tooSlow: both(
    'The device answered too slowly to send the command in time: not sent.',
    "L'appareil a répondu trop lentement pour envoyer la commande à temps : non envoyée.",
  ),
  unknownState: (reason) =>
    both(
      `The current settings could not be read just before (${reason}): command not sent.`,
      `Les réglages actuels n'ont pas pu être relus juste avant (${reason}) : commande non envoyée.`,
    ),
  missingValue: both(
    'The device did not give the current value needed for this command: not sent.',
    "L'appareil n'a pas donné la valeur actuelle nécessaire à cette commande : non envoyée.",
  ),
  notSent: (reason) =>
    both(
      `The device could not be reached (${reason}): command not sent.`,
      `L'appareil n'a pas pu être joint (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The device refused the command (${reason}).`,
      `L'appareil a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the value in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez la valeur dans quelques secondes.`,
    ),
};
