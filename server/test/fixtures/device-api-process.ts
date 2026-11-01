import { createApp } from '../../src/app.js';
import { fileRegistry } from '../../src/auth.js';
import { DeviceStore } from '../../src/device-store.js';
import { DeviceAuthority } from '../../src/device-authority.js';
import { openDatabase } from '../../src/database.js';

interface Input { authority_path: string; store_id: string; auth_file: string; ledger_path: string; port: number; drop?: { path: string; request_id: string } }
process.once('message', async (input: Input) => {
  let store: DeviceStore | undefined;
  try {
    store = new DeviceStore(input.authority_path, input.store_id);
    const authority = new DeviceAuthority(store, fileRegistry(input.auth_file));
    const app = createApp(openDatabase(input.ledger_path), false, { deviceAuthority: authority });
    if (input.drop) {
      const drop = input.drop;
      app.addHook('onSend', async (request, reply, payload) => {
        const body = request.body as { claim_id?: string; request_id?: string } | undefined;
        if (request.url === drop.path && reply.statusCode === 200 && (body?.claim_id === drop.request_id || body?.request_id === drop.request_id)) {
          request.raw.socket.destroy();
          process.send?.({ phase: 'committed_ack_lost' });
        }
        return payload;
      });
    }
    const url = await app.listen({ host: '127.0.0.1', port: input.port });
    process.send?.({ phase: 'ready', url });
    process.once('message', async message => {
      if (message === 'close') { await app.close(); store?.close(); process.disconnect(); }
    });
  } catch { store?.close(); process.send?.({ phase: 'failed' }); process.disconnect(); process.exitCode = 1; }
});
process.send?.({ phase: 'waiting' });
