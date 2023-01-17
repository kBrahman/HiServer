import { readFile, truncate } from "fs";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import https from "https";
import { time } from "console";

const OFFER = "offer";
const ANSWER = "answer";
const CANDIDATE = "candidate";
const PEER = "peer";
const BYE = "bye";
const NEW = "new";
const NEXT = "next";
const REPORT = "report";
const KEEPALIVE = "keepalive";
const OFFER_TIMEOUT = "offer_timeout";

class CallHandler {
  constructor() {
    this.wss = null;
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

    createServer(function (req, res) {
      if (req.url == "/out") {
        readFile("nohup.out", "utf-8", (err, data) => {
          if (err) {
            console.log("err outing");
          } else {
            res.writeHead(200, { "Content-Type": "text/plain" });
            if (data.length > 71056647) {
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

  _expired = (time) => Date.now() - time > 120001;

  _getFreePeer = (client_self) => {
    console.log("get free peer from " + this.clients.size);
    let expiredClient;
    for (const client of this.clients) {
      if (client_self.id === client.id) continue;
      if (expiredClient === undefined && this._expired(client.time))
        expiredClient = client;
      console.log(`id=${client.id}, busy=${client.busy}`);
      if (
        client.busy === false &&
        !client_self.blockedPeers.has(client.id) &&
        !client.blockedPeers.has(client_self.id)
      ) {
        client.busy = true;
        return { type: PEER, id: client.id, name: client.name };
      }
    }
    if (expiredClient !== undefined) {
      this.clients.delete(expiredClient);
      console.log("removed expired client:" + expiredClient.id);
    }
    return null;
  };

  onConnection = (client_self) => {
    client_self.on("close", (code) => {
      console.log("close code=>" + code);
      if (client_self.peerId != undefined) {
        const client = this._getById(client_self.peerId);
        if (client == null) return;
        console.log("got by id=>" + client.id);
        client.peerId = undefined;
        client.send(JSON.stringify({ type: "bye" }));
        client.blockedPeers.add(client_self.id);
      }
      const removed = this.clients.delete(client_self);
      console.log("on close id:" + client_self.id + "; removed:" + removed);
    });

    client_self.on("message", (message) => {
      let msg;
      let client;
      let peer;
      try {
        message = JSON.parse(message);
        if (message.type == "new") {
          let code = message.code;
          if (code == undefined || code < 69) {
            msg = { type: "update" };
            client_self.send(JSON.stringify(msg));
            console.log(
              `version: ${message.v} from: ${message.id}. Must update`
            );
            return;
          }
          console.log(JSON.stringify(message));
        } else if (
          message.type == OFFER ||
          message.type == ANSWER ||
          message.type == BYE ||
          message.type == REPORT
        ) {
          console.log(
            message.type + " from " + client_self.id + " to: " + message.to
          );
        }
      } catch (e) {
        console.log(e.message);
      }
      client_self.time = Date.now();
      switch (message.type) {
        case REPORT:
          this._findAndSend({ type: REPORT }, message.to);
          break;
        case NEXT:
          this._getPeerAndSend(client_self);
          break;
        case NEW:
          this._checkDeadClient(this.clients, message.id);
          client_self.id = "" + message.id;
          client_self.busy = true;
          client_self.name = message.name;
          client_self.blockedPeers = new Set(message.blockedPeers);
          this._getPeerAndSend(client_self);
          this.clients.add(client_self);
          client_self.send(JSON.stringify({ type: KEEPALIVE }));
          break;
        case BYE:
          this._addToBlockedAndFindNewPeer(client_self, message.to);
          client_self.peerId = undefined;
          client = this._getById(message.to);
          if (client == null) return;
          client.peerId = undefined;
          client.blockedPeers.add(client_self.id);
          client.send(JSON.stringify({ type: BYE }));
          break;
        case OFFER:
          client = this._getById(message.to);
          if (client != null) {
            message.from = client_self.id;
            message.to = undefined;
            client.send(JSON.stringify(message));
            client_self.busy = true;
            client.busy = true;
          } else client_self.busy = false;
          break;
        case ANSWER:
          client = this._getById(message.to);
          if (client != null) {
            message.to = undefined;
            message.from = client_self.id;
            client.send(JSON.stringify(message));
            client_self.peerId = client.id;
            client.peerId = client_self.id;
          } else client_self.busy = false;
          break;
        case CANDIDATE:
          client = this._getById(message.to);
          if (client == null) return;
          message.to = undefined;
          message.from = client_self.id;
          client.send(JSON.stringify(message));
          break;
        case KEEPALIVE:
          client_self.send(JSON.stringify({ type: KEEPALIVE }));
          break;
        case OFFER_TIMEOUT:
          client = this._getById(message.to);
          if (client != null) this.clients.delete(client);
          this._getPeerAndSend(client_self);
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

  _getPeerAndSend(client_self) {
    const peer = this._getFreePeer(client_self);
    if (peer == null) {
      client_self.busy = false;
      client_self.peerId = undefined;
    } else client_self.send(JSON.stringify(peer));
  }

  _checkDeadClient(clients, id) {
    const client = this._getById(id);
    if (client != null) {
      clients.delete(client);
      console.log("removed dead client:" + id);
    }
  }

  _findAndSend(msg, to) {
    const client = this._getById(to);
    if (client != null) client.send(JSON.stringify(msg));
  }
}

let callHandler = new CallHandler();
callHandler.init();
