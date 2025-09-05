import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class EcsFargateBastionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC作成
    const vpc = new ec2.Vpc(this, 'BastionVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ECSクラスター作成
    const cluster = new ecs.Cluster(this, 'BastionCluster', {
      vpc,
      clusterName: 'bastion-cluster',
      enableFargateCapacityProviders: true,
    });

    // ECS Execを有効にするためのタスクロール
    const taskRole = new iam.Role(this, 'BastionTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
      inlinePolicies: {
        ECSExecPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ssmmessages:CreateControlChannel',
                'ssmmessages:CreateDataChannel',
                'ssmmessages:OpenControlChannel',
                'ssmmessages:OpenDataChannel',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // タスク実行ロール
    const executionRole = new iam.Role(this, 'BastionExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // CloudWatch Logsグループ
    const logGroup = new logs.LogGroup(this, 'BastionLogGroup', {
      logGroupName: '/ecs/bastion-task',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // タスク定義
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BastionTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole,
      executionRole,
    });

    // コンテナ定義
    const container = taskDefinition.addContainer('BastionContainer', {
      image: ecs.ContainerImage.fromRegistry('amazonlinux:2'),
      essential: true,
      command: [
        '/bin/bash',
        '-c',
        'yum update -y && yum install -y amazon-ssm-agent && /usr/bin/amazon-ssm-agent & while true; do sleep 30; done',
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'bastion',
        logGroup,
      }),
    });

    // セキュリティグループ（踏み台用）
    const bastionSecurityGroup = new ec2.SecurityGroup(this, 'BastionSecurityGroup', {
      vpc,
      description: 'Security group for ECS Fargate bastion',
      allowAllOutbound: true,
    });

    // ECSサービス
    const service = new ecs.FargateService(this, 'BastionService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [bastionSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      enableExecuteCommand: true, // ECS Execを有効化
      serviceName: 'bastion-service',
    });

    // RDS用セキュリティグループ
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      description: 'Security group for RDS',
    });

    // 踏み台からRDSへのアクセスを許可
    rdsSecurityGroup.addIngressRule(
      bastionSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow access from bastion'
    );

    // サンプルRDSインスタンス（オプション）
    const rdsSubnetGroup = new rds.SubnetGroup(this, 'RdsSubnetGroup', {
      vpc,
      description: 'Subnet group for RDS',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    const rdsInstance = new rds.DatabaseInstance(this, 'SampleDatabase', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      subnetGroup: rdsSubnetGroup,
      securityGroups: [rdsSecurityGroup],
      databaseName: 'sampledb',
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
    });

    // 出力
    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster Name',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS Service Name',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: rdsInstance.instanceEndpoint.hostname,
      description: 'RDS Endpoint',
    });

    new cdk.CfnOutput(this, 'PortForwardCommand', {
      value: [
        'aws ssm start-session',
        '--target ecs:bastion-cluster_<TASK_ID>_<RUNTIME_ID>',
        '--document-name AWS-StartPortForwardingSessionToRemoteHost',
        `--parameters '{"host":["${rdsInstance.instanceEndpoint.hostname}"],"portNumber":["3306"],"localPortNumber":["3306"]}'`,
      ].join(' '),
      description: 'SSM Port Forward Command Template',
    });
  }
}