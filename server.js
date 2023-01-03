import { readFile, truncate } from "fs"
import { WebSocketServer } from "ws"
import { createServer } from "http"
import https from "https";

const OFFER = 'offer'
const ANSWER = 'answer'
const CANDIDATE='candidate'
const PEER = 'peer'
const BYE = 'bye'
const NEW = 'new'
const NEXT = 'next'
const REPORT = 'report'

class CallHandler {
  constructor() {
    this.wss = null
    this.ws = null;
    this.clients = new Set();
    this.server = null;
    this.ssl_server = null;
  }

  init() {
    const ws_server_port = process.env.PORT || 4442;
    this.server = createServer().listen(ws_server_port, () => {
      console.log("start WS Server: bind => ws://0.0.0.0:" + ws_server_port);
    });
    this.ws = new WebSocketServer({ server: this.server });
    this.ws.on("connection", this.onConnection);

    //     console.log(
    //       "Start WSS Server: bind => wss://0.0.0.0:" + wss_server_port
    //     );

    createServer(function (req, res) {
      if (req.url == "/out") {
        readFile("nohup.out", "utf-8", (err, data) => {
          if (err) {
            next(err); // Pass errors to Express.
          } else {
            res.writeHead(200, { "Content-Type": "text/plain" });
            console.log("len=>" + data.length);
            if (data.length > 71056646) {
              truncate("nohup.out", 0, () => {});
              res.write("file contents deleted");
            } else {
              const arr = data.trim().split(/(?<=\n)/g);
              res.write(arr.slice(arr.length - 140).toString());
            }
            res.end();
          }
        });
      } else if (req.url == "/id") {
        readFile("id.txt", "utf-8", (err, data) => {
          res.write(data);
          res.end();
        });
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end();
      }
    }).listen(8080, "0.0.0.0");
  }

  _getFreePeer = (client_self) => {
    console.log("get free peer from " + this.clients.size);
    for (const client of this.clients) {
      if(client_self.id === client.id) continue;
      console.log(`id=${client.id}, busy=${client.busy}`);
      if (client.busy === false && !client_self.blockedPeers.has(client.id) && !client.blockedPeers.has(client_self.id)) {
        client.busy = true;
        return { type: PEER, id:client.id, name: client.name}
      }
    }
    return null;
  };


  onConnection = (client_self) => {
    this.clients.add(client_self);
    client_self.on("close", (code) => {
      console.log("close code=>" + code);
      if (client_self.peerId != undefined) {
        let client = this._getById(client_self.peerId);
        console.log("got by id=>" + client.id);
        client.peerId = undefined;
        client.send(JSON.stringify({ type: "bye" }));
        client.blockedPeers.add(client_self.id);
      }
        const removed = this.clients.delete(client_self);
        console.log('on close id:' + client_self.id+'; removed:'+removed);
    });

    client_self.on("message", (message) => {
      let msg;
      let client;
      let peer;
      try {
        message = JSON.parse(message);
        if (message.type == "new") {
          let code = message.code;
          if (code == undefined || code < 64) {
            msg = { type: "update" };
            client_self.send(JSON.stringify(msg));
            console.log(`version: ${v} from: ${message.id}. Must update`);
            return;
          }
          console.log(JSON.stringify(message));
        } else if (
          message.type == OFFER ||
          message.type == ANSWER ||
          message.type == BYE ||
          message.type==REPORT
        ) {
          console.log(
            message.type + " from " + client_self.id + " to: " + message.to
          );
        }
      } catch (e) {
        console.log(e.message);
      }

      switch (message.type) {
        case REPORT:
          this._findAndSend({ type: REPORT }, message.to);
          break;
        case NEXT: this._getPeerAndSend(client_self)
        break;
        case NEW:
          client_self.id = "" + message.id
          client_self.busy = true
          client_self.name = message.name
          client_self.blockedPeers = new Set(message.blockedPeers)
          this._getPeerAndSend(client_self)
          break;
        case BYE:
          client = this._getById(message.to)
          client_self.peerId = undefined
          client.peerId = undefined
          client.blockedPeers.add(client_self.id)
          client.send(JSON.stringify({ type: BYE }))
          this._addToBlockedAndFindNewPeer(client_self, client.id)
          break;
        case OFFER:
          client = this._getById(message.to);
          if (client != null) {
            message.from = client_self.id
            message.to=undefined  
            client.send(JSON.stringify(message));
            client_self.busy = true;
            client.busy = true;
          } else client_self.busy = false;
          break;
        case ANSWER:
          client = this._getById(message.to)
          if (client != null) {
            message.to=undefined
            message.from=client_self.id
            client.send(JSON.stringify(message))
            client_self.peerId = client.id
            client.peerId = client_self.id
          } else client_self.busy = false
          break
        case CANDIDATE:
          client = this._getById(message.to)
          message.to=undefined
          message.from=client_self.id
          client.send(JSON.stringify(message))
          break;
        case "keepalive":
          client_self.send(JSON.stringify({ type: "keepalive" }));
          break;
        default:
          console.log("Unhandled message: " + message.type);
      }
    });
  };

  _addToBlockedAndFindNewPeer(client, id) {
    client.blockedPeers.add(id);
    const peer = this._getFreePeer(client);
    if (peer == null) client.busy = false;
    else client.send(JSON.stringify(peer));
  }

  _getById(id) {
    for (let c of this.clients) if (c.id === id) return c;
    return null;
  }

  _getPeerAndSend(client_self){
    const peer = this._getFreePeer(client_self);
          if (peer == null) {
            client_self.busy = false;
            client_self.peerId = undefined;
            return;
          }
          client_self.send(JSON.stringify(peer));
  }

  _findAndSend(msg, to) {
    for (let client of this.clients) {
      if (client.id === to) {
        try {
          client.send(JSON.stringify(msg));
        } catch (e) {
          console.log("failed to find and send:" + e.message);
          return false;
        }
        return true;
      }
    }
    return false;
  }
}

let callHandler = new CallHandler();
callHandler.init();
