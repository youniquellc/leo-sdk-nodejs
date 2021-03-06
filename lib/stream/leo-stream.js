"use strict";
var through = require('through2').obj;
var pump = require("pump");
var pumpify = require("pumpify").obj;
var split = require("split2");
var zlib = require("zlib");
var fastCsv = require("fast-csv");
var write = require("flush-write-stream");
var AWS = require("../leo-aws");
var https = require("https");
var PassThrough = require('stream').PassThrough;
var stream = require("stream");
var moment = require("moment");
var async = require("async");

var backoff = require("backoff");
var extend = require("extend");

var leoS3 = require("./helper/leos3.js");
var chunkEventStream = require("./helper/chunkEventStream.js");
var cronlib = require("../cron.js");
var dynamo = require("../dynamodb.js");
var refUtil = require("../reference.js");
var _streams = require("../streams");

const logger = require("../logger")("leo-stream");

module.exports = function (configure) {
	configure = configure || {};
	if (!configure.validate) {
		configure.validate = () => {
			throw new Error("Invalid Settings: Missing config")
		}
	}

	process.__config = process.__config || configure;
	process.__config.registry = process.__config.registry || {};
	configure.registry = extend(true, process.__config.registry, configure.registry || {});
	var leo = configure.leo;

	var CRON_TABLE = configure.resources.LeoCron;
	var EVENT_TABLE = configure.resources.LeoEvent;

	var kinesis = new AWS.Kinesis({
		region: configure.aws.region,
		credentials: configure.credentials
	});
	var dynamodb = new dynamo(configure);
	var firehose = new AWS.Firehose({
		region: configure.aws.region,
		credentials: configure.credentials
	});
	var s3 = new AWS.S3({
		apiVersion: '2006-03-01',
		httpOptions: {
			agent: new https.Agent({
				keepAlive: true
			})
		},
		credentials: configure.credentials
	});

	var cron = cronlib(configure);
	var pad = "0000000";
	var padLength = -1 * pad.length;
	var ls = {
		s3: s3,
		dynamodb: dynamodb,
		cron: cron,
		configuration: configure,
		through: _streams.through,
		pipeline: _streams.pipeline,
		split: _streams.split,
		gzip: _streams.gzip,
		gunzip: _streams.gunzip,
		write: _streams.write,
		pipe: _streams.pipe,
		stringify: _streams.stringify,
		parse: _streams.parse,
		fromCSV: _streams.fromCSV,
		toCSV: _streams.toCSV,
		toGzipChunks: function (event, opts) {
			return chunkEventStream(this, event, opts);
		},
		toS3GzipChunks: function (event, opts) {
			return leoS3(this, event, configure, opts);
		},
		toS3: (Bucket, File) => {
			var callback = null;
			var pass = new PassThrough();
			s3.upload({
				Bucket: Bucket,
				Key: File,
				Body: pass
			}, (err) => {
				logger.info("done uploading", err);
				callback(err);
			});
			return write((s, enc, done) => {
				if (!pass.write(s)) {
					pass.once('drain', () => {
						done();
					});
				} else {
					done();
				}
			}, (cb) => {
				callback = cb;
				pass.end();
			});
		},
		fromS3: (file, opts) => {
			return s3.getObject({
				Bucket: file.bucket || file.Bucket,
				Key: file.key || file.Key,
				Range: file.range || undefined
			}).createReadStream();
		},
		asEvent: _streams.asEvent,
		log: _streams.log,
		logSourceRead: function (id, inSystem, recordCount, opts, callback) {
			var types = {};

			[].slice.call(arguments).forEach(a => {
				var b = types[typeof (a)];
				if (!b) {
					b = types[typeof (a)] = [];
				}
				b.push(a)
			});

			/* 
				id - the first string argument if there are 2 or more strings, otherwise it comes from config.registry.id
				inSystem - the second string argument if there are 2 or more strings, otherwise it is the first string
				callback - the first function argument
				opts - the  first object argument, otherwise {}
				recordCount - the first number, otherwise 0
			*/
			callback = types.function && types.function[0];
			opts = types.object && types.object[0] || {};
			id = types.string && types.string.length >= 2 && types.string[0] || configure.registry.id;
			inSystem = types.string && (types.string.length == 1 ? types.string[0] : types.string[1]);
			recordCount = types.number && types.number[0] || 0;
			opts = opts || {};

			inSystem = refUtil.ref(inSystem, "system").asQueue(opts.subqueue).id
			id = refUtil.botRef(id).id;

			cron.checkpoint(id, inSystem, {
				eid: moment.now(),
				records: recordCount,
				started_timestamp: opts.timestamp,
				timestamp: opts.timestamp || moment.now(),
				source_timestamp: opts.source_timestamp || opts.event_source_timestamp || moment.now()
			}, function (err, data) {
				logger.error(err, data);
				if (callback) callback();
			});
		},
		logTargetWrite: function (id, outSystem, recordCount, opts, callback) {
			logger.info(id, outSystem);
			id = refUtil.botRef(id).id;
			outSystem = refUtil.ref(outSystem, "system").asQueue(opts.subqueue).id;
			if (typeof opts == "function") {
				callback = opts;
				opts = {};
			}
			opts = opts || {};
			ls.putEvent(id, outSystem, {
				records: recordCount
			}, {
				metadata: {
					units: recordCount
				}
			}, callback);
		},
		devnull: _streams.devnull,
		load: function (id, outQueue, opts) {
			configure.validate();
			opts = Object.assign({
				useS3: false,
				autoDetectPayload: true
			}, opts || {});
			var args = [];

			args.push(ls.through((obj, done) => {
				var e;
				if (opts.autoDetectPayload && obj.payload) {
					e = obj;
				} else {
					e = {
						payload: obj
					}
				}
				e.id = id;
				e.event = outQueue;
				if (!e.event_source_timestamp) {
					e.event_source_timestamp = moment.now();
				}
				if (!e.timestamp) {
					e.timestamp = moment.now();
				}
				done(null, e);
			}));
			if (opts.useS3 && !opts.firehose) {
				args.push(leoS3(ls, outQueue, configure));
			}
			args.push(ls.toLeo(id, opts));
			// else {
			// 	args.push(ls.autoSwitch(outQueue, opts))
			// }
			args.push(ls.toCheckpoint({
				debug: opts.debug
			}));

			return ls.pipeline.apply(ls, args);
		},
		enrich: function (opts, callback) {
			configure.validate();
			var id = opts.id;
			var inQueue = opts.inQueue;
			var outQueue = opts.outQueue;
			var func = opts.transform || opts.each;
			var config = opts.config;
			if (config && opts.debug) {
				config.debug = opts.debug;
			}

			var args = [];
			args.push(ls.fromLeo(id, inQueue, config));

			if (opts.batch) {
				args.push(ls.batch(opts.batch));
			}

			args.push(ls.process(id, func, outQueue));
			args.push(ls.toLeo(id, opts));
			args.push(ls.toCheckpoint({
				debug: opts.debug
			}));
			args.push(callback);
			return ls.pipe.apply(ls, args);
		},
		offload: function (opts, callback) {
			configure.validate();
			var id = opts.id;
			var inQueue = opts.inQueue || opts.queue;
			var func = opts.each || opts.transform;
			var config = opts.config;
			var batch = {
				size: 1,
				map: (payload, meta, done) => done(null, payload)
			};
			if (!opts.batch || typeof opts.batch === "number") {
				batch.size = opts.batch || batch.size;
			} else {
				batch.size = opts.batch.size || batch.size;
				batch.map = opts.batch.map || batch.map;
			}

			var batchSize = typeof batch.size === "number" ? batch.size : batch.size.count;
			return ls.pipe(
				ls.fromLeo(id, inQueue, opts),
				ls.through((obj, done) => {
					batch.map(obj.payload, obj, (err, r, rOpts) => {
						rOpts = rOpts || {};
						if (err || !r) {
							done(err);
						} else {
							obj.payload = r;
							done(null, obj)
						}
					});
				}),
				ls.batch(batch.size),
				ls.through((batch, done) => {
					batch.units = batch.payload.length;
					let last = batch.payload[batch.units - 1];
					if (batchSize == 1) {
						done(null, last);
					} else {
						batch.event_source_timestamp = last.event_source_timestamp;
						batch.event = last.event;
						batch.eid = last.eid;
						done(null, batch);
					}
				}),
				ls.process(id, func, null),
				ls.toCheckpoint({
					debug: opts.debug
				}), callback);
		},
		process: function (id, func, outQueue, onflush) {
			var firstEvent;
			var lastEvent;
			var units;

			if (typeof outQueue == "function") {
				onflush = outQueue;
				outQueue = undefined;
			}
			if (onflush) {
				let flush = onflush;
				onflush = function (done) {
					let context = {
						push: (r, rOpts) => {
							rOpts = rOpts || {};
							if (r === true || r) {
								this.push({
									id: id,
									event: outQueue,
									payload: r === true ? undefined : r,
									event_source_timestamp: rOpts.event_source_timestamp || lastEvent.event_source_timestamp,
									correlation_id: {
										source: rOpts.event || lastEvent.event,
										start: rOpts.eid || lastEvent.eid,
										units: rOpts.units || lastEvent.units || 1
									}
								});
							}
						}
					};
					flush.call(context, (err, r, rOpts) => {
						rOpts = rOpts || {};
						if (err) {
							done(err);
						} else {
							context.push(r, rOpts)
							done();
						}
					});
				}
			}

			function reset() {
				firstEvent = null;
				units = 0;
			}
			reset();

			return ls.through(function (obj, done) {
				if (!firstEvent) {
					firstEvent = obj;
				}
				lastEvent = obj;
				units += obj.units || 1;
				let context = {
					push: (r, rOpts) => {
						rOpts = rOpts || {};
						if (r === true) { //then we handled it, though it didn't create an object
							this.push({
								id: id,
								event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
								eid: rOpts.eid || obj.eid,
								correlation_id: {
									source: obj.event,
									start: rOpts.eid || obj.eid,
									units: rOpts.units || obj.units || 1
								}
							});
						} else if (r) { //then we are actually writing an object
							this.push({
								id: id,
								event: outQueue,
								payload: r,
								event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
								eid: rOpts.eid || obj.eid,
								correlation_id: {
									source: obj.event,
									start: rOpts.eid || obj.eid,
									units: rOpts.units || obj.units || 1
								}
							});
						}
					}
				};
				func.call(context, obj.payload, obj, (err, r, rOpts) => {
					rOpts = rOpts || {};
					if (err) {
						done(err);
					} else if (r === true) { //then we handled it, though it didn't create an object
						done(null, {
							id: id,
							event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
							eid: rOpts.eid || obj.eid,
							correlation_id: {
								source: obj.event,
								start: rOpts.eid || obj.eid,
								units: rOpts.units || obj.units || 1
							}
						});
					} else if (r) { //then we are actually writing an object
						done(null, {
							id: id,
							event: outQueue,
							payload: r,
							event_source_timestamp: rOpts.event_source_timestamp || obj.event_source_timestamp,
							eid: rOpts.eid || obj.eid,
							correlation_id: {
								source: obj.event,
								start: rOpts.eid || obj.eid,
								units: rOpts.units || obj.units || 1
							}
						});
					} else {
						done();
					}
				});
			}, onflush);
		},
		toLeo: (ID, opts) => {
			opts = opts || {};
			let defaults = {
				s3: {
					records: 1,
					useS3: true,
					time: {
						milliseconds: 1000 * 10
					},
					chunk: {
						label: "chunk",
						useS3: true
					}
				},
				firehose: {
					records: 10000,
					size: 1024 * 900,
					useS3: false,
					time: {
						milliseconds: 1000
					}
				},
				kinesis: {
					records: 100,
					size: 1024 * 200,
					time: {
						milliseconds: 200
					}
				}
			};
			var type = "kinesis";
			if (opts.useS3 && !opts.firehose) { //why would both of these be set?
				type = "s3";
			} else if (opts.firehose) {
				type = "firehose";
			}
			opts = Object.assign({
				label: "toLeo",
				debug: true,
				enableLogging: true,
				chunk: {
					label: "chunk"
				}
			}, defaults[type], opts || {});

			var records, correlations;

			function reset() {
				records = [];
				correlations = [];
			}
			reset();

			var retry = backoff.fibonacci({
				randomisationFactor: 0,
				initialDelay: 1,
				maxDelay: 1000
			});
			retry.failAfter(10);
			retry.success = function () {
				retry.reset();
				retry.emit("success");
			};
			retry.run = function (callback) {
				let fail = (err) => {
					retry.removeListener('success', success);
					callback(err || 'failed');
				};
				let success = () => {
					retry.removeListener('fail', fail);
					var c = correlations;
					reset();
					callback(null, {
						id: ID,
						correlations: c
					});
				};

				retry.once('fail', fail).once('success', success);
				retry.backoff();
			};
			retry.on('ready', function (number, delay) {
				if (records.length === 0) {
					retry.success();
				} else if (opts.firehose) {
					logger.debug("sending", records.length, number, delay);
					logger.time("firehose request");
					firehose.putRecordBatch({
						Records: [{
							Data: records.join('')
						}],
						DeliveryStreamName: configure.bus.firehose
					}, function (err, data) {
						logger.debug(process.memoryUsage());
						if (err) {
							logger.error(err);
							retry.backoff();
						} else if (data.FailedPutCount && data.FailedPutCount > 0) {
							var left = [];
							for (var i = 0; i < data.RequestResponses.length; i++) {
								var row = data.RequestResponses[i];
								if (row.ErrorCode) {
									left.push(records[i]);
								}
							}
							records = left;
							retry.backoff();
						} else {
							logger.timeEnd("firehose request");
							retry.success();
						}
					});

				} else {
					logger.debug("sending", records.length, number, delay);
					logger.time("kinesis request");
					kinesis.putRecords({
						Records: records.map((r) => {
							return {
								Data: r,
								PartitionKey: ID
							};
						}),
						StreamName: configure.stream
					}, function (err, data) {
						if (err) {
							retry.backoff();
						} else if (data.FailedRecordCount && data.FailedRecordCount > 0) {
							var left = [];
							for (var i = 0; i < data.Records.length; i++) {
								var row = data.Records[i];
								if (row.ErrorCode) {
									left.push(records[i]);
								}
							}
							records = left;
							retry.backoff();
						} else {
							logger.timeEnd("kinesis request");
							retry.success();
						}
					});
				}
			});

			var chunkOpts = Object.assign({
				records: 10,
				size: 1024 * 200,
				time: {
					milliseconds: 200
				},
				debug: false,
				enableLogging: true
			}, opts.chunk || {});
			chunkOpts.gzip = !opts.firehose;

			return ls.pipeline(chunkEventStream(ls, null, chunkOpts), ls.buffer(opts, function (obj, callback) {

				if (obj.gzip) {
					records.push(obj.gzip);
				} else if (obj.s3) {
					records.push(zlib.gzipSync(JSON.stringify(obj) + "\n"));
				}
				correlations.push(obj.correlations);
				delete obj.buffer;

				callback(null, (obj.gzip || obj.s3) && {
					records: 1,
					size: obj.gzipSize
				});
			}, retry.run, function flush(callback) {
				logger.info("toLeo On Flush")
				callback();
			}));
		},
		toManualCheckpoint: (id, opts) => {
			var cp = ls.toCheckpoint(Object.assign({
				records: Number.POSITIVE_INFINITY,
				time: {
					days: 20
				},
				size: Number.POSITIVE_INFINITY
			}, opts));
			var pass = ls.pipeline(
				ls.process(id, (a, e, d) => d(null, true), null),
				ls.through((obj, done) => {
					var result = cp.write(obj);
					if (!result) {
						cp.once("drain", () => {
							done();
						})
					} else {
						done();
					}
					return;
				}));

			pass.finish = (cb) => cp.end(cb);
			pass.flush = (cb) => cp.flush(cb);
			return pass;
		},
		toCheckpoint: (opts) => {
			opts = Object.assign({
				records: 1000,
				time: {
					seconds: 10
				},
				debug: false
			}, opts || {});

			var checkpoints = {};

			function doCheckpoint(callback) {
				logger.debug(JSON.stringify(checkpoints, null, 2));

				var tasks = [];
				for (var id in checkpoints) {
					var bot = checkpoints[id];
					for (var event in bot) {
						var checkpoint = bot[event];
						tasks.push((done) => {
							cron.checkpoint(id, event, checkpoint, done);
						});
					}
				}
				async.parallelLimit(tasks, 10, (err, results) => {
					checkpoints = {};
					callback(err);
				});
			}

			return ls.buffer({
				writeStream: true,
				label: "toCheckpoint",
				time: opts.time,
				size: opts.size,
				records: opts.records,
				buffer: opts.buffer,
				debug: opts.debug
			}, function (update, callback) {
				var id = update.id;
				var correlations = update.correlations;

				if (!correlations && update.correlation_id && update.correlation_id.source) {

					let timestamp = update.timestamp || Date.now();
					let start = (update.event_source_timestamp || timestamp);
					correlations = [{
						[update.correlation_id.source]: {
							start: update.correlation_id.start || undefined,
							end: update.correlation_id.end || update.correlation_id.start,
							records: update.correlation_id.units || 1,
							source_timestamp: start,
							timestamp: timestamp
						}
					}];
				}

				if (!(id in checkpoints)) {
					checkpoints[id] = {};
				}
				var c = checkpoints[id];

				var records = 0;
				correlations.forEach((correlation) => {
					for (var event in correlation) {
						var u = correlation[event];
						if (!(event in c)) {
							c[event] = {
								eid: u.end,
								records: u.records,
								source_timestamp: u.source_timestamp,
								ended_timestamp: u.timestamp,
								started_timestamp: u.timestamp
							};
						} else {
							c[event].eid = u.end;
							c[event].records += u.records;
							c[event].source_timestamp = Math.min(c[event].source_timestamp, u.source_timestamp);
							c[event].ended_timestamp = Math.max(c[event].ended_timestamp, u.timestamp);
							c[event].started_timestamp = Math.max(c[event].started_timestamp, u.timestamp);
						}

						records += u.records;
					}
				});

				callback(null, {
					records: records
				});

			}, doCheckpoint, function flush(callback) {
				logger.debug("all checkpointed");
				callback();
			});
		},
		fromLeo: (ID, queue, opts) => {
			opts = opts || {};
			queue = refUtil.ref(queue).queue(opts.subqueue).id;
			if (!opts.stopTime && configure.registry && configure.registry.context) {
				opts.stopTime = moment.now() + (configure.registry.context.getRemainingTimeInMillis() * 0.8);
			}
			if (!opts.stopTime && opts.runTime) {
				opts.stopTime = moment().add(opts.runTime).valueOf()
			}

			logger.info(opts);
			opts = Object.assign({
				buffer: 1000,
				loops: 100,
				start: null,
				limit: Number.POSITIVE_INFINITY,
				size: Number.POSITIVE_INFINITY,
				debug: false,
				stopTime: moment().add(240, "seconds")
			}, opts || {});
			logger.info(opts);

			var pass = new PassThrough({
				highWaterMark: opts.buffer,
				objectMode: true
			});
			var hasTime = true;

			let oldDestroy = pass.destroy;
			pass.destroy = function () {
				hasTime = false;
				oldDestroy && oldDestroy();
			};

			dynamodb.docClient.batchGet({
				RequestItems: {
					[CRON_TABLE]: {
						Keys: [{
							id: ID
						}]
					},
					[EVENT_TABLE]: {
						Keys: [{
							event: queue
						}]
					}
				}
			}, function (err, docs) {
				if (err) {
					throw err;
				} else if (docs.UnprocessedKeys !== undefined && Object.keys(docs.UnprocessedKeys).length > 0) {
					throw new Error("Not enough capacity to read");
				}

				var start = null;
				var leoEvent, leoCron;
				if (Object.keys(docs.UnprocessedKeys) >= 1) {
					pass.end();
					return;
				} else if (!docs.Responses || !docs.Responses[EVENT_TABLE] || docs.Responses[EVENT_TABLE].length === 0) { //There are no events that are processable
					pass.end();
					return;
				} else {
					leoEvent = docs.Responses[EVENT_TABLE][0];
				}

				var queueRef = refUtil.refId(queue);
				leoCron = docs.Responses && docs.Responses[CRON_TABLE] && docs.Responses[CRON_TABLE][0];
				if (opts.start) {
					start = opts.start + " "; //we want it to start after this one
				} else if (docs.Responses && docs.Responses[CRON_TABLE] && docs.Responses[CRON_TABLE][0]) { //There are no cron jobs, not possible to stream

					if (leoCron.checkpoint && !leoEvent.v) {
						start = leoCron.checkpoint;
					} else if (leoCron.checkpoints && leoCron.checkpoints.read && leoCron.checkpoints.read[queueRef]) {
						start = leoCron.checkpoints.read[queueRef].checkpoint || "z/";
					} else {
						start = "z/";
					}
				} else {
					start = "z/";
				}

				if (start === null) { //We will not run unless we got a start
					pass.end();
					return;
				}

				var checkpointData = ["registry", "__cron", "checkpoints", "read"].reduce((o, f) => o[f] = o[f] || {}, configure);
				if (!checkpointData[queueRef]) {
					checkpointData[queueRef] = leoCron && leoCron.checkpoints && leoCron.checkpoints.read && leoCron.checkpoints.read[queueRef];
				}

				var count = 0;
				pass.throttledWrite = (obj, callback) => {
					count++;
					start = obj.eid + " "; //we want it to continue after this one
					if (!pass.write(obj)) {
						logger.debug("back pressure");
						pass.once('drain', () => {
							logger.debug("back pressure done");
							callback();
						});
					} else {
						callback();
					}
				};

				function max() {
					var max = arguments[0]
					for (var i = 1; i < arguments.length; ++i) {
						if (arguments[i] != null && arguments[i] != undefined) {
							max = max > arguments[i] ? max : arguments[i];
						}
					}
					return max;
				}

				let getEvents;
				if (leoEvent.v >= 2) {
					var max_eid = opts.maxOverride || leoEvent.max_eid;
					var table_name = configure.resources.LeoStream;
					var eid = "eid";
					var range_key = "end";

					getEvents = function (callback) {
						var params = {
							TableName: table_name,
							KeyConditionExpression: "#event = :event and #key between :start and :maxkey",
							ExpressionAttributeNames: {
								"#event": "event",
								"#key": range_key,
							},
							Limit: 50,
							ExpressionAttributeValues: {
								":event": queue,
								":maxkey": max_eid,
								":start": start
							},
							"ReturnConsumedCapacity": 'TOTAL'
						};
						logger.debug(params);
						dynamodb.docClient.query(params, function (err, data) {
							logger.debug("Consumed Capacity", data && data.ConsumedCapacity);
							if (err) {
								logger.error(err)
								callback(err);
								return;
							}
							callback(null, data.Items)
						});
					};
				} else {
					var max_eid = max(leoEvent.kinesis_number, leoEvent.s3_kinesis_number, leoEvent.initial_kinesis_number, leoEvent.s3_new_kinesis_number);
					var table_name = "Leo";
					var eid = "kinesis_number";
					var range_key = "kinesis_number";

					getEvents = function (callback) {
						let q = refUtil.ref(queueRef).queue().id;
						leo.getEvents(ID, q, Object.assign({}, opts, {
							start: start
						}), (err, events, checkpoint) => {
							err && logger.error(err);
							callback(err, events);
						});
					}
				}

				var hasMoreEvents = true;
				var hasLoops = opts.loops;
				var totalCount = 0;
				var totalSize = 0;

				if (max_eid.localeCompare(start) > 0) {
					async.whilst(() => {
							logger.debug("checking next loop, loops remaining ", hasLoops, ", Time Remaining:", opts.stopTime - moment.now());
							hasTime = hasTime && (opts.stopTime > moment.now());
							logger.debug(totalCount, opts.limit, totalSize, opts.size, hasMoreEvents, hasTime, hasLoops, max_eid, start, max_eid.localeCompare(start));
							return totalCount < opts.limit && totalSize < opts.size && hasMoreEvents && hasTime && hasLoops && max_eid.localeCompare(start) > 0;
						}, (done) => {
							var count = 0;
							hasLoops--;
							getEvents(function (err, items) {
								logger.debug("found", items.length, "items");
								if (items.length == 0) {
									logger.debug("no more events");
									hasMoreEvents = false;
									done();
									return;
								}

								var counts = 0;
								var size = 0;
								async.eachOfSeries(items, (item, i, done) => {
										var cb = done;
										done = () => {
											process.nextTick(() => cb.apply(cb, arguments))
										}
										if (totalCount >= opts.limit || totalSize >= opts.size || !hasTime) {
											return done();
										}
										if (item.start) {
											var _parts = item.start.split(/-/);
											var prefix = _parts[0];
											var idOffset = parseInt(_parts[1]);
										}


										function createEId(eid) {
											return prefix + "-" + (pad + (idOffset + eid)).slice(padLength);
										};

										if (item.s3) {
											if (item.end.localeCompare(start) > 0) { //Then it is greater than the event they were looking at
												//let's figure out where we should jump into this file.
												var fileOffset = null;
												var fileEnd = item.gzipSize;
												var recordOffset = 0;

												for (let i = 0; i < item.offsets.length; i++) {
													var offset = item.offsets[i];
													if (start.localeCompare(createEId(offset.end)) < 0) {
														logger.debug(start, offset.start, offset.end);
														counts += offset.records; //is this right?
														size += offset.size; //this isn't exact when getting in the middle of a file, but close enough
														if (fileOffset == null) {
															fileOffset = offset.gzipOffset;
															idOffset += offset.start;
														}
														if (counts >= opts.limit || size >= opts.size) {
															fileEnd = offset.gzipOffset + offset.gzipSize - 1;
															break;
														}
													}
												}

												var file = item.s3;
												file.range = `bytes=${fileOffset}-${fileEnd}`;
												logger.debug(file.range);
												var eid = 0;
												pump(ls.fromS3(file), zlib.createGunzip(), split((value) => {
													return {
														length: Buffer.byteLength(value),
														obj: JSON.parse(value)
													}
												}), ls.write((obj, enc, done) => {
													var e = obj.obj;
													totalSize += obj.length;
													e.eid = createEId(eid++);
													if (e.eid.localeCompare(start) > 0 && totalCount < opts.limit && totalSize < opts.size) { //Then it is greater than the event they were looking at
														totalCount++;
														pass.throttledWrite(e, done);
													} else { //otherwise it means we had a number in the middle of a file
														logger.debug("skipping s3", start, e.eid);
														done();
													}
												}), (err) => {
													if (err) {
														logger.error(err);
														done(err);
													} else {
														done();
													}
												});
											} else {
												done();
											}
										} else if (!item.gzip || item.gzip == true) {
											item.eid = item.kinesis_number;
											delete item.kinesis_number;
											// v1 getEvents already unzipped the payload
											if (item.gzip && leoEvent.v >= 2) {
												item.payload = JSON.parse(zlib.gunzipSync(item.payload));
											} else if (typeof item.payload === "string") {
												item.payload = JSON.parse(item.payload);
											}

											if (item.eid.localeCompare(start) > 0 && totalCount < opts.limit && totalSize < opts.size) { //Then it is greater than the event they were looking at
												totalCount++;
												pass.throttledWrite(item, done);
											} else { //otherwise it means we had a number in the middle of a file
												logger.debug("skipping gzip");
												done();
											}
										} else if (item.gzip) {
											var gzip = zlib.createGunzip();
											pump(gzip, split(JSON.parse), ls.write((e, enc, done) => {
												e.eid = createEId(e.eid);

												if (e.eid.localeCompare(start) > 0 && totalCount < opts.limit && totalSize < opts.size) { //Then it is greater than the event they were looking at
													totalCount++;
													pass.throttledWrite(e, done);
												} else { //otherwise it means we had a number in the middle of a file
													logger.debug("skipping gzipped");
													done();
												}
											}), (err) => {
												if (err) {
													logger.error(err);
													done(err);
												} else {
													logger.debug("gzipped event read finished");
													done();
												}
											});
											gzip.end(item.gzip);
										}
									},
									function (err) {
										logger.debug("done with this loop", err || "");
										if (err) {
											pass.emit("error", err);
										} else {
											done();
										}
									});
							});
						},
						(err) => {
							logger.debug("Calling Pass.end")
							if (err) logger.error(err);
							pass.end();
						});
				} else {
					logger.debug("no events");
					pass.end();
					return;
				}
			});

			return pass;
		},
		toLeoMass: (queue, configure) => {
			return ls.pipeline(leoS3(ls, queue, configure))

		},
		toDynamoDB: function (table, opts) {
			opts = Object.assign({
				records: 25,
				size: 1024 * 1024 * 2,
				time: {
					seconds: 2
				}
			}, opts || {});

			var records, size;

			function reset() {
				records = [];
			}
			reset();

			var retry = backoff.fibonacci({
				randomisationFactor: 0,
				initialDelay: 1,
				maxDelay: 1000
			});
			retry.failAfter(10);
			retry.success = function () {
				retry.reset();
				retry.emit("success");
			};
			retry.run = function (callback) {
				let fail = (err) => {
					retry.removeListener('success', success);
					callback(err || 'failed');
				};
				let success = () => {
					retry.removeListener('fail', fail);
					reset();
					callback();
				};
				retry.once('fail', fail).once('success', success);
				retry.backoff();
			};
			retry.on('ready', function (number, delay) {
				if (records.length === 0) {
					retry.success();
				} else {
					logger.info("sending", records.length, number, delay);
					logger.time("dynamodb request");
					dynamodb.docClient.batchWrite({
							RequestItems: {
								[table]: records.map((r) => {
									return {
										PutRequest: {
											Item: r
										}
									};
								})
							},
							"ReturnConsumedCapacity": 'TOTAL'
						},
						function (err, data) {
							if (err) {
								logger.info(`All ${records.length} records failed`, err);
								retry.backoff();
							} else if (table in data.UnprocessedItems && Object.keys(data.UnprocessedItems[table]).length !== 0) {
								records = data.UnprocessedItems[table];
								retry.backoff();
							} else {
								logger.info("saved");
								retry.success();
							}
						});
				}
			});
			return ls.buffer({
				writeStream: true,
				label: "toDynamoDB",
				time: opts.time,
				size: opts.size,
				records: opts.records,
				buffer: opts.buffer,
				debug: opts.debug
			}, function (obj, done) {
				size += obj.gzipSize;
				records.push(obj);

				done(null, {
					size: obj.gzipSize,
					records: 1
				});
			}, retry.run, function flush(done) {
				logger.info("toDynamoDB On Flush");
				done();
			});
		},
		buffer: _streams.buffer,
		batch: _streams.batch,
		putEvent: function (id, event, obj, opts, callback) {
			if (typeof opts == "function") {
				callback = opts;
				opts = {};
			}

			var stream = ls.load(id, event, opts);
			stream.write(obj);
			stream.end(err => {
				err && logger.info("Error:", err);
				callback(err);
			});

		},
		autoSwitch: function (outQueue, opts) {
			opts = Object.assign({
				recordsPerSecond: 100,
				sampleInterval: {
					milliseconds: 100
				}
			}, opts);

			let sampleIntervalMS = moment.duration(opts.sampleInterval).asMilliseconds();
			let stats = {
				isS3: false,
				recordsPerSecond: 0,
				records: 0,
				lastSwitch: moment.now(),
				start: moment.now()
			};
			let toLeo = ls.toLeo(opts);
			let end = ls.through((obj, done) => done(null, obj), (done) => {
				logger.info("Calling flush for end");
				done();
			});

			let cnt = 0;
			let kinesisStream = ls.pipeline(toLeo, end);
			let leoS3S = leoS3(ls, outQueue, configure);
			let s3Stream = ls.pipeline(leoS3S, kinesisStream);
			let stream = kinesisStream; //ls.pipeline(toLeo, end);

			let start = ls.through(function (obj, done) {
				stats.records++;
				let now = stats.now = moment.now();
				stats.recordsPerSecond = stats.records / ((now - stats.start) || 1) * 1000;
				logger.info(now - stats.start, sampleIntervalMS, stats.records, stats.recordsPerSecond);
				if (now - stats.start >= sampleIntervalMS) {
					cnt++;
					logger.debug("Stats:", JSON.stringify(stats));
					stats.start = now;
					stats.records = 0;
				}

				if (!stats.isS3 && stats.recordsPerSecond >= opts.recordsPerSecond) {
					logger.debug("Switching to S3 stream", JSON.stringify(stats));
					//stream.end((err) => {
					//	logger.info("Back", err)
					stats.isS3 = true;
					stats.lastSwitch = moment.now();
					//	stream = ls.pipeline(leoS3(ls, outQueue, configure), toLeo, end);
					stream = s3Stream;
					stream.write(obj);
					done();
					//});
					// stream.end((err) => {
					// 	logger.info("Back:", err)
					// 	stats.isS3 = true;
					// 	stats.lastSwitch = moment.now();
					// 	logger.debug("Switching", JSON.stringify(stats));
					// 	stream = ls.pipeline(leoS3(), toLeo, end);
					// 	stream.write(obj);
					// 	done(err);
					// });
				} else if (stats.isS3 && stats.recordsPerSecond < opts.recordsPerSecond) {
					logger.debug("Switching to Kinesis stream", JSON.stringify(stats));

					leoS3S.once("drain", () => {
						//stream.end((err) => {
						//	logger.info("Back", err)
						stats.isS3 = false;
						stats.lastSwitch = moment.now();
						//stream = ls.pipeline(toLeo, end);
						stream = kinesisStream;
						stream.write(obj);
						done();
						//});
					});
					// stream.end((err) => {
					// 	stats.isS3 = false;
					// 	stats.lastSwitch = moment.now();
					// 	logger.debug("Switching", JSON.stringify(stats));
					// 	stream = ls.pipeline(toLeo, end);
					// 	stream.write(obj);
					// 	done(err);
					// });
				} else {
					logger.info("Normal Write")
					stream.write(obj);
					done();
				}
			}, function flush(done) {
				logger.debug("On Flush Stats:", JSON.stringify(stats));
				done();
			});
			let s = ls.pipeline(start, end);
			s.on("error", (err) => {
					logger.info("Kinesis Stream error:", err)
				})
				.on("end", () => logger.info("ending kinesis stream"))
				.on("finish", () => logger.info("finishing kinesis stream"));

			return s;
		}
	};

	return ls;
}