"use strict";
let extend = require("extend");
var ls = require("./lib/stream/leo-stream");
var logging = require("./lib/logging.js");
var LeoConfiguration = require("./lib/configuration.js");
var aws = require("./lib/leo-aws");
const fs = require("fs");
const ini = require('ini');
const execSync = require("child_process").execSync;

function SDK(id, data) {
	if (typeof id != "string") {
		data = id;
		id = data.id || "default_bot";
	}

	let configuration = new LeoConfiguration(data);


	if (configuration.aws.profile) {
		let profile = configuration.aws.profile;
		let hasMFA = false;
		let configFile = `${process.env.HOME || process.env.HOMEPATH}/.aws/config`;
		if (fs.existsSync(configFile)) {
			let config = ini.parse(fs.readFileSync(configFile, 'utf-8'));
			let p = config[`profile ${profile}`];
			if (p && p.mfa_serial) {
				let cacheFile = `${process.env.HOME || process.env.HOMEPATH}/.aws/cli/cache/${profile}--${p.role_arn.replace(/:/g, '_').replace(/[^A-Za-z0-9\-_]/g, '-')}.json`;
				let data = {};
				try {
					data = JSON.parse(fs.readFileSync(cacheFile));
				} catch (e) {
					// Ignore error, Referesh Credentials
					data = {};
				} finally {
					console.log("Using cached AWS credentials", profile)
					if (!data.Credentials || data.Credentials.Expiration < new Date(data.Credentials.Expiration)) {
						execSync('aws sts get-caller-identity --profile ' + profile);
						data = JSON.parse(fs.readFileSync(cacheFile));
					}
				}
				configuration.credentials = new aws.STS().credentialsFrom(data, data);
			} else {
				console.log("Switching AWS Profile", profile)
				configuration.credentials = new aws.SharedIniFileCredentials({
					profile: profile
				});
			}
		} else {
			console.log("Switching AWS Profile", configuration.aws.profile)
			configuration.credentials = new aws.SharedIniFileCredentials({
				profile: configuration.aws.profile
			});
		}
	}


	let logger = null;
	if (data && data.logging) {
		logger = logging(id, configuration);
	}

	var leoStream = ls(configuration);
	return Object.assign((id, data) => {
		return new SDK(id, data)
	}, {
		configuration: configuration,
		destroy: (callback) => {
			if (logger) {
				logger.end(callback);
			}
		},
		/**
		 * Stream for writing events to a queue
		 * @param {string} id - The id of the bot
		 * @param {string} outQueue - The queue into which events will be written 
		 * @param {Object} config - An object that contains config values that control the flow of events to outQueue
		 * @return {stream} Stream
		 */
		load: leoStream.load,

		/**
		 * Process events from a queue.
		 * @param {Object} opts
		 * @param {string} opts.id - The id of the bot
		 * @param {string} opts.inQueue - The queue from which events will be read
		 * @param {Object} opts.config - An object that contains config values that control the flow of events from inQueue
		 * @param {function} opts.batch - A function to batch data from inQueue (optional)
		 * @param {function} opts.each - A function to transform data from inQueue or from batch function, and offload from the platform
		 * @param {function} callback - A function called when all events have been processed. (payload, metadata, done) => { }
		 * @return {stream} Stream
		 */
		offload: leoStream.offload,

		/**
		 * Enrich events from one queue to another.
		 * @param {Object} opts
		 * @param {string} opts.id - The id of the bot
		 * @param {string} opts.inQueue - The queue from which events will be read
		 * @param {string} opts.outQueue - The queue into which events will be written 
		 * @param {Object} opts.config - An object that contains config values that control the flow of events from inQueue and to outQueue
		 * @param {function} opts.transform - A function to transform data from inQueue to outQueue
		 * @param {function} callback - A function called when all events have been processed. (payload, metadata, done) => { }
		 * @return {stream} Stream
		 */
		enrich: leoStream.enrich,

		read: leoStream.fromLeo,
		write: leoStream.toLeo,
		put: function (bot_id, queue, payload, callback) {
			let stream = this.load(bot_id, queue, {
				kinesis: {
					records: 1
				}
			});
			stream.write(payload);
			stream.end(callback);
		},
		checkpoint: leoStream.toCheckpoint,
		streams: leoStream,
		bot: leoStream.cron,
		aws: {
			dynamodb: leoStream.dynamodb,
			s3: leoStream.s3,
			cloudformation: new aws.CloudFormation({
				region: configuration.aws.region,
				credentials: configuration.credentials
			})
		}
	});
}



module.exports = new SDK(false);