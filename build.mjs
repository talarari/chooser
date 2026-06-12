// Builds the deployable site into dist/: the whole JS module graph (app code
// + vendored trystero) is bundled into a single file referenced with a
// commit-stamped URL, so a deploy can never serve a mix of cached old and new
// module versions to the same browser.
import {execSync} from 'node:child_process'
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'

const out = 'dist'
const stamp = execSync('git rev-parse --short HEAD').toString().trim()

rmSync(out, {recursive: true, force: true})
mkdirSync(out)

execSync(
  `npx -y esbuild@0.28.1 js/main.js --bundle --format=esm --minify --outfile=${out}/app.js`,
  {stdio: 'inherit'},
)

cpSync('styles.css', `${out}/styles.css`)
writeFileSync(`${out}/.nojekyll`, '')

const html = readFileSync('index.html', 'utf8')
  .replace('src="js/main.js"', `src="app.js?v=${stamp}"`)
  .replace('href="styles.css"', `href="styles.css?v=${stamp}"`)
if (!html.includes(`v=${stamp}`)) throw new Error('asset stamping failed — check index.html references')
writeFileSync(`${out}/index.html`, html)

console.log(`built ${out}/ (v=${stamp})`)
