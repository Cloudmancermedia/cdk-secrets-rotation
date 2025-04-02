import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Vpc, InstanceType, InstanceClass, InstanceSize, SubnetType, SecurityGroup, Port } from 'aws-cdk-lib/aws-ec2';
import {
  DatabaseCluster,
  DatabaseClusterEngine,
  AuroraPostgresEngineVersion,
  Credentials,
  ClusterInstance,
} from 'aws-cdk-lib/aws-rds';
import {
  HostedRotation,
  RotationSchedule,
} from 'aws-cdk-lib/aws-secretsmanager';
import {
  Function,
  Runtime,
  Code,
  LayerVersion,
} from 'aws-cdk-lib/aws-lambda';

export class CdkSecretsRotationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { 
          cidrMask: 24,
          name: 'Public',
          subnetType: SubnetType.PUBLIC
        },
        { 
          cidrMask: 24,
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
    });

    const dbSecurityGroup = new SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    const lambdaSecurityGroup = new SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    dbSecurityGroup.addIngressRule(lambdaSecurityGroup, Port.tcp(5432), 'Allow Lambda access');

    const dbSecret = Credentials.fromGeneratedSecret('postgresadmin', {
      secretName: 'postgres-db-credential-secret'
    });

    const cluster = new DatabaseCluster(this, 'AuroraCluster', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_6,
      }),
      securityGroups: [dbSecurityGroup],
      defaultDatabaseName: 'postgres',
      credentials: dbSecret,
      readers: [
        ClusterInstance.provisioned('reader', {
          instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
        })
      ],
      writer: ClusterInstance.provisioned('writer', {
        instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
      }),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      }
    });

    const pgLayer = new LayerVersion(this, 'PgLayer', {
      code: Code.fromAsset('lambda-layers/pg-layer'),
      compatibleRuntimes: [Runtime.NODEJS_22_X],
      description: 'Layer for PostgreSQL client (pg) and AWS SDK',
    });

    const rotationLambda = new Function(this, 'RotationLambda', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset('dist/services'),
      timeout: Duration.minutes(2),
      layers: [pgLayer],
      vpc,
      environment: {
        DB_CLUSTER_ARN: cluster.clusterArn,
        SECRET_ARN: cluster.secret?.secretArn ?? '',
      },
    });

    cluster.secret?.grantRead(rotationLambda);
    cluster.secret?.grantWrite(rotationLambda);

    cluster.secret?.addRotationSchedule('RotationSchedule', {
      rotationLambda,
      automaticallyAfter: Duration.hours(4),
      rotateImmediatelyOnUpdate: true,
    });

    // new RotationSchedule(this, 'SecretRotationSchedule', {
    //   secret: dbSecret.secret!,
    //   rotationLambda,
    //   automaticallyAfter: Duration.hours(1),
    // });
  };
}
