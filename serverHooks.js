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

  const changedPadIds = changedPads;

  const padIds = Object.keys(changedPadIds);
  padIds.forEach((padId) => {
    changedPadIds[padId].forEach((user) => {
      delete user.author;
    });
  });
  changedPads = {};

  const updateHooksToCall = _.get(pluginSettings, ['pads', 'update']);

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
      req.send({pads: changedPadIds});
      req.end((err, res) => {
        if (err) {
          logger.error(`
              allPadUpdateWebhooks - HTTP POST failed to , ${path}, . Error was', ${err}`
          );
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
 * @see {@link http://etherpad.org/doc/v1.8.14/#index_handlemessage}
 */
exports.handleMessage = (hook, context, cb) => {
  logger.debug('ep_webhooks', hook, context);

  if (pluginSettings) {
    const messageType = _.get(context.message, 'data.type');

    if (messageType === 'USER_CHANGES') {
      const user = _.get(context, 'client.conn.request.session.user');
      const clientId = _.get(context, 'client.id');
      const ip = _.get(context, 'client.conn.request.ip');
      const rev = _.get(padMessageHandler, `sessioninfos[${clientId}].rev`);
      const padId = _.get(padMessageHandler, `sessioninfos[${clientId}].padId`);
      const author = _.get(padMessageHandler, `sessioninfos[${clientId}].author`);

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
          author,
          rev,
          ip // eslint-disable-line comma-dangle
        });
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
 * @see {@link http://etherpad.org/doc/v1.8.14/#index_loadsettings}
 */
exports.loadSettings = (hook, args, cb) => {
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
        logger.error(message);
        throw new Error(message);
      }
    }
  }

  return cb();
};

exports.padUpdate = (hook, context, cb) => {
  logger.debug('ep_webhooks', hook, context);

  if (context.pad.id && changedPads[context.pad.id] && changedPads[context.pad.id].length) {
    changedPads[context.pad.id].forEach((pad, key) => {
      if (pad.author === context.author) {
        changedPads[context.pad.id][key].rev = context.pad.head;
      }
    });
    callPadUpdateWebhooks();
    return cb(true);
  } else {
    return cb();
  }
};
