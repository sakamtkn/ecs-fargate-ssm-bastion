#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EcsFargateBastionStack } from './ecs-fargate-bastion-stack';

const app = new cdk.App();

new EcsFargateBastionStack(app, 'EcsFargateBastionStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});