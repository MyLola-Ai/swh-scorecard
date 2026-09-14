# weekly revenue snapshot FAILED — 2026-09-14
Generated 2026-09-14T15:12:34Z

```
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

[TypeError: fetch failed] {
  [cause]: SocketError: other side closed
      at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7700:26)
      at TLSSocket.emit (node:events:520:35)
      at endReadableNT (node:internal/streams/readable:1729:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'UND_ERR_SOCKET',
    socket: {
      localAddress: '192.168.4.21',
      localPort: 50972,
      remoteAddress: '172.253.63.95',
      remotePort: 443,
      remoteFamily: 'IPv4',
      timeout: undefined,
      bytesWritten: 524,
      bytesRead: 0
    }
  }
}

Node.js v24.14.1
```
