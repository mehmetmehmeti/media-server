import { Device } from 'mediasoup-client';

const apiBase = `${window.location.protocol}//${window.location.hostname}:3000`;
const streamIdInput = document.querySelector('#streamId');
const tokenInput = document.querySelector('#token');
const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const video = document.querySelector('#video');
const logElement = document.querySelector('#log');

let sessionId;
let recvTransport;
let consumer;
let cleanupSent = false;
let heartbeatTimer;

const initialStreamId = new URLSearchParams(window.location.search).get('streamId');
if (initialStreamId) streamIdInput.value = initialStreamId;

function log(message, value) {
  const line = value === undefined ? message : `${message} ${JSON.stringify(value, null, 2)}`;
  logElement.textContent += `${line}\n`;
  logElement.scrollTop = logElement.scrollHeight;
  console.log(message, value ?? '');
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokenInput.value.trim()}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) return undefined;
  return response.json();
}

async function startViewer() {
  startButton.disabled = true;
  logElement.textContent = '';
  cleanupSent = false;
  stopHeartbeat();

  try {
    const streamId = streamIdInput.value.trim();
    if (!streamId) throw new Error('Stream ID is required');

    const session = await request(`/api/streams/${encodeURIComponent(streamId)}/viewer/session`, {
      method: 'POST',
      body: '{}'
    });
    sessionId = session.sessionId;
    log(`Viewer session for ${streamId}:`, sessionId);
    startHeartbeat();

    const device = new Device();
    await device.load({ routerRtpCapabilities: session.routerRtpCapabilities });
    log('mediasoup-client Device loaded');

    const transportOptions = await request(`/api/viewer/${sessionId}/transport`, {
      method: 'POST',
      body: '{}'
    });

    recvTransport = device.createRecvTransport(transportOptions);

    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await request(`/api/viewer/${sessionId}/transport/${recvTransport.id}/connect`, {
          method: 'POST',
          body: JSON.stringify({ dtlsParameters })
        });
        callback();
      } catch (error) {
        errback(error);
      }
    });

    recvTransport.on('connectionstatechange', (state) => log(`Transport state: ${state}`));

    const consumerOptions = await request(`/api/viewer/${sessionId}/consume`, {
      method: 'POST',
      body: JSON.stringify({
        transportId: recvTransport.id,
        rtpCapabilities: device.rtpCapabilities
      })
    });

    consumer = await recvTransport.consume(consumerOptions);
video.srcObject = new MediaStream([consumer.track]);

await request(`/api/viewer/${sessionId}/consumer/${consumer.id}/resume`, {
  method: 'POST',
  body: '{}'
});

log('Consumer resumed.');

try {
  await video.play();
  log('Live video should now be visible.');
} catch (error) {
  log(`Video play warning: ${error.message}`);
}
    stopButton.disabled = false;
  } catch (error) {
    stopHeartbeat();
    log(`Start failed: ${error.message}`);
    startButton.disabled = false;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!sessionId || cleanupSent) return;
    request(`/api/viewer/${sessionId}/ping`, { method: 'POST', body: '{}' })
      .catch((error) => log(`Viewer heartbeat warning: ${error.message}`));
  }, 5000);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

async function stopViewer() {
  stopButton.disabled = true;
  stopHeartbeat();
  try {
    consumer?.close();
    recvTransport?.close();
    if (sessionId) {
      await request(`/api/viewer/${sessionId}`, { method: 'DELETE' });
      cleanupSent = true;
    }
  } catch (error) {
    log(`Stop warning: ${error.message}`);
  } finally {
    video.srcObject = null;
    sessionId = undefined;
    recvTransport = undefined;
    consumer = undefined;
    startButton.disabled = false;
    log('Viewer stopped');
  }
}

function cleanupViewerSessionBestEffort() {
  if (!sessionId || cleanupSent) return;
  cleanupSent = true;
  stopHeartbeat();

  consumer?.close();
  recvTransport?.close();

  const closeUrl = `${apiBase}/api/viewer/${sessionId}/close`;
  const closeBody = JSON.stringify({ token: tokenInput.value.trim() });
  const closeBlob = new Blob([closeBody], { type: 'application/json' });

  if (!navigator.sendBeacon?.(closeUrl, closeBlob)) {
    fetch(closeUrl, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: closeBody
    }).catch(() => {});
  }
}

startButton.addEventListener('click', startViewer);
stopButton.addEventListener('click', stopViewer);
window.addEventListener('pagehide', cleanupViewerSessionBestEffort);
window.addEventListener('beforeunload', cleanupViewerSessionBestEffort);
// a gpu a cpu instance, TURN duhet me kqyr qysh bahet edhe nese a munja me  zv se o e google, me kqyr nese muja me publish ma shum se me 1 box ne 1 server, dmth 10 boxes me ni instance, secila munet me pas spilit screen, edhe me u handle. 
