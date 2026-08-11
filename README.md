# Local mediasoup WHIP PoC

A deliberately small LAN proof of concept:

GStreamer WHIP publisher -> mediasoup WebRtcTransport/Producer -> browser mediasoup-client Consumer.

This is not production-ready. It uses HTTP, fixed tokens, one H.264 publisher, no database, no TURN, and only acknowledges candidate-only WHIP PATCH requests. ICE restart is not implemented.

## Run

```bash
cp .env.example .env
set -a; source .env; set +a
npm install
npm run dev
```

Open `http://localhost:5173`, start the GStreamer publisher, and click Start viewer.
