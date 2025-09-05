#!/usr/bin/env node

import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { SSMClient, StartSessionCommand } from '@aws-sdk/client-ssm';
import { spawn } from 'child_process';

interface PortForwardOptions {
  clusterName: string;
  serviceName: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  region?: string;
}

class ECSPortForwarder {
  private ecsClient: ECSClient;
  private ssmClient: SSMClient;

  constructor(region = 'ap-northeast-1') {
    this.ecsClient = new ECSClient({ region });
    this.ssmClient = new SSMClient({ region });
  }

  async getRunningTaskRuntimeId(clusterName: string, serviceName: string): Promise<string> {
    // 実行中のタスクを取得
    const listTasksResponse = await this.ecsClient.send(
      new ListTasksCommand({
        cluster: clusterName,
        serviceName: serviceName,
        desiredStatus: 'RUNNING',
      })
    );

    if (!listTasksResponse.taskArns || listTasksResponse.taskArns.length === 0) {
      throw new Error(`No running tasks found for service ${serviceName} in cluster ${clusterName}`);
    }

    const taskArn = listTasksResponse.taskArns[0];
    const taskId = taskArn.split('/').pop()!;

    // タスクの詳細情報を取得
    const describeTasksResponse = await this.ecsClient.send(
      new DescribeTasksCommand({
        cluster: clusterName,
        tasks: [taskArn],
      })
    );

    const task = describeTasksResponse.tasks?.[0];
    if (!task || !task.containers || task.containers.length === 0) {
      throw new Error('Could not get task details');
    }

    const runtimeId = task.containers[0].runtimeId;
    if (!runtimeId) {
      throw new Error('Could not get runtime ID');
    }

    return `ecs:${clusterName}_${taskId}_${runtimeId}`;
  }

  async startPortForwarding(options: PortForwardOptions): Promise<void> {
    try {
      console.log('Setting up port forwarding...');
      console.log(`Remote: ${options.remoteHost}:${options.remotePort}`);
      console.log(`Local: localhost:${options.localPort}`);

      // SSMターゲットIDを取得
      const ssmTarget = await this.getRunningTaskRuntimeId(options.clusterName, options.serviceName);
      console.log(`SSM Target: ${ssmTarget}`);

      // AWS CLI経由でセッションを開始（AWS SDK for JSではセッション管理が複雑なため）
      const parameters = JSON.stringify({
        host: [options.remoteHost],
        portNumber: [options.remotePort.toString()],
        localPortNumber: [options.localPort.toString()],
      });

      console.log('Starting port forwarding session...');
      console.log('Press Ctrl+C to stop');

      const child = spawn('aws', [
        'ssm',
        'start-session',
        '--target',
        ssmTarget,
        '--document-name',
        'AWS-StartPortForwardingSessionToRemoteHost',
        '--parameters',
        parameters,
      ], {
        stdio: 'inherit',
      });

      child.on('error', (error) => {
        console.error('Error starting session:', error);
      });

      child.on('exit', (code) => {
        console.log(`Session ended with code: ${code}`);
      });

      // Graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nStopping port forwarding...');
        child.kill('SIGINT');
      });

    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  }
}

// CLI実行時の処理
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 6) {
    console.log('Usage: npx ts-node src/port-forward-helper.ts <cluster> <service> <remote_host> <remote_port> <local_port> [region]');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node src/port-forward-helper.ts bastion-cluster bastion-service mydb.cluster-xxx.rds.amazonaws.com 3306 3306');
    process.exit(1);
  }

  const [clusterName, serviceName, remoteHost, remotePort, localPort, region] = args;

  const forwarder = new ECSPortForwarder(region);
  forwarder.startPortForwarding({
    clusterName,
    serviceName,
    remoteHost,
    remotePort: parseInt(remotePort),
    localPort: parseInt(localPort),
    region,
  });
}

export { ECSPortForwarder };