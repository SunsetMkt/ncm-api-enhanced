#!/usr/bin/env node
/**
 * Generates module/index.js — a static module registry used by the Cloudflare
 * Workers entry point (worker.js) to avoid runtime filesystem access.
 *
 * Run: node scripts/generate-module-index.js
 */
'use strict'
const fs = require('fs')
const path = require('path')

const modulesPath = path.join(__dirname, '..', 'module')

const special = {
  'daily_signin.js': '/daily_signin',
  'fm_trash.js': '/fm_trash',
  'personal_fm.js': '/personal_fm',
}

const parseRoute = (fileName) =>
  special[fileName] ||
  `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`

const files = fs
  .readdirSync(modulesPath)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .reverse()

const lines = files.map((file) => {
  const identifier = file.split('.').shift()
  const route = parseRoute(file)
  return `  { identifier: '${identifier}', route: '${route}', module: require('./${file}') },`
})

const content = `/**
 * Auto-generated static module registry for Cloudflare Workers deployment.
 * Generated from module directory - do not edit manually.
 * Regenerate by running: node scripts/generate-module-index.js
 */
'use strict'
module.exports = [
${lines.join('\n')}
]
`

const outputPath = path.join(modulesPath, 'index.js')
fs.writeFileSync(outputPath, content)
console.log(`Generated module/index.js with ${files.length} modules`)
