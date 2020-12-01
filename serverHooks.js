'use strict';

const PLUGIN_NAME = 'ep_webhooks';
const _ = require('lodash');
const request = require('superagent');

const logger = require('ep_etherpad-lite/node_modules/log4js').getLogger(PLUGIN_NAME);
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler.js');

let pluginSettings; // set with loadSettings hook
let changedPads = {}; // Pads that have changed. key = padId, value = 1

/**
 * Call the webhooks
 *
 * The ``debounce`` is used to delay execution.
 *
 * @see {@link https://lodash.com/docs#debounce}
 */
const callPadUpdateWebhooks = _.debounce(() => {
  logger.debug('callPadUpdateWebhooks', changedPads);

  // No pads changed
  if (!Object.keys(changedPads).length) {
    return;
  }

  const changedPadIds = Object.keys(changedPads);
  changedPads = {};

  const updateHooksToCall = _.get(pluginSettings, ['pads', 'update']);

  if (Array.isArray(updateHooksToCall)) {
    // Fire and forget - no guarantees of delivery for now
    updateHooksToCall.forEach((path) => {
      const req = request
          .post(path);

      // The support for self signed certificates
      const caCert = pluginSettings.caCert;
      if (caCert) {
        req.ca(caCert);
      }

      req
          .set('X-API-KEY', pluginSettings.apiKey)
          .send({padIds: changedPadIds})
          .end((err, res) => {
            if (err) {
              logger.error('callPadUpdateWebhooks - HTTP POST failed to ',
                  path,
                  '. Error was',
                  err);
            }
          });
    });
  }
}, 1000, {maxWait: 5000});

/**
 * handleMessage hook
 *
 * @param {string} hook_name
 * @param {object} context
 * @param {Function} cb Callback
 *
 * @see {@link http://etherpad.org/doc/v1.5.7/#index_handlemessage}
 */
exports.handleMessage = (hook, context, cb) => {
  logger.debug('handleMessage');

  if (pluginSettings) {
    const messageType = _.get(context.message, 'data.type');

    if (messageType === 'USER_CHANGES') {
      const padId = _.get(padMessageHandler.sessioninfos[context.client.id], 'padId');
      if (padId) {
        logger.debug('handleMessage', 'PAD CHANGED', padId);
        changedPads[padId] = 1; // Use object, as then I don't need to worry about duplicates
        callPadUpdateWebhooks();
      } else {
        logger.warn('handleMessage', 'Pad changed, but no padId!');
      }
    }
  }

  return cb([context.message]);
};

/**
 * loadSettings
 *
 * @param {string} hook_name "loadSettings"
 * @param {object} args Object {settings: {object}}
 *
 * @see {@link http://etherpad.org/doc/v1.5.7/#index_loadsettings}
 */
exports.loadSettings = (hook, args, cb) => {
  const settings = args.settings;
  if (settings && settings[PLUGIN_NAME]) {
    pluginSettings = settings[PLUGIN_NAME];

    logger.debug('loadSettings', 'pluginSettings', pluginSettings);

    const caCert = pluginSettings.caCert;
    if (caCert) {
      if (caCert.indexOf('-----BEGIN CERTIFICATE-----') !== 0) {
        const message = `Invalid configuration! If you provide caCert,
        make sure it looks like a cert.`;
        logger.error(message);
        throw new Error(message);
      }
    }
  } else {
    logger.warn('Plugin configuration not found, doing nothing.');
  }

  return cb();
};
