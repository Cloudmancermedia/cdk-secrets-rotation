import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import * as crypto from 'crypto';

interface SecretJson {
  username: string;
  password: string;
  host: string;
  port?: number;
  dbname?: string;
}

interface RotationEvent {
  Step: 'createSecret' | 'setSecret' | 'testSecret' | 'finishSecret';
  SecretId: string;
  ClientRequestToken: string;
}

const secretsClient = new SecretsManagerClient({});

export const handler = async (event: RotationEvent): Promise<void> => {
  const { Step: step, SecretId: secretArn, ClientRequestToken: token } = event;

  switch (step) {
    case 'createSecret':
      return await createSecret(secretArn, token);
    case 'setSecret':
      return await setSecret(secretArn, token);
    case 'testSecret':
      return await testSecret(secretArn, token);
    case 'finishSecret':
      return await finishSecret(secretArn, token);
    default:
      throw new Error(`Unknown step: ${step}`);
  }
};

async function getSecretJson(secretId: string, stage: string = 'AWSCURRENT'): Promise<SecretJson> {
  const result = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: secretId,
      VersionStage: stage,
    })
  );

  if (!result.SecretString) {
    throw new Error(`Secret ${secretId} did not return a SecretString`);
  }

  return JSON.parse(result.SecretString);
}

function generateSecurePassword(length: number = 16): string {
  if (length < 4) {
    throw new Error('Password length must be at least 4 to meet complexity requirements.');
  }

  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()_-+=';
  const allChars = upper + lower + digits + symbols;

  const getRandomChar = (charset: string): string => {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    return charset[rand[0] % charset.length];
  };

  const guaranteedChars = [
    getRandomChar(upper),
    getRandomChar(lower),
    getRandomChar(digits),
    getRandomChar(symbols),
  ];

  const remainingLength = length - guaranteedChars.length;
  const randomIndexes = new Uint32Array(remainingLength);
  crypto.getRandomValues(randomIndexes);

  const remainingChars = Array.from(randomIndexes, (x) => allChars[x % allChars.length]);
  const passwordArray = [...guaranteedChars, ...remainingChars];

  // Fisher-Yates shuffle
  for (let i = passwordArray.length - 1; i > 0; i--) {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const j = rand[0] % (i + 1);
    [passwordArray[i], passwordArray[j]] = [passwordArray[j], passwordArray[i]];
  }

  return passwordArray.join('');
}

async function createSecret(secretId: string, token: string): Promise<void> {
  const current = await getSecretJson(secretId, 'AWSCURRENT');

  const newPassword = generateSecurePassword(20);
  const newSecret = { ...current, password: newPassword };

  await secretsClient.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      ClientRequestToken: token,
      SecretString: JSON.stringify(newSecret),
      VersionStages: ['AWSPENDING'],
    })
  );

  console.log('New secret version created.');
}

async function setSecret(secretId: string, token: string): Promise<void> {
  const current = await getSecretJson(secretId, 'AWSCURRENT');
  const pending = await getSecretJson(secretId, 'AWSPENDING');

  const client = new Client({
    host: current.host,
    port: current.port || 5432,
    user: current.username,
    password: current.password,
    database: current.dbname || 'postgres',
  });

  try {
    await client.connect();
    const sql = `ALTER USER ${pending.username} WITH PASSWORD '${pending.password}'`;
    await client.query(sql);
    console.log('DB password updated.');
  } catch (err) {
    console.error('Error in setSecret:', err);
    throw err;
  } finally {
    await client.end();
  }
}

async function testSecret(secretId: string, token: string): Promise<void> {
  const pending = await getSecretJson(secretId, 'AWSPENDING');

  const client = new Client({
    host: pending.host,
    port: pending.port || 5432,
    user: pending.username,
    password: pending.password,
    database: pending.dbname || 'postgres',
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    console.log('Test connection succeeded.');
  } catch (err) {
    console.error('Test failed:', err);
    throw err;
  } finally {
    await client.end();
  }
}

async function finishSecret(secretId: string, token: string): Promise<void> {
  const result = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: secretId,
    })
  );

  const metadata: Record<string, string[]> = Array.isArray(result.VersionStages)
    ? {}
    : result.VersionStages || {};
  if (metadata[token]?.includes('AWSCURRENT')) {
    console.log('Version already marked as AWSCURRENT.');
    return;
  }

  await secretsClient.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      ClientRequestToken: token,
      VersionStages: ['AWSCURRENT'],
    })
  );

  console.log('Promoted version to AWSCURRENT.');
}
