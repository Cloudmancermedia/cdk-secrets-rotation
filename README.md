# Secrets Manager Rotation for RDS DB Credentials

A simple repo demonstrating how Secrets Manager rotation works with RDS DB credentials.

This repo builds on [this one](https://github.com/Cloudmancermedia/cdk-rds-iam) by adding a rotation schedule for our RDS DB credentials object in Secrets Manager.

1. `cd` into the `nodejs` folder and npm i
2. run `npm run build` in the root CDK driectotu
3. run `cdk deploy --profile <your profile name>` to deploy to your AWS account.
