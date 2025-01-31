const debug = require('debug')('DynamoDBStream')
const map = require('@kessler/async-map-limit')
const { EventEmitter } = require('events')

class DynamoDBStream extends EventEmitter {

	/**
	 *	@param {object} ddbStreams - an instance of DynamoDBStreams
	 *	@param {string} streamArn - the arn of the stream we're consuming
	 *	@param {function} unmarshall - directly from 
	 *			```js
	 *				const { unmarshall } = require('@aws-sdk/util-dynamodb')
	 *			```
	 *			 if not provided then records will be returned using low level api/shape
	 */
	constructor(ddbStreams, streamArn, unmarshall) {
		super()
		if (!typeof ddbStreams === 'object') {
			throw new Error('missing or invalid ddbStreams argument')
		}

		if (!typeof streamArn === 'string') {
			throw new Error('missing or invalid streamArn argument')
		}

		this._ddbStreams = ddbStreams
		this._streamArn = streamArn
		this._shards = new Map()
		this._unmarshall = unmarshall
	}

	/**
	 * this will update the stream, shards and records included
	 *
	 */
	async fetchStreamState() {
		debug('fetchStreamState')

		await this.fetchStreamShards()
		await this.fetchStreamRecords()
	}

	/**
	 * update the shard state of the stream
	 * this will emit new shards / remove shards events
	 */
	async fetchStreamShards() {
		debug('fetchStreamShards')

		this._trimShards()

		const params = {
			StreamArn: this._streamArn
		}

		const newShardIds = []
		let lastShardId = null

		do {
			if (lastShardId) {
				debug('lastShardId: %s', lastShardId)
				params.ExclusiveStartShardId = lastShardId
			}
			try {
				const { StreamDescription } = await this._ddbStreams.describeStream(params)

				const shards = StreamDescription.Shards
				lastShardId = StreamDescription.LastEvaluatedShardId

				// collect all the new shards of this stream
				for (const newShardEntry of shards) {
					const existingShardEntry = this._shards.get(newShardEntry.ShardId)

					if (!existingShardEntry) {
						this._shards.set(newShardEntry.ShardId, {
							shardId: newShardEntry.ShardId
						})

						newShardIds.push(newShardEntry.ShardId)
					}
				}
			} catch (error) {
				this._emitError(error)
				switch (error.name) {
					case 'ThrottlingException':
						const { attempts, totalRetryDelay } = error.$metadata
						debug('describeStream command throttled - attempts: %d, totalRetryDelay: %d', attempts, totalRetryDelay)
						lastShardId = null // break out of loop; leave any remaining new shards for next call
						break
					default:
						throw error
				}
			}
		} while (lastShardId)

		if (newShardIds.length > 0) {
			debug('Added %d new shards', newShardIds.length)
			this._emitNewShardsEvent(newShardIds)
		}
	}

	/**
	 * get latest updates from the underlying stream
	 *
	 */
	async fetchStreamRecords() {
		debug('fetchStreamRecords')

		if (this._shards.size === 0) {
			debug('no shards found, this is ok')
			return
		}

		await this._getShardIterators()
		const records = await this._getRecords()

		debug('fetchStreamRecords', records)

		this._trimShards()
		this._emitRecordEvents(records)

		return records
	}

	/**
	 * 	get a COPY of the current/internal shard state.
	 * 	this, in conjuction with setShardState is used to
	 * 	persist the stream state locally.
	 *
	 *	@returns {object}
	 */
	getShardState() {
		const state = {}
		for (const [shardId, shardData] of this._shards) {
			state[shardId] = { ...shardData }
		}
		return state
	}

	/**
	 *	@param {object} shards
	 */
	setShardState(shards) {

		this._shards = new Map()
		for (const [shardId, shardData] of Object.entries(shards)) {
			this._shards.set(shardId, shardData)
		}
	}

	_getShardIterators() {
		debug('_getShardIterators')
		return map(this._shards.values(), shardData => this._getShardIterator(shardData), 10)
	}

	async _getShardIterator(shardData) {
		debug('_getShardIterator')
		debug(shardData)

		// no need to get an iterator if this shard already has NextShardIterator
		if (shardData.nextShardIterator) {
			debug('shard %s already has an iterator, skipping', shardData.shardId)
			return
		}

		const params = {
			ShardId: shardData.shardId,
			ShardIteratorType: 'LATEST',
			StreamArn: this._streamArn
		}

		try {
			const { ShardIterator } = await this._ddbStreams.getShardIterator(params)
			shardData.nextShardIterator = ShardIterator
		} catch (error) {
			this._emitError(error)
			switch (error.name) {
				case 'ResourceNotFoundException':
					debug('shard %s no longer exists, skipping', shardData.shardId)
					shardData.nextShardIterator = null
					break
				case 'ThrottlingException':
					const { attempts, totalRetryDelay } = error.$metadata
					debug('getShardIterator command throttled for shard %s - attempts: %d, totalRetryDelay: %d', shardData.shardId, attempts, totalRetryDelay)
					shardData.nextShardIterator = undefined // skip for now, but don't prune it
					break
				default:
					throw e
			}
		}
	}

	async _getRecords() {
		debug('_getRecords')

		const results = await map(this._shards.values(), shardData => this._getShardRecords(shardData), 10)

		return results.flat()
	}

	async _getShardRecords(shardData) {
		debug('_getShardRecords')

		if (!shardData.nextShardIterator) {
			return []
		}

		const params = { ShardIterator: shardData.nextShardIterator }

		try {
			const { Records, NextShardIterator } = await this._ddbStreams.getRecords(params)
			if (NextShardIterator) {
				shardData.nextShardIterator = NextShardIterator
			} else {
				shardData.nextShardIterator = null
			}

			return Records
		} catch (error) {
			this._emitError(error)
			switch (error.name) {
				case 'ExpiredIteratorException':
					debug('_getShardRecords expired iterator', shardData)
					shardData.nextShardIterator = null
					break
				case 'ResourceNotFoundException':
					debug('_getShardRecords shard %s no longer exists', shardData)
					shardData.nextShardIterator = null
					break
				case 'ThrottlingException':
					const { attempts, totalRetryDelay } = error.$metadata
					debug('getRecords command throttled for shard %s - attempts: %d, totalRetryDelay: %d', shardData.shardId, attempts, totalRetryDelay)
					shardData.nextShardIterator = undefined // skip for now, but don't prune it
					break
				default:
					console.log(error)
					process.exit(1)
					throw e
			}
			return []
		}
	}

	_trimShards() {
		debug('_trimShards')

		const removedShards = []

		for (const [shardId, shardData] of this._shards) {
			if (shardData.nextShardIterator === null) {
				debug('deleting shard %s', shardId)
				this._shards.delete(shardId)
				removedShards.push(shardId)
			}
		}

		if (removedShards.length > 0) {
			this._emitRemoveShardsEvent(removedShards)
		}
	}

	/**
	 *	you may override in subclasses to change record transformation behavior
	 * 	for records emitted during _emitRecordEvents()
	 */
	_transformRecord(record) {
		if (this._unmarshall && record) {
			return this._unmarshall(record)
		}
	}

	_emitRecordEvents(events) {
		debug('_emitRecordEvents')

		for (const event of events) {
			const keys = this._transformRecord(event.dynamodb.Keys)
			const newRecord = this._transformRecord(event.dynamodb.NewImage)
			const oldRecord = this._transformRecord(event.dynamodb.OldImage)

			switch (event.eventName) {
				case 'INSERT':
					this.emit('insert record', newRecord, keys)
					break

				case 'MODIFY':
					this.emit('modify record', newRecord, oldRecord, keys)
					break

				case 'REMOVE':
					this.emit('remove record', oldRecord, keys)
					break

				default:
					throw new Error(`unknown dynamodb event ${event.eventName}`)
			}
		}
	}

	_emitRemoveShardsEvent(shardIds) {
		this.emit('remove shards', shardIds)
	}


	_emitNewShardsEvent(shardIds) {
		this.emit('new shards', shardIds)
	}

	_emitError(error) {
		this.emit('error', error)
	}
}

module.exports = DynamoDBStream