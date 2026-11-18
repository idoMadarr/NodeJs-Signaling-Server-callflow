import { loadConfig } from './config';
import { createServer } from './app';

const cfg = loadConfig();
const server = createServer(cfg);

server.listen().then(port => {
  console.log(`Server started on port ${port}`);
  if (!cfg.turn.secret || !cfg.turn.urls.length) {
    console.warn('TURN_SECRET / TURN_URLS not set: clients get STUN only (same-network or easy NATs).');
  }
});

const shutdown = () => {
  server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
