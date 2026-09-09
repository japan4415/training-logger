import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../public/js/vendor/', import.meta.url), { recursive: true });
for (const [source, target] of [['build/three.module.js', 'three.module.js'], ['LICENSE', 'THREE-LICENSE.txt']]) {
  copyFileSync(new URL(`../node_modules/three/${source}`, import.meta.url), new URL(`../public/js/vendor/${target}`, import.meta.url));
}
