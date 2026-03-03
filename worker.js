/**
 * Cloudflare Workers entry point for NCM API Enhanced.
 *
 * Based on server.hono.js and adapted for the Cloudflare Workers runtime:
 *  - Static module registry (module/index.js) replaces runtime fs.readdir.
 *  - Static file serving is handled via Cloudflare Workers Assets (wrangler.jsonc).
 *  - Environment variables are read from process.env (populated by the CF runtime
 *    via the nodejs_compat compatibility flag).
 *  - The CF-connecting-ip header is used to resolve the real client IP.
 *
 * Deploy with: npx wrangler deploy
 */
'use strict'

const { Hono } = require('hono')
const request = require('./util/request')
const { cookieToJson } = require('./util/index')
const decode = require('safe-decode-uri-component')
const logger = require('./util/logger.js')
const moduleDefinitions = require('./module/index.js')

/**
 * Build the Hono application.
 * Called once at module-load time so the app is reused across requests.
 *
 * @returns {import('hono').Hono}
 */
function createApp() {
  const app = new Hono()

  /**
   * CORS & Preflight request
   */
  app.use('/*', async (c, next) => {
    const reqPath = c.req.path
    if (reqPath !== '/' && !reqPath.includes('.')) {
      const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header(
        'Access-Control-Allow-Origin',
        CORS_ALLOW_ORIGIN || c.req.header('origin') || '*',
      )
      c.header('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type')
      c.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS')
      c.header('Content-Type', 'application/json; charset=utf-8')
    }
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204)
    }
    return next()
  })

  /**
   * Register every API route from the static module registry.
   */
  for (const moduleDef of moduleDefinitions) {
    app.all(moduleDef.route, async (c) => {
      /**
       * Cookie Parser
       */
      const cookies = {}
      ;(c.req.header('cookie') || '')
        .split(/;\s+|(?<!\s)\s+$/g)
        .forEach((pair) => {
          let crack = pair.indexOf('=')
          if (crack < 1 || crack == pair.length - 1) return
          cookies[decode(pair.slice(0, crack)).trim()] = decode(
            pair.slice(crack + 1),
          ).trim()
        })

      /**
       * Query params
       */
      const queryParams = Object.fromEntries(
        new URL(c.req.url).searchParams.entries(),
      )

      /**
       * Body parser
       */
      let body = {}
      const contentType = c.req.header('content-type') || ''
      if (contentType.includes('application/json')) {
        try {
          body = await c.req.json()
        } catch (_) {
          /* ignore parse errors */
        }
      } else if (
        contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data')
      ) {
        try {
          body = await c.req.parseBody({ all: true })
        } catch (_) {
          /* ignore parse errors */
        }
      }

      ;[queryParams, body].forEach((item) => {
        if (item && typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      let query = Object.assign({}, { cookie: cookies }, queryParams, body)

      /**
       * Resolve the client IP address.
       * CF Workers provides the real IP via the CF-Connecting-IP header.
       */
      const getClientIP = () => {
        let ip =
          c.req.header('cf-connecting-ip') ||
          (c.req.header('x-forwarded-for') || '').split(',')[0].trim() ||
          ''
        if (ip.substring(0, 7) === '::ffff:') {
          ip = ip.substring(7)
        }
        return ip
      }

      const isHttps =
        c.req.header('x-forwarded-proto') === 'https' ||
        new URL(c.req.url).protocol === 'https:'

      try {
        const moduleResponse = await moduleDef.module(query, (...params) => {
          // Inject client IP into every outgoing request
          const obj = [...params]
          const options = obj[2] || {}
          if (!options.randomCNIP) {
            obj[2] = {
              ...options,
              ip: getClientIP(),
            }
          }
          return request(...obj)
        })
        logger.info(`Request Success: ${decode(c.req.path)}`)

        // General unblock for song/url/v1 when ENABLE_GENERAL_UNBLOCK is set
        if (
          c.req.path === '/song/url/v1' &&
          process.env.ENABLE_GENERAL_UNBLOCK === 'true'
        ) {
          const song = moduleResponse.body.data[0]
          if (
            song.freeTrialInfo !== null ||
            !song.url ||
            [1, 4].includes(song.fee)
          ) {
            const {
              matchID,
            } = require('@neteasecloudmusicapienhanced/unblockmusic-utils')
            logger.info('Starting unblock(uses general unblock):', query.id)
            const result = await matchID(query.id)
            song.url = result.data.url
            song.freeTrialInfo = null
            logger.info('Unblock success! url:', song.url)
          }
          if (song.url && song.url.includes('kuwo')) {
            const proxy = process.env.PROXY_URL
            const useProxy = process.env.ENABLE_PROXY || 'false'
            if (useProxy === 'true' && proxy) {
              song.proxyUrl = proxy + song.url
            }
          }
        }

        const responseCookies = moduleResponse.cookie
        if (!query.noCookie) {
          if (Array.isArray(responseCookies) && responseCookies.length > 0) {
            responseCookies.forEach((cookie) => {
              c.header(
                'Set-Cookie',
                isHttps ? cookie + '; SameSite=None; Secure' : cookie,
                true,
              )
            })
          }
        }

        return c.json(moduleResponse.body, moduleResponse.status)
      } catch (/** @type {*} */ moduleResponse) {
        logger.error(`${decode(c.req.path)}`, {
          status: moduleResponse.status,
          body: moduleResponse.body,
        })
        if (!moduleResponse.body) {
          return c.json({ code: 404, data: null, msg: 'Not Found' }, 404)
        }
        if (moduleResponse.body.code == '301')
          moduleResponse.body.msg = '需要登录'
        if (!query.noCookie && moduleResponse.cookie) {
          const cookieArr = Array.isArray(moduleResponse.cookie)
            ? moduleResponse.cookie
            : [moduleResponse.cookie]
          cookieArr.forEach((cookie) => {
            c.header(
              'Set-Cookie',
              isHttps ? cookie + '; SameSite=None; Secure' : cookie,
              true,
            )
          })
        }
        return c.json(moduleResponse.body, moduleResponse.status)
      }
    })
  }

  return app
}

const app = createApp()

module.exports = app
