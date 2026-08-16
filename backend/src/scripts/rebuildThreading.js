#!/usr/bin/env node
import { rebuildThreading } from '../services/threading/threadingReconciler.js';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));

const dryRun = args.get('write') !== true;
const result = await rebuildThreading({
  accountId: args.get('account') || null,
  limit: Number(args.get('limit')) || undefined,
  dryRun,
});
console.log(JSON.stringify(result, null, 2));
