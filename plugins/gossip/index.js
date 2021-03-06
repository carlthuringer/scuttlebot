'use strict'
var pull = require('pull-stream')
var Notify = require('pull-notify')
var mdm = require('mdmanifest')
var valid = require('../../lib/validators')
var apidoc = require('../../lib/apidocs').gossip
var u = require('../../lib/util')
var ref = require('ssb-ref')
var ping = require('pull-ping')
var stats = require('statistics')
var Schedule = require('./schedule')
var Init = require('./init')
var AtomicFile = require('atomic-file')
var fs = require('fs')
var path = require('path')
var deepEqual = require('deep-equal')

function isFunction (f) {
  return 'function' === typeof f
}

function stringify(peer) {
  return [peer.host, peer.port, peer.key].join(':')
}

function isObject (o) {
  return o && 'object' == typeof o
}

function toBase64 (s) {
  if(isString(s)) return s
  else s.toString('base64') //assume a buffer
}

function isString (s) {
  return 'string' == typeof s
}

function coearseAddress (address) {
  if(isObject(address)) {
    var protocol = 'net'
    if (address.host.endsWith(".onion"))
        protocol = 'onion'
    return [protocol, address.host, address.port].join(':') +'~'+['shs', toBase64(address.key)].join(':')
  }
  return address
}

/*
Peers : [{
  key: id,
  host: ip,
  port: int,
  //to be backwards compatible with patchwork...
  announcers: {length: int}
  source: 'pub'|'manual'|'local'
}]
*/


module.exports = {
  name: 'gossip',
  version: '1.0.0',
  manifest: mdm.manifest(apidoc),
  permissions: {
    anonymous: {allow: ['ping']}
  },
  init: function (server, config) {
    var notify = Notify()
    var closed = false, closeScheduler
    var conf = config.gossip || {}

    var gossipJsonPath = path.join(config.path, 'gossip.json')
    var stateFile = AtomicFile(gossipJsonPath)
    stateFile.get(function (err, ary) {
      var peers = ary || []
      server.emit('log:info', ['SBOT', ''+peers.length+' peers loaded from', gossipJsonPath])
    })

    var status = {}

    //Known Peers
    var peers = []

    function getPeer(id) {
      return u.find(peers, function (e) {
        return e && e.key === id
      })
    }

    function simplify (peer) {
      return {
        address: coearseAddress(peer),
        source: peer.source,
        state: peer.state, stateChange: peer.stateChange,
        failure: peer.failure,
        client: peer.client,
        stats: {
          duration: peer.duration || undefined,
          rtt: peer.ping ? peer.ping.rtt : undefined,
          skew: peer.ping ? peer.ping.skew : undefined,
        }
      }
    }

    server.status.hook(function (fn) {
      var _status = fn()
      _status.gossip = status
      peers.forEach(function (peer) {
        if(peer.stateChange + 3e3 > Date.now() || peer.state === 'connected')
          status[peer.key] = simplify(peer)
      })
      return _status

    })

    server.close.hook(function (fn, args) {
      closed = true
      closeScheduler()
      for(var id in server.peers)
        server.peers[id].forEach(function (peer) {
          peer.close(true)
        })
      return fn.apply(this, args)
    })

    var timer_ping = 5*6e4

    function setConfig(name, value) {
      config.gossip = config.gossip || {}
      config.gossip[name] = value

      var cfgPath = path.join(config.path, 'config')
      var existingConfig = {}

      // load ~/.ssb/config
      try { existingConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) }
      catch (e) {}

      // update the plugins config
      existingConfig.gossip = existingConfig.gossip || {}
      existingConfig.gossip[name] = value

      // write to disc
      fs.writeFileSync(cfgPath, JSON.stringify(existingConfig, null, 2), 'utf-8')
    }

    var gossip = {
      wakeup: 0,
      peers: function () {
        return peers
      },
      get: function (addr) {
        addr = ref.parseAddress(addr)
        return u.find(peers, function (a) {
          return (
            addr.port === a.port
            && addr.host === a.host
            && addr.key === a.key
          )
        })
      },
      connect: valid.async(function (addr, cb) {
        server.emit('log:info', ['SBOT', stringify(addr), 'CONNECTING'])
        addr = ref.parseAddress(addr)
        if (!addr || typeof addr != 'object')
          return cb(new Error('first param must be an address'))

        if(!addr.key) return cb(new Error('address must have ed25519 key'))
        // add peer to the table, incase it isn't already.
        gossip.add(addr, 'manual')
        var p = gossip.get(addr)
        if(!p) return cb()

        p.stateChange = Date.now()
        p.state = 'connecting'
        server.connect(coearseAddress(p), function (err, rpc) {
          if (err) {
            p.error = err.stack
            p.state = undefined
            p.failure = (p.failure || 0) + 1
            p.stateChange = Date.now()
            notify({ type: 'connect-failure', peer: p })
            server.emit('log:info', ['SBOT', stringify(p), 'ERR', (err.message || err)])
            p.duration = stats(p.duration, 0)
            return (cb && cb(err))
          }
          else {
            delete p.error
            p.state = 'connected'
            p.failure = 0
          }
          cb && cb(null, rpc)
        })

      }, 'string|object'),

      disconnect: valid.async(function (addr, cb) {
        var peer = this.get(addr)

        peer.state = 'disconnecting'
        peer.stateChange = Date.now()
        if(!peer || !peer.disconnect) cb && cb()
        else peer.disconnect(true, function (err) {
          peer.stateChange = Date.now()
          cb && cb()
        })

      }, 'string|object'),

      changes: function () {
        return notify.listen()
      },
      //add an address to the peer table.
      add: valid.sync(function (addr, source) {

        addr = ref.parseAddress(addr)
        if(!ref.isAddress(addr))
          throw new Error('not a valid address:' + JSON.stringify(addr))
        // check that this is a valid address, and not pointing at self.

        if(addr.key === server.id) return

        var f = gossip.get(addr)

        if(!f) {
          // new peer
          addr.source = source
          addr.announcers = 1
          addr.duration = addr.duration || null
          peers.push(addr)
          notify({ type: 'discover', peer: addr, source: source || 'manual' })
          return addr
        } else if (source === 'friends' || source === 'local') {
          // this peer is a friend or local, override old source to prioritize gossip
          f.source = source
        }
        //don't count local over and over
        else if(f.source != 'local')
          f.announcers ++

        return f
      }, 'string|object', 'string?'),
      remove: function (addr) {
        var peer = gossip.get(addr)
        var index = peers.indexOf(peer)
        if (~index) {
          peers.splice(index, 1)
          notify({ type: 'remove', peer: peer })
        }
      },
      ping: function (opts) {
        var timeout = config.timers && config.timers.ping || 5*60e3
        //between 10 seconds and 30 minutes, default 5 min
        timeout = Math.max(10e3, Math.min(timeout, 30*60e3))
        return ping({timeout: timeout})
      },
      reconnect: function () {
        for(var id in server.peers)
          if(id !== server.id) //don't disconnect local client
            server.peers[id].forEach(function (peer) {
              peer.close(true)
            })
        return gossip.wakeup = Date.now()
      },
      enable: valid.sync(function (type) {
        type = type || 'global'
        setConfig(type, true)
        if(type === 'local' && server.local && server.local.init)
          server.local.init()
        return 'enabled gossip type ' + type
      }, 'string?'),
      disable: valid.sync(function (type) {
        type = type || 'global'
        setConfig(type, false)
        return 'disabled gossip type ' + type
      }, 'string?')
    }

    closeScheduler = Schedule (gossip, config, server)
    Init (gossip, config, server)
    //get current state

    server.on('rpc:connect', function (rpc, isClient) {

      // if we're not ready, close this connection immediately
      if (!server.ready() && rpc.id !== server.id) return rpc.close()

      var peer = getPeer(rpc.id)
      //don't track clients that connect, but arn't considered peers.
      //maybe we should though?
      if(!peer) {
        if(rpc.id !== server.id) {
          server.emit('log:info', ['SBOT', rpc.id, 'Connected'])
          rpc.on('closed', function () {
            server.emit('log:info', ['SBOT', rpc.id, 'Disconnected'])
          })
        }
        return
      }

      status[rpc.id] = simplify(peer)

      server.emit('log:info', ['SBOT', stringify(peer), 'PEER JOINED'])
      //means that we have created this connection, not received it.
      peer.client = !!isClient
      peer.state = 'connected'
      peer.stateChange = Date.now()
      peer.disconnect = function (err, cb) {
        if(isFunction(err)) cb = err, err = null
        rpc.close(err, cb)
      }

      if(isClient) {
        //default ping is 5 minutes...
        var pp = ping({serve: true, timeout: timer_ping}, function (_) {})
        peer.ping = {rtt: pp.rtt, skew: pp.skew}
        pull(
          pp,
          rpc.gossip.ping({timeout: timer_ping}, function (err) {
            if(err.name === 'TypeError') peer.ping.fail = true
          }),
          pp
        )
      }

      rpc.on('closed', function () {
        delete status[rpc.id]
        server.emit('log:info', ['SBOT', stringify(peer),
                         ['DISCONNECTED. state was', peer.state, 'for',
                         (new Date() - peer.stateChange)/1000, 'seconds'].join(' ')])
        //track whether we have successfully connected.
        //or how many failures there have been.
        var since = peer.stateChange
        peer.stateChange = Date.now()
//        if(peer.state === 'connected') //may be "disconnecting"
        peer.duration = stats(peer.duration, peer.stateChange - since)
        peer.state = undefined
        notify({ type: 'disconnect', peer: peer })
      })

      notify({ type: 'connect', peer: peer })
    })

    var last
    stateFile.get(function (err, ary) {
      last = ary || []
      if(Array.isArray(ary))
        ary.forEach(function (v) {
          delete v.state
          // don't add local peers (wait to rediscover)
          if(v.source !== 'local') {
            gossip.add(v, 'stored')
          }
        })
    })

    var int = setInterval(function () {
      var copy = JSON.parse(JSON.stringify(peers))
      copy.filter(function (e) {
        return e.source !== 'local'
      }).forEach(function (e) {
        delete e.state
      })
      if(deepEqual(copy, last)) return
      last = copy
      stateFile.set(copy, function(err) {
        if (err) console.log(err)
      })
    }, 10*1000)

    if(int.unref) int.unref()

    return gossip
  }
}






