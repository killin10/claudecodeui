import { paths } from './layout.mjs';
import { launch } from './runtime.mjs';

try {
  await launch(paths(process.argv[2]));
} catch (error) {
  console.error(`[cloudcli] ${error.message}`);
  process.exitCode = 1;
}
