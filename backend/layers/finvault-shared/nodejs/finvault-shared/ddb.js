const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function tableName() {
  const t = process.env.FIN_ASSETS_TABLE;
  if (!t) throw new Error("FIN_ASSETS_TABLE env var is not set");
  return t;
}

async function putItem(item) {
  await doc.send(new PutCommand({ TableName: tableName(), Item: item }));
}

async function getItem(userId, assetId) {
  const out = await doc.send(
    new GetCommand({ TableName: tableName(), Key: { userId, assetId } })
  );
  return out.Item || null;
}

async function deleteItem(userId, assetId) {
  await doc.send(
    new DeleteCommand({ TableName: tableName(), Key: { userId, assetId } })
  );
}

async function queryByGSI1(userId, beginsWithSk) {
  const out = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": userId,
        ":sk": beginsWithSk,
      },
    })
  );
  return out.Items || [];
}

module.exports = { putItem, getItem, deleteItem, queryByGSI1 };
