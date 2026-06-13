// Minimal static file server for the e2e harness: serves the un-built app
// (index.html + js/ + vendor/ + styles.css) straight from the repo, so the
// browser loads the real module graph trystero and all.
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {join, normalize, extname} from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export function startServer(root, port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '')
      const file = join(root, rel)
      if (!file.startsWith(root)) { res.writeHead(403).end(); return }
      const body = await readFile(file)
      res.writeHead(200, {'content-type': TYPES[extname(file)] ?? 'application/octet-stream'})
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(port, () => {
      const {port: boundPort} = server.address()
      resolve({
        port: boundPort,
        url: `http://localhost:${boundPort}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
