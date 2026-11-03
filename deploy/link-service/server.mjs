// Runs the link service: public link-domain traffic on PORT, and Caddy's on-demand TLS
// check on ASK_PORT, which only the edge Caddy reaches. See links.mjs.
import { createServer } from 'node:http'
import { createLinkService, createUpstream } from './links.mjs'

const env = process.env
const log = (message) => console.error(`${new Date().toISOString()} ${message}`)

function serve(port, name, handler) {
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      log(`${name} request failed: ${error.message}`)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('The link service failed.')
    })
  })
  server.keepAliveTimeout = 65_000
  server.listen(port, () => log(`${name} listening on ${port}.`))
  return server
}

function main() {
  const upstream = createUpstream({
    url: env.KMA_LINKS_URL,
    secret: env.KMA_ATTRIBUTION_LINK_SECRET,
  })
  const service = createLinkService({ ...upstream, log })
  const servers = [
    serve(Number(env.PORT || 8788), 'Links', service.handle),
    serve(Number(env.ASK_PORT || 8789), 'Certificate check', service.ask),
  ]
  const stop = () => {
    let open = servers.length
    for (const server of servers) server.close(() => --open || process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
