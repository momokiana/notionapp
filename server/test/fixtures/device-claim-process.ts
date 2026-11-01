import { DeviceStore, type ClaimInput } from '../../src/device-store.js';
process.once('message', (input: { path: string; store_id: string; claim: ClaimInput }) => {
  let store: DeviceStore | undefined;
  try { store = new DeviceStore(input.path, input.store_id); const result = store.claim(input.claim, () => {}); process.send?.({ phase: 'claimed', result }); }
  catch (error) { process.send?.({ phase: 'refused', code: (error as { code?: string }).code ?? 'FIXTURE_FAILURE' }); }
  finally { store?.close(); process.disconnect(); }
});
process.send?.({ phase: 'ready' });
