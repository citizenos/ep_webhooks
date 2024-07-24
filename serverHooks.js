'use strict';

const PLUGIN_NAME = 'ep_webhooks';
const debounce = require('lodash.debounce');
const request = require('superagent');

const logger = require('ep_etherpad-lite/node_modules/log4js').getLogger(PLUGIN_NAME);

let pluginSettings; // set with loadSettings hook
let changedPads = {}; // Pads that have changed. key = padId, value = 1

/**
 * Call the webhooks
 *
 * The ``debounce`` is used to delay execution.
 *
 * @see {@link https://lodash.com/docs#debounce}
 */
const callPadUpdateWebhooks = debounce(() => {
  logger.debug('callPadUpdateWebhooks', changedPads);

  // No pads changed
  if (!Object.keys(changedPads).length) {
    return;
  }

  const changedPadIds = changedPads;

  const padIds = Object.keys(changedPadIds);
  padIds.forEach((padId) => {
    changedPadIds[padId].forEach((user) => {
      delete user.author;
    });
  });
  changedPads = {};

  const updateHooksToCall = pluginSettings?.pads?.update;
  if (Array.isArray(updateHooksToCall)) {
    // Fire and forget - no guarantees of delivery for now
    updateHooksToCall.forEach((path) => {
      const req = request.post(path);

      // The support for self signed certificates
      const caCert = pluginSettings.caCert;
      if (caCert) {
        req.ca(caCert);
      }

      req.set('X-API-KEY', pluginSettings.apiKey);
      req.send({ pads: changedPadIds });
      req.end((err, res) => {
        if (err) {
          logger.error(`
              allPadUpdateWebhooks - HTTP POST failed to , ${path}, . Error was', ${err}`,
          );
        }
      });
    });
  }
}, 1000, { maxWait: 5000 });

/**
 * handleMessage hook
 *
 * @param {string} hook_name
 * @param {object} context
 * @param {Function} cb Callback
 *
 * @see {@link http://etherpad.org/doc/v1.8.14/#index_handlemessage}
 */
exports.handleMessage = async (hook, { message, sessionInfo, client, socket }) => {
  logger.debug('ep_webhooks', hook, message);
  if (pluginSettings) {
    const messageType = message?.data?.type;
    if (messageType === 'USER_CHANGES') {
      const user = socket.client.request.session.user;
      const ip = socket.client.request.ip;
      const rev = message.data.baseRev;
      const padId = sessionInfo.padId;
      if (padId) {
        logger.debug('handleMessage', 'PAD CHANGED', padId);
        if (changedPads[padId]) {
          const userIndex = changedPads[padId].findIndex((e) => e.userId === user.id);
          if (userIndex > -1) {
            changedPads[padId].splice(userIndex, 1);
          }
        } else {
          changedPads[padId] = [];
        }
        // Use object, as then I don't need to worry about duplicates
        changedPads[padId].push({
          userId: user.id,
          rev,
          ip // eslint-disable-line comma-dangle
        });
      } else {
        logger.warn('handleMessage', 'Pad changed, but no padId!');
      }
    }
  }
};

/**
 * loadSettings
 *
 * @param {string} hook_name "loadSettings"
 * @param {object} args Object {settings: {object}}
 *
 * @see {@link http://etherpad.org/doc/v1.8.14/#index_loadsettings}
 */
exports.loadSettings = async (hook, args) => {
  logger.debug('ep_webhooks', hook, args);

  const settings = args.settings;
  if (settings && settings[PLUGIN_NAME]) {
    pluginSettings = settings[PLUGIN_NAME];

    logger.debug('loadSettings', 'pluginSettings', pluginSettings);

    const caCert = pluginSettings.caCert;
    if (caCert) {
      if (caCert.indexOf('-----BEGIN CERTIFICATE-----') !== 0) {
        const message = `Invalid configuration! If you provide caCert,
        make sure it looks like a cert.`;
        logger.error(message)
        throw new Error(message);
      }
    }
  }

};

exports.padUpdate = async (hook, { pad, authorId }) => {
  logger.debug('ep_webhooks', hook);
  if (pad.id && changedPads[pad.id] && changedPads[pad.id].length) {
    changedPads[pad.id].forEach((pad, key) => {
      if (pad.author === authorId) {
        changedPads[pad.id][key].rev = pad.head;
      }
    });
    callPadUpdateWebhooks();
  }
};

exports.userLeave = async (hookName, { authorId, padId }) => {
  callPadUpdateWebhooks();
};
