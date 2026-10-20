#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.ts';

if (process.argv.slice(2).length!==1 || process.argv[2]!=='--demo') {
  process.stderr.write('Usage: npm start -- --demo\nOffline synthetic prototype only. No live service is connected.\n');
  process.exitCode=2;
} else {
  const handle=serveStdio(createServer);
  process.on('SIGINT',()=>{void handle.close();});
  process.on('SIGTERM',()=>{void handle.close();});
}
