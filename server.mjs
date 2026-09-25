import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import * as mediasoup from 'mediasoup';
import * as sdpTransform from 'sdp-transform';

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);
const LISTEN_IP = process.env.LISTEN_IP ?? '0.0.0.0';
const ANNOUNCED_ADDRESS = process.env.ANNOUNCED_ADDRESS;
const MEDIA_PORT = Number(process.env.MEDIA_PORT ?? 40000);
const PUBLISHER_TOKEN = process.env.PUBLISHER_TOKEN ?? 'local-publisher-token';
const VIEWER_TOKEN = process.env.VIEWER_TOKEN ?? 'local-viewer-token';
const VIEWER_SESSION_TIMEOUT_MS = Number(process.env.VIEWER_SESSION_TIMEOUT_MS ?? 15000);
const VIEWER_SWEEP_INTERVAL_MS = Number(process.env.VIEWER_SWEEP_INTERVAL_MS ?? 5000);

if (!ANNOUNCED_ADDRESS) {
  console.error('ANNOUNCED_ADDRESS is required. Example: ANNOUNCED_ADDRESS=192.168.1.50 npm run server');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));

const worker = await mediasoup.createWorker({
  logLevel: 'warn',
  logTags: ['ice', 'dtls', 'rtp', 'rtcp', 'srtp']
});

worker.on('died', (error) => {
  console.error('mediasoup Worker died', error);
  process.exit(1);
});

const webRtcServer = await worker.createWebRtcServer({
  listenInfos: [
    {
      protocol: 'udp',
      ip: LISTEN_IP,
      announcedAddress: ANNOUNCED_ADDRESS,
      port: MEDIA_PORT
    },
    {
      protocol: 'tcp',
      ip: LISTEN_IP,
      announcedAddress: ANNOUNCED_ADDRESS,
      port: MEDIA_PORT
    }
  ]
});

const router = await worker.createRouter({
  mediaCodecs: [
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1
      },
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '640028',
        'level-asymmetry-allowed': 1
      },
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    }
  ]
});

console.log(`mediasoup Worker PID: ${worker.pid}`);
console.log(`HTTP/WHIP API: http://${ANNOUNCED_ADDRESS}:${HTTP_PORT}`);
console.log(`WebRTC media: ${ANNOUNCED_ADDRESS}:${MEDIA_PORT} UDP/TCP`);

const whipSessions = new Map();
const rtpSessions = new Map();
const viewerSessions = new Map();
const streams = new Map();

function now() {
  return Date.now();
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function requirePublisher(req, res, next) {
  if (bearerToken(req) !== PUBLISHER_TOKEN) {
    return res.status(401).json({ error: 'invalid publisher token' });
  }
  next();
}

function requireViewer(req, res, next) {
  if (bearerToken(req) !== VIEWER_TOKEN) {
    return res.status(401).json({ error: 'invalid viewer token' });
  }
  next();
}

function authorizeViewerClose(req, res, next) {
  if (bearerToken(req) !== VIEWER_TOKEN && req.body?.token !== VIEWER_TOKEN) {
    return res.status(401).json({ error: 'invalid viewer token' });
  }
  next();
}

function parseFmtp(config = '') {
  const numericParameters = new Set(['apt', 'packetization-mode']);
  const parameters = {};
  for (const piece of config.split(';')) {
    const [rawKey, ...rest] = piece.trim().split('=');
    if (!rawKey) continue;
    const rawValue = rest.join('=').trim();
    if (!rawValue) {
      parameters[rawKey] = '';
      continue;
    }
    const numeric = Number(rawValue);
    parameters[rawKey] = numericParameters.has(rawKey) && Number.isFinite(numeric) && String(numeric) === rawValue
      ? numeric
      : rawValue;
  }
  return parameters;
}

function getMediaDirection(media) {
  if (media.direction) return media.direction;
  if (media.sendonly) return 'sendonly';
  if (media.sendrecv) return 'sendrecv';
  if (media.recvonly) return 'recvonly';
  if (media.inactive) return 'inactive';
  return 'sendrecv';
}

function selectVideoOffer(parsedOffer) {
  const media = parsedOffer.media.find((entry) => entry.type === 'video');
  if (!media) throw new Error('SDP offer has no video m-line');

  const direction = getMediaDirection(media);
  if (!['sendonly', 'sendrecv'].includes(direction)) {
    throw new Error(`publisher video direction must be sendonly/sendrecv, got ${direction}`);
  }

  const selectedRtp = (media.rtp ?? []).find(
    (entry) => ['VP8', 'H264'].includes(String(entry.codec).toUpperCase())
  );
  if (!selectedRtp) throw new Error('SDP offer does not contain VP8 or H.264');

  const selectedPt = Number(selectedRtp.payload);
  const selectedCodec = String(selectedRtp.codec).toUpperCase();
  const selectedMimeType = `video/${selectedCodec}`;
  const selectedFmtp = (media.fmtp ?? []).find((entry) => Number(entry.payload) === selectedPt);
  const selectedParameters = parseFmtp(selectedFmtp?.config ?? '');

  if (selectedCodec === 'H264' && Number(selectedParameters['packetization-mode'] ?? 0) !== 1) {
    throw new Error('H.264 packetization-mode=1 is required for this PoC');
  }

  const feedback = (media.rtcpFb ?? [])
    .filter((entry) => Number(entry.payload) === selectedPt || entry.payload === '*')
    .map((entry) => ({
      type: entry.type,
      ...(entry.subtype ? { parameter: entry.subtype } : {})
    }));

  const codecs = [
    {
      mimeType: selectedMimeType,
      payloadType: selectedPt,
      clockRate: Number(selectedRtp.rate ?? 90000),
      parameters: selectedParameters,
      rtcpFeedback: feedback
    }
  ];

  const rtxRtp = (media.rtp ?? []).find((entry) => {
    if (String(entry.codec).toLowerCase() !== 'rtx') return false;
    const fmtp = (media.fmtp ?? []).find((item) => Number(item.payload) === Number(entry.payload));
    return Number(parseFmtp(fmtp?.config ?? '').apt) === selectedPt;
  });

  if (rtxRtp) {
    codecs.push({
      mimeType: 'video/rtx',
      payloadType: Number(rtxRtp.payload),
      clockRate: Number(rtxRtp.rate ?? 90000),
      parameters: { apt: selectedPt },
      rtcpFeedback: []
    });
  }

  const supportedExtensionUris = new Set(
    router.rtpCapabilities.headerExtensions
      .filter((ext) => ext.kind === 'video')
      .map((ext) => ext.uri)
  );

  const headerExtensions = (media.ext ?? [])
    .filter((ext) => supportedExtensionUris.has(ext.uri))
    .map((ext) => ({
      uri: ext.uri,
      id: Number(ext.value),
      encrypt: false,
      parameters: {}
    }));

  const fidGroup = (media.ssrcGroups ?? []).find((group) => group.semantics === 'FID');
  const fidSsrcs = fidGroup
    ? String(fidGroup.ssrcs).split(/\s+/).map(Number).filter(Number.isFinite)
    : [];

  const offeredSsrcs = [...new Set((media.ssrcs ?? []).map((entry) => Number(entry.id)))];
  const primarySsrc = fidSsrcs[0] ?? offeredSsrcs[0];
  const rtxSsrc = fidSsrcs[1];

  if (!primarySsrc) {
    throw new Error('No video SSRC found. This PoC supports one SSRC-based H.264 encoding.');
  }

  const cname = (media.ssrcs ?? []).find(
    (entry) => Number(entry.id) === primarySsrc && entry.attribute === 'cname'
  )?.value ?? `whip-${primarySsrc}`;

  const encodings = [
    {
      ssrc: primarySsrc,
      ...(rtxSsrc ? { rtx: { ssrc: rtxSsrc } } : {})
    }
  ];

  return {
    media,
    primaryPt: selectedPt,
    primaryCodec: selectedCodec,
    primaryFmtp: selectedFmtp?.config ?? '',
    codecs,
    headerExtensions,
    encodings,
    rtcp: { cname, reducedSize: true, mux: true }
  };
}

function candidateToSdp(candidate) {
  const protocol = String(candidate.protocol).toLowerCase();
  let line = `a=candidate:${candidate.foundation} 1 ${protocol} ${candidate.priority} ${candidate.ip} ${candidate.port} typ ${candidate.type}`;
  if (protocol === 'tcp' && candidate.tcpType) line += ` tcptype ${candidate.tcpType}`;
  return line;
}

function buildWhipAnswer({ offer, selected, transport }) {
  const media = selected.media;
  const mid = String(media.mid ?? '0');
  const fingerprint = transport.dtlsParameters.fingerprints[0];
  const payloads = selected.codecs.map((codec) => codec.payloadType).join(' ');
  const lines = [
    'v=0',
    `o=- ${Date.now()} 1 IN IP4 0.0.0.0`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=ice-lite',
    `m=video 9 UDP/TLS/RTP/SAVPF ${payloads}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${transport.iceParameters.usernameFragment}`,
    `a=ice-pwd:${transport.iceParameters.password}`,
    `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`,
    'a=setup:passive',
    `a=mid:${mid}`,
    'a=recvonly',
    'a=rtcp-mux',
    'a=rtcp-rsize'
  ];

  for (const candidate of transport.iceCandidates) lines.push(candidateToSdp(candidate));
  lines.push('a=end-of-candidates');

  for (const codec of selected.codecs) {
    const codecName = codec.mimeType.split('/')[1];
    lines.push(`a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}`);

    if (codec.mimeType.toLowerCase() !== 'video/rtx' && selected.primaryFmtp) {
      lines.push(`a=fmtp:${codec.payloadType} ${selected.primaryFmtp}`);
    } else if (codec.mimeType.toLowerCase() === 'video/rtx') {
      lines.push(`a=fmtp:${codec.payloadType} apt=${selected.primaryPt}`);
    }

    for (const fb of codec.rtcpFeedback ?? []) {
      lines.push(`a=rtcp-fb:${codec.payloadType} ${fb.type}${fb.parameter ? ` ${fb.parameter}` : ''}`);
    }
  }

  for (const ext of selected.headerExtensions) {
    lines.push(`a=extmap:${ext.id} ${ext.uri}`);
  }

  return `${lines.join('\r\n')}\r\n`;
}

function closeViewerSession(sessionId, reason = 'closed') {
  const session = viewerSessions.get(sessionId);
  if (!session) return;
  console.log(`Closing viewer session ${sessionId}: ${reason}`);
  viewerSessions.delete(sessionId);
  const stream = streams.get(session.streamId);
  stream?.viewers.delete(sessionId);
  for (const consumer of session.consumers.values()) consumer.close();
  for (const transport of session.transports.values()) transport.close();
}

function touchViewerSession(sessionId) {
  const session = viewerSessions.get(sessionId);
  if (session) session.lastSeenAt = now();
  return session;
}

function describeTransport(transport) {
  return {
    id: transport.id,
    iceState: transport.iceState,
    iceSelectedTuple: transport.iceSelectedTuple,
    dtlsState: transport.dtlsState,
    closed: transport.closed
  };
}

function describeConsumer(consumer) {
  return {
    id: consumer.id,
    producerId: consumer.producerId,
    paused: consumer.paused,
    closed: consumer.closed
  };
}

function closeWhipSession(sessionId, reason = 'closed') {
  const session = whipSessions.get(sessionId);
  if (!session) return;
  console.log(`Closing WHIP session ${sessionId} (${session.streamId}): ${reason}`);
  const stream = streams.get(session.streamId);
  if (stream?.whipSessionId === sessionId) {
    for (const viewerId of [...stream.viewers.keys()]) closeViewerSession(viewerId, 'publisher closed');
    streams.delete(session.streamId);
  }
  session.producer?.close();
  session.transport?.close();
  whipSessions.delete(sessionId);
}

function closeRtpSession(sessionId, reason = 'closed') {
  const session = rtpSessions.get(sessionId);
  if (!session) return;
  console.log(`Closing RTP session ${sessionId} (${session.streamId}): ${reason}`);
  const stream = streams.get(session.streamId);
  if (stream?.rtpSessionId === sessionId) {
    for (const viewerId of [...stream.viewers.keys()]) closeViewerSession(viewerId, 'publisher closed');
    streams.delete(session.streamId);
  }
  session.producer?.close();
  session.transport?.close();
  rtpSessions.delete(sessionId);
}

function h264ProducerParameters({ payloadType = 96, ssrc = 2222, profileLevelId = '42e01f' } = {}) {
  return {
    codecs: [
      {
        mimeType: 'video/H264',
        payloadType,
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': profileLevelId,
          'level-asymmetry-allowed': 1
        },
        rtcpFeedback: []
      }
    ],
    encodings: [{ ssrc }],
    rtcp: {
      cname: `rtp-${ssrc}`,
      reducedSize: true,
      mux: true
    }
  };
}

app.options('/whip/:streamId', (req, res) => {
  res.set({
    'Accept-Post': 'application/sdp',
    'Accept-Patch': 'application/trickle-ice-sdpfrag',
    'Access-Control-Allow-Methods': 'OPTIONS, POST, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match'
  });
  res.sendStatus(204);
});

app.post(
  '/whip/:streamId',
  requirePublisher,
  express.text({ type: 'application/sdp', limit: '1mb' }),
  async (req, res) => {
    let transport;
    let producer;
    try {
      if (!req.body || typeof req.body !== 'string') {
        return res.status(400).json({ error: 'application/sdp body required' });
      }
      const streamId = req.params.streamId;
      const existingStream = streams.get(streamId);
      if (existingStream?.producer && !existingStream.producer.closed) {
        return res.status(409).json({ error: `stream ${streamId} already has an active publisher` });
      }

      const offer = sdpTransform.parse(req.body);
      const selected = selectVideoOffer(offer);
      const fingerprint = selected.media.fingerprint ?? offer.fingerprint;
      if (!fingerprint) throw new Error('SDP offer has no DTLS fingerprint');

      const sessionId = crypto.randomUUID();

      transport = await router.createWebRtcTransport({
        webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { role: 'publisher', streamId }
      });

      transport.on('icestatechange', (state) => {
        console.log(`publisher ICE: ${state}`);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          closeWhipSession(sessionId, `publisher ICE ${state}`);
        }
      });
      transport.on('dtlsstatechange', (state) => {
        console.log(`publisher DTLS: ${state}`);
        if (state === 'failed' || state === 'closed') {
          closeWhipSession(sessionId, `publisher DTLS ${state}`);
        }
      });

      await transport.connect({
        dtlsParameters: {
          role: 'client',
          fingerprints: [
            {
              algorithm: fingerprint.type,
              value: fingerprint.hash
            }
          ]
        }
      });

      producer = await transport.produce({
        kind: 'video',
        rtpParameters: {
          mid: String(selected.media.mid ?? '0'),
          codecs: selected.codecs,
          headerExtensions: selected.headerExtensions,
          encodings: selected.encodings,
          rtcp: selected.rtcp
        },
        appData: { streamId, source: 'whip' }
      });

      producer.on('score', (score) => console.log('publisher score', score));
      producer.on('transportclose', () => console.log('publisher transport closed'));

      const etag = `"${crypto.randomBytes(16).toString('hex')}"`;
      const answer = buildWhipAnswer({ offer, selected, transport });

      whipSessions.set(sessionId, {
        streamId,
        transport,
        producer,
        etag
      });
      streams.set(streamId, {
        streamId,
        whipSessionId: sessionId,
        transport,
        producer,
        viewers: new Map(),
        createdAt: now()
      });

      console.log(`WHIP publisher created: stream=${streamId}, producer=${producer.id}, transport=${transport.id}`);

      res.status(201)
        .set({
          'Content-Type': 'application/sdp',
          Location: `/whip/session/${sessionId}`,
          ETag: etag
        })
        .send(answer);
    } catch (error) {
      producer?.close();
      transport?.close();
      console.error('WHIP POST failed', error);
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
);

app.patch(
  '/whip/session/:sessionId',
  requirePublisher,
  express.text({ type: 'application/trickle-ice-sdpfrag', limit: '256kb' }),
  (req, res) => {
    const session = whipSessions.get(req.params.sessionId);
    if (!session) return res.sendStatus(404);
    if (req.headers['if-match'] && req.headers['if-match'] !== session.etag) {
      return res.sendStatus(412);
    }
    // mediasoup is ICE Lite and learns the remote tuple from connectivity checks.
    // Candidate-only PATCHes can be acknowledged for this LAN PoC.
    // ICE restart is intentionally not implemented here.
    return res.sendStatus(204);
  }
);

app.delete('/whip/session/:sessionId', requirePublisher, (req, res) => {
  if (!whipSessions.has(req.params.sessionId)) return res.sendStatus(404);
  closeWhipSession(req.params.sessionId, 'WHIP DELETE');
  res.sendStatus(200);
});

app.post('/rtp/:streamId', requirePublisher, async (req, res) => {
  let transport;
  let producer;
  try {
    const streamId = req.params.streamId;
    const existingStream = streams.get(streamId);
    if (existingStream?.producer && !existingStream.producer.closed) {
      return res.status(409).json({ error: `stream ${streamId} already has an active publisher` });
    }

    const payloadType = Number(req.body?.payloadType ?? 96);
    const ssrc = Number(req.body?.ssrc ?? 2222);
    const profileLevelId = String(req.body?.profileLevelId ?? '42e01f');
    if (!Number.isInteger(payloadType) || payloadType < 96 || payloadType > 127) {
      return res.status(400).json({ error: 'payloadType must be a dynamic RTP payload type from 96 to 127' });
    }
    if (!Number.isInteger(ssrc) || ssrc <= 0) {
      return res.status(400).json({ error: 'ssrc must be a positive integer' });
    }

    const sessionId = crypto.randomUUID();
    transport = await router.createPlainTransport({
      listenInfo: {
        protocol: 'udp',
        ip: LISTEN_IP,
        announcedAddress: ANNOUNCED_ADDRESS
      },
      rtcpMux: true,
      comedia: true,
      appData: { role: 'rtp-publisher', streamId }
    });

    producer = await transport.produce({
      kind: 'video',
      rtpParameters: h264ProducerParameters({ payloadType, ssrc, profileLevelId }),
      appData: { streamId, source: 'rtp' }
    });

    producer.on('transportclose', () => console.log('RTP publisher transport closed'));
    producer.on('score', (score) => console.log('RTP publisher score', score));

    rtpSessions.set(sessionId, {
      streamId,
      transport,
      producer,
      payloadType,
      ssrc,
      createdAt: now()
    });
    streams.set(streamId, {
      streamId,
      rtpSessionId: sessionId,
      transport,
      producer,
      viewers: new Map(),
      createdAt: now()
    });

    console.log(`RTP publisher ready: stream=${streamId}, session=${sessionId}, rtpPort=${transport.tuple.localPort}, producer=${producer.id}`);

    res.status(201).json({
      sessionId,
      streamId,
      ip: ANNOUNCED_ADDRESS,
      port: transport.tuple.localPort,
      payloadType,
      ssrc
    });
  } catch (error) {
    producer?.close();
    transport?.close();
    console.error('RTP publisher setup failed', error);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/rtp/session/:sessionId', requirePublisher, (req, res) => {
  if (!rtpSessions.has(req.params.sessionId)) return res.sendStatus(404);
  closeRtpSession(req.params.sessionId, 'RTP DELETE');
  res.sendStatus(200);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    workerPid: worker.pid,
    streams: [...streams.values()].map((stream) => ({
      streamId: stream.streamId,
      producerId: stream.producer?.id ?? null,
      source: stream.whipSessionId ? 'whip' : stream.rtpSessionId ? 'rtp' : 'unknown',
      viewers: stream.viewers.size
    })),
    whipSessions: whipSessions.size,
    rtpSessions: rtpSessions.size,
    viewers: viewerSessions.size
  });
});

app.get('/api/debug/viewers', requireViewer, (req, res) => {
  const timestamp = now();
  res.json({
    streams: [...streams.values()].map((stream) => ({
      streamId: stream.streamId,
      producerId: stream.producer?.id ?? null,
      producerClosed: stream.producer?.closed ?? null,
      producerPaused: stream.producer?.paused ?? null,
      viewers: stream.viewers.size
    })),
    viewers: [...viewerSessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      streamId: session.streamId,
      ageMs: timestamp - session.createdAt,
      idleMs: timestamp - session.lastSeenAt,
      transports: [...session.transports.values()].map(describeTransport),
      consumers: [...session.consumers.values()].map(describeConsumer)
    }))
  });
});

app.get('/api/debug/stats', requireViewer, async (req, res) => {
  const timestamp = now();
  const publishers = [];
  const viewers = [];

  for (const [sessionId, session] of whipSessions.entries()) {
    publishers.push({
      sessionId,
      source: 'whip',
      streamId: session.streamId,
      etag: session.etag,
      transport: session.transport
        ? {
            ...describeTransport(session.transport),
            stats: await session.transport.getStats()
          }
        : null,
      producer: session.producer
        ? {
            id: session.producer.id,
            closed: session.producer.closed,
            paused: session.producer.paused,
            stats: await session.producer.getStats()
          }
        : null
    });
  }

  for (const [sessionId, session] of rtpSessions.entries()) {
    publishers.push({
      sessionId,
      source: 'rtp',
      streamId: session.streamId,
      payloadType: session.payloadType,
      ssrc: session.ssrc,
      transport: session.transport
        ? {
            ...describeTransport(session.transport),
            stats: await session.transport.getStats()
          }
        : null,
      producer: session.producer
        ? {
            id: session.producer.id,
            closed: session.producer.closed,
            paused: session.producer.paused,
            stats: await session.producer.getStats()
          }
        : null
    });
  }

  for (const [sessionId, session] of viewerSessions.entries()) {
    const transports = [];
    const consumers = [];

    for (const transport of session.transports.values()) {
      transports.push({
        ...describeTransport(transport),
        stats: await transport.getStats()
      });
    }

    for (const consumer of session.consumers.values()) {
      consumers.push({
        ...describeConsumer(consumer),
        stats: await consumer.getStats()
      });
    }

    viewers.push({
      sessionId,
      ageMs: timestamp - session.createdAt,
      idleMs: timestamp - session.lastSeenAt,
      transports,
      consumers
    });
  }

  res.json({
    timestamp,
    publishers,
    streams: [...streams.values()].map((stream) => ({
      streamId: stream.streamId,
      whipSessionId: stream.whipSessionId,
      rtpSessionId: stream.rtpSessionId,
      producerId: stream.producer?.id ?? null,
      viewers: stream.viewers.size
    })),
    viewers
  });
});

app.post(['/api/viewer/session', '/api/streams/:streamId/viewer/session'], requireViewer, (req, res) => {
  const streamId = req.params.streamId ?? req.body?.streamId ?? req.query.streamId;
  if (!streamId) return res.status(400).json({ error: 'streamId is required' });
  const stream = streams.get(streamId);
  if (!stream?.producer || stream.producer.closed) {
    return res.status(404).json({ error: `stream ${streamId} is not live` });
  }

  const sessionId = crypto.randomUUID();
  const timestamp = now();
  const viewerSession = {
    streamId,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    transports: new Map(),
    consumers: new Map()
  };
  viewerSessions.set(sessionId, viewerSession);
  stream.viewers.set(sessionId, viewerSession);
  res.json({ sessionId, routerRtpCapabilities: router.rtpCapabilities });
});

app.post('/api/viewer/:sessionId/transport', requireViewer, async (req, res) => {
  try {
    const session = touchViewerSession(req.params.sessionId);
    if (!session) return res.sendStatus(404);

    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      appData: { role: 'viewer', sessionId: req.params.sessionId }
    });

    session.transports.set(transport.id, transport);
    transport.on('icestatechange', (state) => {
      console.log(`viewer ${req.params.sessionId} ICE: ${state}`);
      if (state === 'failed' || state === 'closed') {
        closeViewerSession(req.params.sessionId, `ICE ${state}`);
      } else if (state === 'disconnected') {
        setTimeout(() => {
          const currentSession = viewerSessions.get(req.params.sessionId);
          const currentTransport = currentSession?.transports.get(transport.id);
          if (currentTransport && currentTransport.iceState === 'disconnected') {
            closeViewerSession(req.params.sessionId, 'ICE disconnected timeout');
          }
        }, 5000).unref?.();
      }
    });
    transport.on('dtlsstatechange', (state) => {
      console.log(`viewer ${req.params.sessionId} DTLS: ${state}`);
      if (state === 'failed' || state === 'closed') {
        closeViewerSession(req.params.sessionId, `DTLS ${state}`);
      }
    });

    res.json({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/viewer/:sessionId/transport/:transportId/connect', requireViewer, async (req, res) => {
  try {
    const session = touchViewerSession(req.params.sessionId);
    const transport = session?.transports.get(req.params.transportId);
    if (!transport) return res.sendStatus(404);
    await transport.connect({ dtlsParameters: req.body.dtlsParameters });
    res.sendStatus(204);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/viewer/:sessionId/consume', requireViewer, async (req, res) => {
  try {
    const session = touchViewerSession(req.params.sessionId);
    const stream = session ? streams.get(session.streamId) : undefined;
    if (!stream?.producer || stream.producer.closed) {
      return res.status(409).json({ error: `stream ${session?.streamId ?? 'unknown'} is not live` });
    }

    const transport = session?.transports.get(req.body.transportId);
    if (!session || !transport) return res.sendStatus(404);

    if (!router.canConsume({ producerId: stream.producer.id, rtpCapabilities: req.body.rtpCapabilities })) {
      return res.status(400).json({ error: 'viewer cannot consume the producer codec' });
    }

    const consumer = await transport.consume({
      producerId: stream.producer.id,
      rtpCapabilities: req.body.rtpCapabilities,
      paused: true,
      appData: { viewerSessionId: req.params.sessionId }
    });

    session.consumers.set(consumer.id, consumer);
    consumer.on('producerclose', () => closeViewerSession(req.params.sessionId, 'producer closed'));
    consumer.on('transportclose', () => session.consumers.delete(consumer.id));

    res.json({
      id: consumer.id,
      producerId: stream.producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/viewer/:sessionId/consumer/:consumerId/resume', requireViewer, async (req, res) => {
  try {
    const session = touchViewerSession(req.params.sessionId);
    const consumer = session?.consumers.get(req.params.consumerId);
    if (!consumer) return res.sendStatus(404);
    await consumer.resume();
    res.sendStatus(204);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/viewer/:sessionId/ping', requireViewer, (req, res) => {
  if (!touchViewerSession(req.params.sessionId)) return res.sendStatus(404);
  res.sendStatus(204);
});

app.post('/api/viewer/:sessionId/close', authorizeViewerClose, (req, res) => {
  closeViewerSession(req.params.sessionId, 'viewer close beacon');
  res.sendStatus(204);
});

app.delete('/api/viewer/:sessionId', requireViewer, (req, res) => {
  closeViewerSession(req.params.sessionId, 'viewer DELETE');
  res.sendStatus(204);
});

const viewerSessionSweeper = setInterval(() => {
  const timestamp = now();
  for (const [sessionId, session] of viewerSessions.entries()) {
    if (timestamp - session.lastSeenAt > VIEWER_SESSION_TIMEOUT_MS) {
      closeViewerSession(sessionId, 'viewer heartbeat timeout');
    }
  }
}, VIEWER_SWEEP_INTERVAL_MS);
viewerSessionSweeper.unref?.();

const httpServer = app.listen(HTTP_PORT, LISTEN_IP, () => {
  console.log(`Viewer API listening on 0.0.0.0:${HTTP_PORT}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  clearInterval(viewerSessionSweeper);
  httpServer.close();
  for (const sessionId of [...viewerSessions.keys()]) closeViewerSession(sessionId, signal);
  for (const sessionId of [...whipSessions.keys()]) closeWhipSession(sessionId, signal);
  for (const sessionId of [...rtpSessions.keys()]) closeRtpSession(sessionId, signal);
  webRtcServer.close();
  router.close();
  worker.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
