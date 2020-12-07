/* eslint-disable require-jsdoc */
// const locals = {}

class Query {
  constructor(delim = '`', query) {
    this.delim = delim
    if (query instanceof Query) {
      this.chain = query.chain
    } else {
      this.chain = new Map()
    }
    this.chain._push = (k, v) => {
      const arr = this.chain.get(k) || []
      if (Array.isArray(arr)) {
        arr.push(v)
        this.chain.set(k, arr)
      }
    }
  }

  wrap(s) {
    if (!s.includes(this.delim)) {
      return `${this.delim}${s}${this.delim}`
    } else {
      return s
    }
  }

  wrapDot(s) {
    if (s.includes(this.delim)) {
      return s
    } else {
      if (s.includes('.')) {
        s = s.split('.')
        return s.map((el, idx) => (s.length - 1) === idx ? el : this.wrap(el)).join('.')
      } else {
        return this.wrap(s)
      }
    }
  }

  _set(k, v) {
    if (typeof k !== 'string' && !v) {
      this.chain.set(...(Object.entries(k)[0]))
    } else {
      this.chain.set(k, v)
    }
  }

  _get(k) {
    return this.chain.get(k)
  }

  isMode(mode) {
    return this._get('mode') === mode
  }

  setMode(mode) {
    this.chain.set('mode', mode)
  }

  reset() {
    this.chain.clear()
  }

  select() {
    this.reset()
    this.setMode('select')
    return this
  }

  from(name, fields) {
    if (this.isMode('insert')) {
      throw new Error('cant run [from] in :insert mode')
    }
    this.chain.set('table', name)
    return this
  }

  table(name) {
    if (this.isMode('select')) {
      throw new Error('cant run [table] in :select mode')
    }
    this.chain.set('table', name)
    return this
  }

  into(name, fields) {
    if (this.isMode('select')) {
      throw new Error('cant run into in :select mode')
    }
    this.chain.set('table', name)
    return this
  }

  field(f) {
    if (!this.isMode('select')) {
      throw new Error('cant run field[s] not in :select mode')
    }
    this.chain._push('fields', f)
    return this
  }

  fields(fields) {
    const f = this.chain.get('fields')
    this.chain.set('fields', f.concat(fields))
    return this
  }

  update() {
    this.reset()
    this.setMode('update')
    return this
  }

  insert() {
    this.reset()
    this.setMode('insert')
    return this
  }

  delete() {
    this.reset()
    this.setMode('delete')
    return this
  }

  limit(limit) {
    this._set({limit})
    return this
  }

  offset(offset) {
    this._set({offset})
    return this
  }

  join(table, alias, where, mode) {
    this.chain._push('join', {table, alias, where, mode})
    return this
  }

  distinct(distinct) {
    this._set({distinct})
    return this
  }

  set(k, v) {
    const fields = this.chain.get('setFields') || {}
    fields[k] = v
    this.chain.set('setFields', fields)
    return this
  }

  setFields(fields) {
    if (this.isMode('select')) {
      throw new Error('cant run setFields in :select mode')
    }
    this._set({setFields: fields})
    return this
  }

  order(field, dir) {
    if (typeof(dir) === 'boolean') {
      dir = dir ? 'ASC' : 'DESC'
    } else {
      if (field.includes(' ')) {
        const [a, b] = field.split(' ')
        field = this.wrapDot(a)
        dir = ['ASC', 'asc'].includes(b) ? 'ASC' : 'DESC'
      } else {
        dir = 'ASC'
      }
    }
    this.chain._push('order', `${this.wrapDot(field)} ${dir}`)
    return this
  }

  group(by) {
    this._set('group', by)
    return this
  }

  having(by) {
    this._set('having', by)
    return this
  }

  where(where, ...vals) {
    this.chain._push('where', [where, vals])
    return this
  }

  _whereJoin() {
    let where = this._get('where')
    let vals = []
    where = where.map(([wh, v]) => {
      if (v.length) {
        vals = vals.concat(v)
      }
      return wh
    }).join(' AND ')
    return [where, vals]
  }

  _convertArray(val) {
    const _convertVal = this._convertVal
    const cnv = (arr) => {
      return '(' + arr.map((el) => {
        if (Array.isArray(el)) {
          return cnv(el)
        } else {
          return _convertVal(el)
        }
      }).join(',') + ')'
    }
    return cnv(val)
  }

  _convertVal(v) {
    const r = this._convertVal1(v)
    console.log('_convertVal', {v, r})
    return r
  }

  _convertVal1(val) {
    if (typeof(val) === 'boolean') {
      return val ? 'TRUE' : 'FALSE'
    }
    if (typeof(val) === 'string') {
      return val.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
    }
    if (val instanceof Date) {
      return val.toUTCString()
    }
    if (val instanceof Buffer) {
      return val.toString('hex')
    }
    if (Array.isArray(val)) {
      return this._convertArray(val)
    }
    if (typeof(val) === 'undefined' || val === null) {
      return 'NULL'
    }
    if (typeof(val) === 'object' && val) {
      return JSON.stringify(val)
    }
    if (typeof(val) === 'number') {
      return val
    }
    console.dir({val})
    throw new Error(`unknown type of value in request!`)
  }

  _doSelect() {
    const me = this
    const r = ['SELECT']
    const fields = this._get('fields')
    if (!fields || !fields.length) {
      fields.push(`${this._get('table')}.*`)
    }
    // console.dir({fields})
    r.push(fields.map((el) => {
      if ([' as ', ' AS '].includes(el) && !el.includes(',')) {
        el = el.split(' as ').length > 1 ? el.split(' as ') : el.split(' AS ')
        return me.wrapDot(el[0]) + ' AS ' + el[1]
      } else {
        return el.includes(',') ? el : me.wrapDot(el)
      }
    }).join(','))
    r.push(`FROM ${this.wrapDot(this._get('table'))}`)
    const join = this._get('join')
    if (join) {
      r.push(join.map(({table, alias, where, mode}) => {
        table = alias ? table + ' AS ' + alias : table
        return `${mode ? mode.toUpperCase() + ' ' : ''}JOIN ${table} ON ${where}`
      }).join(' '))
    }
    if (this._get('where')) {
      const [where, vals] = this._whereJoin()
      this.chain.set('values', vals)
      r.push('WHERE ' + where)
    }
    this._get('group') && r.push('GROUP BY ' + this._get('group').join(', '))
    this._get('having') && r.push('HAVING ' + this._get('having').join(' AND '))
    this._get('order') && r.push('ORDER BY ' + this._get('order').join(', '))
    this._get('limit') && r.push(`LIMIT ${this._get('limit')}`)
    this._get('offset') && r.push(`OFFSET ${this._get('offset')}`)
    return {text: r.join(' '), values: this._get('values')}
  }

  _doUpdate() {
    const me = this
    const table = this.wrap(this._get('table'))
    const vals = []
    const d = Object.entries(this._get('setFields'))
      .map(([k, v]) => {
        vals.push(me._convertVal(v))
        return `${me.wrapDot(k)} = ?`
      }).join(',')
    const r = [`UPDATE ${table} SET`]
    r.push(d)
    return {text: r.join(' '), values: vals}
  }

  _doInsert() {
    const me = this
    const table = this.wrap(this._get('table'))
    const d = Object.entries(this._get('setFields')).reduce((acc, [k, v]) => {
      acc.keys.push(me.wrapDot(k))
      acc.vals.push(me._convertVal(v))
      return acc
    }, {keys: [], vals: []})
    const r = [`INSERT INTO ${table}`]
    r.push(`(${d.keys.join(',')})`)
    r.push(`(${d.vals.map(() => '?').join(',')})`)
    return {text: r.join(' '), values: d.vals}
  }

  // from / where / select / group / having / order / limit
  toParam() {
    const mode = this._get('mode')
    if (mode === 'select') {
      return this._doSelect()
    }
    if (mode === 'update') {
      return this._doUpdate()
    }
    if (mode === 'insert') {
      return this._doInsert()
    }
    return {text: '', values: []}
  }

  toString() {
    const _convertVal = this._convertVal.bind(this)
    let {text, values} = this.toParam()
    if (!text.includes('?')) {
      return text
    }
    let cursor = 0
    text = text.split('?')
    return text.map((el, idx) => (text.length - 1) === idx ? el : el + _convertVal(values[cursor++])).join('')
  }

  clone() {
    return new Query(this.delim, this)
  }
}

module.exports = Query