/* eslint-disable valid-jsdoc */
/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
'use strict'

const EventEmitter = require('events')

class ModelEmitter extends EventEmitter {
  addEventHandler(table, event, handler, scope) {
    const eventName = table + '.' + event
    if (!this.listeners(eventName).length) {
      this.on(eventName, handler.bind(scope))
    }
  }
}

const util = require('util')
const Query = require('./lib/query')
const crypto = require('crypto')
const cconsole = require('./cconsole')

const Record = require('./record')
const internals = {
  withOptions: {},
  db_config: {},
  version: require('./package').version,
  i18n: {
    dayNames: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
    monthNames: ['янв', 'фев', 'март', 'апр', 'май', 'июнь', 'июль', 'авг', 'сен', 'окт', 'ноя', 'дек', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  },
  cachedModels: {},
  associations: new Map(),
  hashString: (string) => {
    return crypto.createHash('md5').update(string).digest('hex')
  },
  eventProxy: new ModelEmitter(),
  events: new Map(),
  eventHandlers: new Map(),
}

const whereConvert = function(args, model) {
  if (args && args.length === 1 && typeof args[0] === 'object' && Object.keys(args[0]).length) {
    args = args[0]
    const opts = []
    let s = Object.keys(args).filter((el) => el !== '_sql').map((el) => {
      const val = args[el]
      opts.push(args[el])
      if (!el.includes('.')) {
        el = `${model.table}.${el}`
      }
      return Array.isArray(val) ? `${el} IN ?` : `${el} = ?`
    })
    if (Array.isArray(args._sql) && args._sql[0]) {
      s = s.concat(args._sql)
    }
    opts.unshift(s.join(' AND '))
    return opts
  } else {
    return args
  }
}
/**
 * @param {String} table  table name
 * @param {Object} cfg
 * @param {Boolean} cfg.default set database config as default in multi-db configuration
 * @param {Object} cfg.connection mysql2 connnection config, https://github.com/sidorares/node-mysql2/blob/master/lib/connection_config.js
 * @param {String} dbname database name
 */
class Model {
  constructor(table, cfg = {}, dbname) {
    if (!internals.db_config) {
      return this
    }

    this.debug = cfg.debug

    this.assocs = internals.associations

    this.eventProxy = internals.eventProxy

    this._Model = Model
    this.clone = () => {
      return new Model(table, cfg, dbname)
    }
    this.modelConfig = cfg || {}
    this.table = table
    this.dbname = dbname || cfg.db || internals.default_db_name
    if (!this.dbname) {
      console.log('default_db_name = ', internals.default_db_name)
      throw new Error('database must be marked as default or must expicitly define in model config')
    }
    this._setupGlobalListeners()// must be set table before call!!!
    this.dbConfig = internals.db_config[this.dbname]
    this.Q = new Query()
    // this.Q.registerValueHandler(Date, (d) => {
    //   return d;
    // });
    this.df = require('dateformat')
    this.df.i18n = internals.i18n
    this.strftime = function(v, format) {
      return this.df(v, format || 'dd-mmmm-yyyy HH:MM')
    }
    // this.Q.useFlavour('mysql');

    const DbService = require('./lib/dbservice')
    this.base = new DbService(this.dbConfig, this.modelConfig.debug, {serviceConn: this.modelConfig.serviceConn})

    this.logs = []

    this._resetModel()

    this.showLog = function(e, ...args) {
      args.length ? this.logs.push(util.inspect(args), e) : this.showLog(e)
      console.log('\r\nError : ********************************************************')
      console.log(`model ${this.dbname}.${this.table} error `, this.logs.join(':'))
      console.log('****************************************************************\r\n')
    }.bind(this)

    this.runCatch = function(func, ...args) {
      try {
        return func.call(this)
      } catch (ex) {
        this.showLog(ex, args)
        throw ex
      }
    }

    // this.Q.registerValueHandler(Date, function(date) {
    //   return date;
    // });
    this.query = ''

    const me = this

    if (cfg.oldMode || cfg.raw) {
      cfg.debug && console.log(this.table, ' DO NOT used data cb callback')
      this.setProcessDataCallback = false
    } else {
      cfg.debug && console.log(this.table, ' used data cb callback, cfg: ', cfg)
      this.setProcessDataCallback(function(rows) {
        return Array.isArray(rows) ? rows.map((row) => new Record(row, {strict: cfg.strict, processed: true, assoc: me.assocs.get(me.table), owner: me, model: Model})) : new Record(rows, {strict: cfg.strict, processed: true, assoc: me.assocs.get(me.table), owner: me, model: Model})
      })
    }

    if (!internals.cachedModels[this.table]) {
      internals.cachedModels[this.table] = me
    }
    return this
  }
  /**
 * helper methods SECTION
 */

  static create(table, cfg = {}, dbname) {
    if (cfg.debug) {
      console.log('*'.repeat(100))
      console.log('create table %s with config:', table)
      console.dir(cfg)
    }
    return () => new this(table, cfg, dbname)
  }

  static eventHandler(event, handler) {
    if (['insert', 'update', 'delete'].includes(event)) {
      if (typeof handler === 'function') {
        internals.eventHandlers.set(event, handler)
      } else {
        internals.eventHandlers.delete(event)
      }
    }
  }

  static util() {
    return {
      // return array of numbered fields, for example fi('cp', 3, 0) will return ['cp0', 'cp1', 'cp2']
      fi: (f, n, st = 1) => {
        const res = []
        for (let i = 0; i < n; i++) {
          res.push(f + (st + i).toString())
        }
        return res
      },
    }
  }

  /**
 * initialize model internals
 * @memberof Model
 */
  _resetModel() {
    this.paginate = false
    this.opMode = 'afterReset'
    this.action = ''
    this.actionData = []
    this.operations = {}
    return this
  }
  /**
 * @param {String} mode start mode : find / insert / update / delete
 * @param {any} args
 * @memberof Model
 */
  _setOpMode(mode, ...args) {
    this._resetModel()
    this.opMode = mode
    args.unshift(mode)
    this._addOpMode(...args)
  }
  /**
 * @return {String} model start mode
 * @memberof Model
 */
  getOpMode() {
    return this.opMode
  }
  /**
 * @param {String} mode sql builder option
 * @param {any} args
 * @memberof Model
 */
  _addOpMode(mode, ...args) {
    if (this.debug) {
      console.log('addOpMode : %s, args : ', mode, ...args)
    }
    if (args.length === 1) {
      args = args[0]
    }
    const el = {}
    el[mode] = args || null
    this.logs.push(el)
    this.operations[mode] = this.operations[mode] || []
    if (args) {
      this.operations[mode].push(args)
    }
  }
  /**
 * bind event listeners to instance of model
 * @memberof Model
 */
  _setupGlobalListeners() {
    const _events = internals.events.get(this.table)
    if (typeof _events === 'object' && Object.keys(_events).length) {
      Object.keys(_events).forEach((event) => {
        const handler = typeof _events[event] === 'function' ? _events[event] : _events[event].handler
        const scope = _events[event].scope
        if (typeof handler !== 'function') {
          return
        }
        this.eventProxy.addEventHandler(this.table, event, handler, scope || this)
      })
    }
  }
  /**
 * @static
 * @param {String|Object} table table name if String, otherwise object where root keys is table names and values is event listeners config
 * @param {Object} events event listeners config, for example {find: {handler: (params) => {someHandler(params)}, scope: someScope}}
 * @param {Object|Function} events.find event listener or event listener config {handler: fn, scope: scope}
 * @param {Function} events.find.handler
 * @param {Object} events.find.scope
 * @memberof Model
 */
  static setupListeners(table, events) {
    if (!events) {
      Object.keys(table).forEach((key) => {
        internals.events.set(key, table[key])
      })
    } else {
      internals.events.set(table, events)
    }
  }
  /**
 * @param {any} args will log to console in debug mode
 * @memberof Model
 */
  consoleDebug(...args) {
    if (this.modelConfig.debug) {
      console.info.apply(this, args)
    }
  }
  /**
 * @static
 * @param {any} table
 * @param {any} assoc
 * @memberof Model
 */
  static setAssoc(table, assoc) {
    if (internals.associations.has(table)) {

    } else {
      internals.associations.set(table, assoc)
    }
  }
  /**
 * set databases config
 * @param cfg {Object|Array} cfg can be Object or Array of Objects if used multi-db configurations. in multi-db config you should mark one db as default or define database name in each Model instance elsewhere will be used first config in array
 * @param cfg {Object} mysql2 connnection config, https://github.com/sidorares/node-mysql2/blob/master/lib/connection_config.js
 * @param cfg.default {Boolean} set database config as default in multi-db configuration
 */
  static setConfig(cfg) {
    console.log('actual Model2 version : ', internals.version)
    if (!Array.isArray(cfg)) {
      cfg = [cfg]
    }
    Object.keys(cfg).forEach((key) => {
      const defaultDb = cfg[key]
      delete cfg[key].default
      if (cfg[key] && cfg[key].database && cfg[key].database.length) {
        internals.db_config[cfg[key].database] = cfg[key]
        if (!internals.default_db_name) {
          if (defaultDb) {
            internals.default_db_name = cfg[key].database
            console.log('set default_db_name to ', internals.default_db_name)
          } else {
            internals.default_db_name = cfg[Object.keys(cfg)[0]].database
            console.log('set default_db_name to ', internals.default_db_name)
          }
        }
      }
    })
  }

  static getPool() {
    return this.base.getPool()
  }

  static version() {
    return internals.version
  }

  setProcessDataCallback(processFn) {
    if (typeof processFn === 'function') {
      this._processFn = processFn
    }
  }

  /**
 * @param {String} event
 * @param {Function} handler after event handler will call with args : Model instance, request params, returned operation data
 * @param {Object} scope
 * @memberof Model
 */
  on(event, handler, scope) {
    this.eventProxy.addEventHandler(this.table, event, handler, scope || this)
  }

  getListener(event) {
    return this._getEventListeners().get(event)
  }

  async _doRequestUpdate(params) {
    const me = this
    const conn = await this.base.getConn()
    if (!conn) {
      console.error('error get db connection')
      throw new Error('error get db connection')
    }
    await this.base.doConn(conn, 'BEGIN;').then((res) => console.log('BEGIN;', res))
    const data = await this.base.doConn(conn, {sql: params.text, values: params.values}).catch((ex) => {
      console.error('error _doRequest : %s\n', JSON.stringify(params), JSON.stringify(ex))
      me.base.doConn('ROLLBACK;').then((res) => console.log('ROLLBACK;', res))
      conn.release()
      throw ex
    })
    await this.base.doConn(conn, 'COMMIT;').then((res) => console.log('COMMIT;', res))
    const handler = internals.eventHandlers.get(this.action)
    if (handler) {
      handler(this)
    }
    if (params.bypassEvents) {
      return data
    }
    const event = this.table + '.' + this.getOpMode()
    internals.eventProxy.emit(event, this, params, data)
    return data
  }

  raw() {
    this._raw = true
    return this
  }

  _needWrap(opts) {
    return this._processFn && !opts.raw && !this._raw
    return this
  }

  async _doRequest(params) {
    this.consoleDebug(this.getOpMode())

    params.sql = params.sql || params.text
    const data = await this.base.do(params).catch((ex) => {
      console.error('error _doRequest : %s\n', JSON.stringify(params), JSON.stringify(ex))
      throw ex
    })
    const handler = internals.eventHandlers.get(this.action)
    if (handler) {
      handler(this)
    }
    if (params.bypassEvents) {
      return data
    }
    const event = this.table + '.' + this.getOpMode()
    internals.eventProxy.emit(event, this, params, data)
    return data
  }

  async doPage(opts = {}) {
    this._addOpMode('doPage', opts)
    if (Number.isSafeInteger(opts.offset) && Number.isSafeInteger(opts.limit)) {
      opts.page = Math.round(opts.offset / opts.limit) + 1
    }
    if (opts.page) {
      this.page(opts.page, opts.limit)
    }
    if (!this.paginate) {
      if (this.debug) {
        console.log('context before throw : ', this)
      }
      throw new Error('cant do paginate while paging is not configured, try call .page(number) or .doPage({page: number})!')
    }
    const result = {paginate: true}
    // let queryClone = this.query.clone()//.field(`COUNT(${this.table}.id) as count`)
    // let paramsTotal = queryClone.toParam()
    // if (opts.debug) {
    //   console.log('\n do local debug message:')
    //   console.log('query for count total')
    //   cconsole.log(opts.debug, queryClone.toString())
    //   console.log('\n', 'query with limit, offset')
    //   cconsole.log(opts.debug, this.query.toString())
    //   cconsole.log('reset', '\n')
    // }
    // paramsTotal.bypassEvents = true
    const paramsQuery = this.query.limit(this.paginate.limit).offset(this.paginate.offset).toParam()
    paramsQuery.foundRows = true
    // let data
    // data = await this._doRequest({ text: `SELECT COUNT(*) as count FROM (${paramsTotal.text}) sq`, values: paramsTotal.values })
    let {rows: data, count} = await this._doRequest(paramsQuery).catch((ex) => {
      console.error(ex); throw ex
    })
    result.count = count
    result.pages = Math.ceil(result.count / this.paginate.limit)
    const opMode = this.opMode
    this._resetModel()
    if (opMode === 'find') {
      if (this._needWrap(opts)) {
        const me = this
        data = this.runCatch(function() {
          return me._processFn(data)
        }, opts)
      }
    }
    result.rows = data
    return result
  }

  /**
  *
  * @param {*} opts
  * @param {*} opts.raw - dont process rows
  */
  async do(opts) {
    const me = this
    opts = opts || {}
    opts.fields = opts.fields || this.modelConfig.fields

    let data
    this._addOpMode('do', opts)
    if (this.paginate) {
      return this.doPage(opts)
    }

    if (opts.debug) {
      console.log('\n do local debug message:')
      cconsole.log(opts.debug, this.query.toString())
      cconsole.log('reset', '\n')
    }

    const params = this.query.toParam()
    data = await this._doRequest(params)
    const opMode = this.opMode
    me._resetModel()
    if (opMode === 'count') {
      return data[0].count
    }
    if (opMode === 'find') {
      if (this._needWrap(opts)) {
        data = this.runCatch(function() {
          return me._processFn(data)
        }, opts)
      }
      if (opts.last) {
        return data.pop()
      }
      if (opts.first) {
        return data.shift()
      }
    }
    // return newly created record as Record instance
    if (this.opMode === 'insert' && data.insertId) {
      return this.find().where('id = ?', data.insertId).first()
    }
    return data
  }

  doFirst() {
    return this.first()
  }

  one(...whereArgs) {
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    if (whereArgs.length) {
      this.where(...whereArgs)
    }
    return this.limit(1).do({first: true})
  }

  first(...whereArgs) {
    return this.one(...whereArgs)
  }

  // first (...whereArgs) {
  //   if (this.getOpMode() === 'afterReset') {
  //     this.find()
  //   }
  //   if (whereArgs.length) {
  //     this.where(...whereArgs)
  //   }
  //   return this.limit(1).do({ first: true })
  // }

  count(field = 'id') {
    const me = this
    this._setOpMode('count', field)
    return this.runCatch(function() {
      if (field.includes('.')) {
        field = `COUNT(${field}) as count`
      } else {
        field = `COUNT(${me.table}.${field}) as count`
      }
      me.query = me.Q.select().from(me.table).field(field)
      return me
    }, field)
  }

  find(table, fields) {
    const me = this
    this._setOpMode('find', table, fields)
    fields = fields || '*'
    return this.runCatch(function() {
      if (typeof table === 'object' && table.fields && table.fields.length) {
        if (Array.isArray(table.fields)) {
          table.fields = table.fields.map((f) => me.table + '.' + f).join(',')
        }
        me.query = me.Q.select().from(me.table).field(table.fields)
        return me
      } else {
        me.query = table ? me.query.from(table).field(table + '.' + fields) : me.Q.select().from(me.table).field(me.table + '.' + fields)
        return me
      }
    }, table, fields)
  }

  update(data) {
    const me = this
    this._setOpMode('update', data)
    return this.runCatch(function() {
      me.query = me.Q.update().table(me.table)
      if (data && typeof data === 'object' && Object.keys(data).length) {
        me.setFields(data)
      }
      me.action = 'update'
      me.actionData = data ? [data] : []
      return me
    }, data)
  }

  insert(data) {
    const me = this
    this._setOpMode('insert', data)
    return this.runCatch(function() {
      me.query = me.Q.insert().into(me.table)
      if (data && typeof data === 'object' && Object.keys(data).length) {
        me.setFields(data)
      }
      me.action = 'insert'
      me.actionData = data ? [data] : []
      return me
    }, data)
  }

  delete() {
    const me = this
    this._setOpMode('delete')
    return this.runCatch(function() {
      me.query = me.Q.delete().from(me.table)
      me.action = 'delete'
      me.actionData = []
      return me
    })
  }

  page(page, pageSize) {
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    pageSize = pageSize || this.modelConfig.pageSize || 20
    let offset
    if (typeof page === 'object') {
      const opts = page
      page = opts.page
      pageSize = opts.limit || this.modelConfig.pageSize || 20
      offset = opts.offset
    }
    this._addOpMode('page', page, pageSize)
    if (page < 1) page = 1
    this.paginate = {
      page: page,
      offset: offset || ((page - 1) * pageSize),
      limit: pageSize,
    }
    return this
  }

  join(table, where, alias) {
    const me = this
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    this._addOpMode('join', table, where, alias)
    return this.runCatch(function() {
      me.query = me.query.join(table, alias, where)
      me.actionData.push({join: [table, where, alias]})
      return me
    }, table, where, alias)
  }

  outerJoin(table, where, alias) {
    const me = this
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    this._addOpMode('outer_join', table, where, alias)
    return this.runCatch(function() {
      me.query = me.query.join(table, alias, where, 'OUTER')
      me.actionData.push({outer_join: [table, where, alias]})
      return me
    }, table, where, alias)
  }

  leftOuterJoin(table, where, alias) {
    const me = this
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    this._addOpMode('left_outer_join', table, where, alias)
    return this.runCatch(function() {
      me.query = me.query.join(table, alias, where, 'LEFT OUTER')
      me.actionData.push({left_outer_join: [table, where, alias]})
      return me
    }, table, where, alias)
  }

  leftJoin(table, where, alias) {
    const me = this
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    this._addOpMode('left_join', table, where, alias)
    return this.runCatch(function() {
      me.query = me.query.join(table, alias, where, 'LEFT')
      me.actionData.push({left_join: [table, where, alias]})
      return me
    }, table, where, alias)
  }

  distinct() {
    this._addOpMode('distinct')
    this.query = this.query.distinct()
    return this
  }

  field(...args) {
    const me = this
    this._addOpMode(this, ...[].concat('field', args))
    return this.runCatch(function() {
      me.query = me.query.field.apply(me, args)
      return me
    }, args)
  }

  fields(opts) {
    this._addOpMode('fields', opts)
    try {
      this.query = this.query.fields(opts)
    } catch (e) {
      this.showLog(e, opts)
    }
    return this
  }

  setFields(opts) {
    const me = this
    this._addOpMode('setFields', opts)
    return this.runCatch(function() {
      if (typeof opts === 'string') {
        me.query.set(opts)
        return me
      }
      Object.keys(opts || {}).forEach((k) => {
        const escaped = '`' + me.table + '`.`' + k + '`'
        me.query.set(escaped, opts[k])
      })
      return me
    }, opts)
  }

  set(opts) {
    return this.setFields(opts)
  }

  limit(opts) {
    const me = this
    this._addOpMode('limit', opts)
    return this.runCatch(function() {
      me.query = me.query.limit(opts)
      return me
    }, opts)
  }

  offset(opts) {
    const me = this
    this._addOpMode('offset', opts)
    return this.runCatch(function() {
      me.query = me.query.offset(opts)
      return me
    }, opts)
  }

  order(...args) {
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    if (args.length === 1) {
      const t = args[0].split(' ')
      if (t.length === 2) {
        args = t
      }
    }
    if (args[1]) {
      if (['asc', 'desc', 'ASC', 'DESC'].includes(args[1])) {
        args[1] = !(args[1] === 'desc' || args[1] === 'DESC')
      }
    }
    const me = this
    this._addOpMode(...[].concat('order', args))
    return this.runCatch(function() {
      me.query = me.query.order.apply(me, args)
      return me
    }, args)
  }

  group(by) {
    const me = this
    this._addOpMode('group', by)
    return this.runCatch(function() {
      me.query = me.query.group(by)
      return me
    }, by)
  }

  having(...args) {
    const me = this
    this._addOpMode(this, ...[].concat('having', args))
    return this.runCatch(function() {
      me.query = me.query.having(...args)
      return me
    }, args)
  }

  where(...args) {
    const me = this
    if (this.getOpMode() === 'afterReset') {
      this.find()
    }
    this._addOpMode(this, ...[].concat('where', args))
    args = whereConvert(args, this)
    this.actionData.push({where: args})
    return this.runCatch(function() {
      me.query = me.query.where(...args)
      return me
    }, args)
  }

  _wrapField(field) {
    return '`' + this.table + '`.`' + field + '`'
  }

  setKV(k, v) {
    this.query = this.query.set(this._wrapField(k), v)
    return this
  }

  debugLog(fn) {
    if (!fn) {
      fn = (log) => console.log('\nsql = ', log, '\n')
    }
    const sql = this.query.toString()
    if (typeof fn === 'function') {
      fn.call(this, sql)
    }
    return this
  }

  /**
## [starter method] - this method must be first at chain because is initialized inner 'squel' var
@method Model.upsert
@param {Object} fieldSet hash keys as field names and values
@param {} whereArguments arguments for where , when find and next update/insert operation
@return {Promise}
@example
  SomeTable.upsert({name: 'somename'}, 'kind = ?', 'car')
    .then(data => {
      console.log(data.insertId || data.affectedRows)
    })
*/
  upsert(...opts) {
    const fieldsData = opts.shift()
    const me = this
    return me.find().where.apply(me, opts).doFirst()
      .then((rec) => {
        if (rec) {
          return me.update().where.apply(me, opts).setFields(fieldsData).do()
        } else {
          return me.insert().setFields(fieldsData).do()
        }
      })
  }

  findBy(field, values) {
    this._resetModel().find().where(`${this._wrapField(field)} ${Array.isArray(values) ? 'IN' : '='} ?`, values)
    return this
  }

  getFields() {
    return this.base.do({
      sql: `SHOW COLUMNS FROM ${this.table}`,
    })
  }

  addColumn(fieldSql) {
    return this.base.do({
      sql: `ALTER TABLE \`${this.table}\` ADD ${fieldSql}`,
    })
  }

  exists() {
    return this.base.do({
      sql: `SHOW TABLES LIKE '${this.table}'`,
    }).then((rows) => rows[0])
  }

  /**
 * @
 * @description set scope from any Model methods or apply scope methods (all scopes stored globally in Model class and all instances has access to scopes)
 * @param {string} scope scope name
 * @param {function} arg if function then Model.with set scope with name and scope function
 * @param {arguments} arg if arguments and first is not a function then call scope by name with given arguments
 * @example with arrow function : Model.with('active', (model,state) => model.where('active = ?', state)) and for use Model.with('active', 1)
 * @example with usual function : Model.with('active', function(model,state) {return model.where('active = ?', state)}) and for use Model.with('active', 1)
 */
  with(scope, ...arg) {
    if (typeof arg[0] === 'function') {
      internals.withOptions[this.table] = internals.withOptions[this.table] || {}
      internals.withOptions[this.table][scope] = arg[0]
      return this
    }
    const fn = internals.withOptions[this.table] && internals.withOptions[this.table][scope]
    if (fn) {
      arg = arg || []
      arg.unshift(this)
      return fn.apply(this, arg)
    }
    return this
  }
  /**
 * @description get scope from another table
 * @param {string} table table name
 * @param {string} scope scope name
 * @param {arguments} arg if arguments and first is not a function then call scope by name with given arguments
 * @example Item.withOther('protos', 'where:protos:active')
 */

  withOther(table, scope, ...arg) {
    const fn = internals.withOptions[table] && internals.withOptions[table][scope]
    if (fn) {
      arg = arg || []
      arg.unshift(this)
      return fn.apply(this, arg)
    }
    return this
  }

  if(pred, fn) {
    if (pred) {
      return fn(this)
    }
    return this
  }
}

module.exports = Model
