require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Hono } = require('hono')
const { serve } = require('@hono/node-server')
const { serveStatic } = require('@hono/node-server/serve-static')
const request = require('./util/request')
const packageJSON = require('./package.json')
const { cookieToJson } = require('./util/index')
const decode = require('safe-decode-uri-component')
const logger = require('./util/logger.js')
const {
  getModulesDefinitions,
  checkVersion,
  VERSION_CHECK_RESULT,
} = require('./server')

/**
 * Construct the server of NCM API using Hono.
 *
 * @param {import('./server').ModuleDefinition[]} [moduleDefs] Customized module definitions [advanced]
 * @returns {Promise<import('hono').Hono>} The Hono app instance.
 */
async function constructHonoServer(moduleDefs) {
  const app = new Hono()
  const { CORS_ALLOW_ORIGIN } = process.env

  /**
   * Serving static files
   */
  app.use('/*', serveStatic({ root: path.join(__dirname, 'public') }))

  /**
   * CORS & Preflight request
   */
  app.use('/*', async (c, next) => {
    const reqPath = c.req.path
    if (reqPath !== '/' && !reqPath.includes('.')) {
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
   * Special Routers
   */
  const special = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  }

  /**
   * Load every modules in this directory
   */
  const moduleDefinitions =
    moduleDefs ||
    (await getModulesDefinitions(path.join(__dirname, 'module'), special))

  for (const moduleDef of moduleDefinitions) {
    // Register the route.
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
       */
      const getClientIP = () => {
        let ip =
          (c.req.header('x-forwarded-for') || '').split(',')[0].trim() ||
          c.env?.incoming?.socket?.remoteAddress ||
          ''
        if (ip.substring(0, 7) === '::ffff:') {
          ip = ip.substring(7)
        }
        if (ip === '::1') {
          ip = global.cnIp
        }
        return ip
      }

      const isHttps = c.req.header('x-forwarded-proto') === 'https'

      try {
        const moduleResponse = await moduleDef.module(query, (...params) => {
          // 参数注入客户端IP
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

        // 夹带私货部分：如果开启了通用解锁，并且是获取歌曲URL的接口，则尝试解锁（如果需要的话）ヾ(≧▽≦*)o
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

/**
 * Serve the NCM API using Hono.
 *
 * @param {import('./server').NcmApiOptions} options
 * @returns {Promise<{ app: import('hono').Hono, server: import('http').Server }>}
 */
async function serveHonoNcmApi(options) {
  const port = Number(options.port || process.env.PORT || '3000')
  const host = options.host || process.env.HOST || ''

  const checkVersionSubmission =
    options.checkVersion &&
    checkVersion().then(({ npmVersion, ourVersion, status }) => {
      if (status == VERSION_CHECK_RESULT.NOT_LATEST) {
        logger.info(
          `最新版本: ${npmVersion}, 当前版本: ${ourVersion}, 请及时更新`,
        )
      }
    })
  const constructServerSubmission = constructHonoServer(options.moduleDefs)

  const [_, app] = await Promise.all([
    checkVersionSubmission,
    constructServerSubmission,
  ])

  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: host || undefined,
      },
      () => {
        console.log(`
   _   _  _____ __  __  
  | \\ | |/ ____|  \\/  |
  |  \\| | |    | \\  / |
  | . \` | |    | |\\/| |
  | |\\  | |____| |  | | 
  |_| \\_|\\_____|_|  |_|
    `)
        console.log(`
    ╔═╗╔═╗╦    ╔═╗╔╗╔╦ ╦╔═╗╔╗╔╔═╗╔═╗╔╦╗
    ╠═╣╠═╝║    ║╣ ║║║╠═╣╠═╣║║║║  ║╣  ║║
    ╩ ╩╩  ╩    ╚═╝╝╚╝╩ ╩╩ ╩╝╚╝╚═╝╚═╝═╩╝
    `)
        logger.info(`
- Server started successfully @ http://${host ? host : 'localhost'}:${port}
- Environment: ${process.env.NODE_ENV || 'development'}
- Node Version: ${process.version}
- Process ID: ${process.pid}`)
        resolve({ app, server })
      },
    )
  })
}

module.exports = {
  constructHonoServer,
  serveHonoNcmApi,
}
