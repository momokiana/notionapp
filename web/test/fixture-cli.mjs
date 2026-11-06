import { fixture } from './fixture.mjs';
import { writeFileSync } from 'node:fs';
const f = await fixture(Number(process.env.FIXTURE_PORT ?? 4318));
const button = await f.create(), text = await f.create('请补充本轮要求');
writeFileSync('.local/active-fixture.json', JSON.stringify({ origin: f.origin, user_token: f.userToken, event_ids: [button.event_id, text.event_id], database_root: f.root }, null, 2), { mode: 0o600 });
console.log('Isolated event service ready. Private connection material: web/.local/active-fixture.json. No AI or push enabled.');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await f.close(); process.exit(0); });
