const test = require('ava')
const DynamoDBStream = require('./index')
const { DynamoDB, waitForTableExists, waitForTableNotExists } = require('@aws-sdk/client-dynamodb')
const { DynamoDBStreams } = require('@aws-sdk/client-dynamodb-streams')
const { unmarshall } = require('@aws-sdk/util-dynamodb')
const { ulid } = require('ulid')
const debug = require('debug')('DynamoDBStream:test')
const ddbStreams = new DynamoDBStreams()
const ddb = new DynamoDB()

const TABLE_NAME = 'testDynamoDBStream'

test('reports the correct stream of changes', async t => {
	const { eventLog, ddbStream } = t.context
	const pk = ulid()
	const pkA = ulid()
	const pkB = ulid()

	await ddbStream.fetchStreamState()
	await putItem({ pk, data: '1' })
	await ddbStream.fetchStreamState()
	await putItem({ pk, data: '2' })
	await ddbStream.fetchStreamState()
	await putItem({ pk: pkA, data: '2' })
	await putItem({ pk: pkB, data: '2' })
	await ddbStream.fetchStreamState()
	await deleteItem(pkA)
	await ddbStream.fetchStreamState()
	// Incr. test robustness, as sometimes the first fetch does not include the
	// delete event.
	await ddbStream.fetchStreamState()

	t.deepEqual(eventLog, [
		{ eventName: 'insert record', record: { pk, data: '1' } },
		{ 
			eventName: 'modify record', 
			newRecord: { pk, data: '2' },
			oldRecord: { pk, data: '1' }
		},
		{ eventName: 'insert record', record: { pk: pkA, data: '2' } },
		{ eventName: 'insert record', record: { pk: pkB, data: '2' } },
		{ eventName: 'remove record', record: { pk: pkA, data: '2' } }
	])
})

// this test will only work if you have a proper shardState set a side
test.skip('ExpiredIteratorException', async t => {
	const shardState = require('./oldShardState.json')
	const { ddbStream } = t.context
	ddbStream.setShardState(shardState)
	await t.notThrowsAsync(ddbStream.fetchStreamState())
})

test.beforeEach(async t => {

	t.context = {
		eventLog: []
	}

	await createTable()
	const arn = await findStreamArn()
	const ddbStream = t.context.ddbStream = new DynamoDBStream(ddbStreams, arn, unmarshall)

	ddbStream.on('insert record', (record) => {
		t.context.eventLog.push({ eventName: 'insert record', record })
	})

	ddbStream.on('modify record', (newRecord, oldRecord) => {
		t.context.eventLog.push({
			eventName: 'modify record',
			newRecord,
			oldRecord
		})
	})

	ddbStream.on('remove record', (record) => {
		t.context.eventLog.push({ eventName: 'remove record', record })
	})

	ddbStream.on('new shards', (newShards) => {
		t.context.shards = newShards
	})
})

/**
 * create the test table and wait for it to become active
 *
 */
async function createTable() {
	debug('creating table...')

	const params = {
		TableName: TABLE_NAME,
		KeySchema: [{
			AttributeName: 'pk',
			KeyType: 'HASH',
		}],
		AttributeDefinitions: [{
			AttributeName: 'pk',
			AttributeType: 'S', // (S | N | B) for string, number, binary
		}],
		ProvisionedThroughput: { // required provisioned throughput for the table
			ReadCapacityUnits: 1,
			WriteCapacityUnits: 1,
		},
		StreamSpecification: {
			StreamEnabled: true,
			StreamViewType: 'NEW_AND_OLD_IMAGES'
		}
	}
	try {
		await ddb.createTable(params)
		debug('table created.')
		await waitForTable(true)
	} catch (e) {
		if (!isTableExistError(e)) {
			throw e
		}

		debug('table already exists, skipping creation.')
	}
}

async function findStreamArn() {
	debug('finding the right stream arn')
	const { Streams } = await ddbStreams.listStreams({ TableName: TABLE_NAME })

	debug('found %d streams', Streams.length)

	const stream = Streams.filter(item => item.TableName === TABLE_NAME)[0]

	debug(stream)

	if (!stream) {
		throw new Error('cannot find stream arn')
	}

	debug('stream arn for table %s was found', TABLE_NAME)
	return stream.StreamArn
}

/**
 * delete the test table and wait for its disappearance
 *
 */
async function deleteTable() {
	const params = {
		TableName: TABLE_NAME
	}
	debug('deleting table %s', TABLE_NAME)
	await ddb.deleteTable(params)
	await waitForTable(false)
}

/**
 * wait for a table's state (exist/dont exist)
 * if the table is already in that state this function should return quickly
 *
 */
async function waitForTable(exists) {
	debug('waiting for table %s...', exists ? 'to become available' : 'deletion')

	// Waits for table to become ACTIVE.  
	// Useful for waiting for table operations like CreateTable to complete. 
	const params = {
		TableName: TABLE_NAME
	}

	// Supports 'tableExists' and 'tableNotExists'
	await exists ? waitForTableExists(ddb, params) : waitForTableNotExists(ddb, params)
	debug('table %s.', exists ? 'available' : 'deleted')
}

function putItem(data) {
	const params = {
		TableName: TABLE_NAME,
		Item: {
			pk: {
				S: data.pk
			},
			data: {
				S: data.data
			}
		}
	}

	debug('putting item %o', params)

	return ddb.putItem(params)
}

function deleteItem(pk) {
	const params = {
		TableName: TABLE_NAME,
		Key: { pk: { S: pk } }
	}

	debug('deleting item %o', params)

	return ddb.deleteItem(params)
}

function isTableExistError(err) {
	return err && err.name === 'ResourceInUseException' && err.message && err.message.indexOf('Table already exists') > -1
}