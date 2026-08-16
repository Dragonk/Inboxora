#!/usr/bin/env node
import { auditThreading } from '../services/threading/threadingReconciler.js';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));

const result = await auditThreading({
  accountId: args.get('account') || null,
  limit: Number(args.get('limit')) || undefined,
});
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.findings.length ? 2 : 0;
