import http from 'node:http'
import { catalog, runScenario } from './engine.mjs'
import { stopServers } from './servers.mjs'

const PORT = Number(process.env.SCENARIO_UI_PORT || 5399)

const page = `<!doctype html><meta charset="utf-8"><title>Scenarios</title>
<style>body{font-family:sans-serif;max-width:520px;margin:2rem auto}label{display:block;margin:.6rem 0}select,input,button{font-size:1rem}</style>
<h1>Scenario picker</h1>
<label>State <select id="name">${catalog.map((entry) => `<option>${entry}</option>`).join('')}</select></label>
<label>Seat <input id="seat" value="host" placeholder="host, Alice, Bob, Carol"></label>
<label>Language <select id="lang"><option value="en">en</option><option value="he">he</option></select></label>
<label>Round outcome <select id="outcome"><option>correct</option><option>wrong</option><option>none</option></select></label>
<label><input type="checkbox" id="mobile"> Mobile viewport</label>
<label><input type="checkbox" id="hip"> Host plays too (pool modes only)</label>
<button id="go">Run</button> <p id="status"></p>
<script>
go.onclick = async () => {
  status.textContent = 'Running...'
  const [mode, target] = name.value.split(':')
  const res = await fetch('/run', { method: 'POST', body: JSON.stringify({
    mode, target, seat: seat.value || 'host', lang: lang.value, outcome: outcome.value,
    mobile: mobile.checked, hostIsPlayer: hip.checked }) })
  status.textContent = await res.text()
}
</script>`

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/run') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
    }
    try {
      const run = await runScenario(JSON.parse(body))
      res.end(`Ready in room ${run.roomCode}`)
    } catch (error) {
      res.statusCode = 500
      res.end(String(error.message ?? error))
    }
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(page)
}).listen(PORT, '127.0.0.1', () => console.log(`Scenario picker: http://127.0.0.1:${PORT}`))

process.on('SIGINT', () => {
  stopServers()
  process.exit(0)
})
