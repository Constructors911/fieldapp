// Listen entry point. Port 4911. The express app itself lives in app.js so
// tests can import it and listen on an ephemeral port instead.
import { createApp } from './app.js';
import { createAdapter } from './adapters/index.js';

const adapter = createAdapter();
const app = createApp(adapter);
const port = Number(process.env.PORT) || 4911;

app.listen(port, () => {
  console.log(`c911 field server [adapter=${adapter.name}] listening on :${port}`);
});
