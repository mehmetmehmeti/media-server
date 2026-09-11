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

## WHIP Publisher Client

Ubuntu's packaged `/usr/bin/whip-client` links `libsoup-2.4`, while the local
GStreamer WebRTC/NICE stack links `libsoup-3.0`. Loading both in one process
crashes at startup, so build the upstream libsoup3 client locally:

```bash
./scripts/build-whip-client.sh
```

Use the generated binary:

```bash
.tools/bin/whip-client -u http://127.0.0.1:3010/whip/demo \
  -t local-publisher-token \
  -n \
  -V 'filesrc location=/path/to/video.mp4 ! qtdemux ! h264parse config-interval=1 ! rtph264pay pt=96 ssrc=2 config-interval=1 aggregate-mode=zero-latency ! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000'
```
