import { catalog, runScenario } from './engine.mjs'
import { stopServers } from './servers.mjs'

const [name, ...flags] = process.argv.slice(2)
if (!name || !catalog.includes(name)) {
  console.log('Usage: npm run scenario -- <mode>:<state> [--seat=host|Alice] [--lang=he] [--mobile] [--host-is-player] [--outcome=correct|wrong|none] [--visible-bots]\n')
  console.log(catalog.join('\n'))
  process.exit(name ? 1 : 0)
}

const flag = (key) => flags.find((entry) => entry.startsWith(`--${key}=`))?.split('=')[1]
const [mode, target] = name.split(':')

const run = await runScenario({
  mode,
  target,
  seat: flag('seat'),
  lang: flag('lang'),
  outcome: flag('outcome'),
  mobile: flags.includes('--mobile'),
  hostIsPlayer: flags.includes('--host-is-player'),
  visibleBots: flags.includes('--visible-bots'),
}).catch((error) => {
  console.error(error)
  stopServers()
  process.exit(1)
})

console.log(`Reached ${name} in room ${run.roomCode}. Close the browser window to finish.`)

let finished = false
const finish = async () => {
  if (finished) {
    return
  }
  finished = true
  await run.close()
  stopServers()
  process.exit(0)
}
// Closing the last window doesn't always kill the browser process, so also watch the page.
run.seatPage.on('close', finish)
run.browser.on('disconnected', finish)
