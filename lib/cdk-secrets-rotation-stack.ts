import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Vpc, InstanceType, InstanceClass, InstanceSize, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  DatabaseCluster,
  DatabaseClusterEngine,
  AuroraPostgresEngineVersion,
  Credentials,
} from 'aws-cdk-lib/aws-rds';
import {
  RotationSchedule,
} from 'aws-cdk-lib/aws-secretsmanager';
import {
  Function,
  Runtime,
  Code,
} from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class CdkSecretsRotationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ✅ Create a VPC
    const vpc = new Vpc(this, 'RotationVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { 
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
    });

    const dbSecret = Credentials.fromGeneratedSecret('postgresadmin', {
      secretName: 'postgres-db-credential-secret'
    });

    const cluster = new DatabaseCluster(this, 'AuroraCluster', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_6,
      }),
      credentials: dbSecret,
      instances: 1,
      instanceProps: {
        instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
        vpc,
      },
    });

    const rotationLambda = new Function(this, 'RotationLambda', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(__dirname, '../services/rotation')),
      timeout: Duration.minutes(2),
      vpc,
      environment: {
        DB_CLUSTER_ARN: cluster.clusterArn,
        SECRET_ARN: dbSecret.secret?.secretArn ?? '',
      },
    });

    cluster.grantDataApiAccess(rotationLambda);
    dbSecret.secret?.grantRead(rotationLambda);
    dbSecret.secret?.grantWrite(rotationLambda);

    new RotationSchedule(this, 'SecretRotationSchedule', {
      secret: dbSecret.secret!,
      rotationLambda,
      automaticallyAfter: Duration.hours(1), // Minimum rotation interval allowed by Secrets Manager
    });
  }
}
