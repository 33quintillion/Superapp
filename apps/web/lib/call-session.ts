// Browser side of one-to-one calls: microphone and camera, the RTCPeerConnection, and
// the signalling frames that set it up. The API only relays signalling; audio and video
// go straight between the two browsers, or through the TURN relay the API hands out.
import { Call, CallMedia, ChatApiError, chatApi, RealtimeClient } from './chat-client';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';
export type CallQuality = 'good' | 'poor' | 'bad';

export interface CallView {
  phase: CallPhase;
  call: Call | null;
  media: CallMedia;
  peerName: string;
  muted: boolean;
  cameraOff: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** From the connection's own statistics: round-trip time and packet loss. */
  quality: CallQuality | null;
  /** How media is flowing: straight between the two devices, or through the TURN relay. */
  route: 'direct' | 'relay' | null;
  /** When media connected on this device (for the timer). */
  connectedAt: number | null;
  /** Something the person should know (permission blocked, call failed). */
  notice: string | null;
}

interface IceConfig {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  relay: boolean;
}

type SignalFrame = { kind: 'offer' | 'answer'; sdp: string } | { kind: 'candidate'; candidate: RTCIceCandidateInit | null };

const IDLE: CallView = {
  phase: 'idle',
  call: null,
  media: 'audio',
  peerName: '',
  muted: false,
  cameraOff: false,
  localStream: null,
  remoteStream: null,
  quality: null,
  route: null,
  connectedAt: null,
  notice: null,
};

/** How long media may stay broken (ICE restarts included) before the call is given up. */
const RECOVERY_MS = 20_000;
/** Video bitrate caps by measured quality; audio is left alone, it matters most. */
const VIDEO_BITRATE: Record<CallQuality, number> = { good: 1_500_000, poor: 400_000, bad: 150_000 };

/** Turns getUserMedia failures into something a person can act on. */
export function describeMediaError(err: unknown, media: CallMedia): string {
  const name = (err as { name?: string })?.name;
  const what = media === 'video' ? 'camera and microphone' : 'microphone';
  if (name === 'NotAllowedError' || name === 'SecurityError') return `Allow access to your ${what} in the browser to make calls.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what} found on this device.`;
  if (name === 'NotReadableError' || name === 'AbortError') return `Your ${what} is being used by another app.`;
  return `Couldn’t start your ${what}.`;
}

/** One sentence for how a call ended, from this person's side. */
export function endedText(c: Call, me: string, peerName: string): string {
  const caller = c.callerId === me;
  switch (c.endReason) {
    case 'completed':
      return `Call ended · ${formatDuration(c.durationSeconds)}`;
    case 'declined':
      return caller ? `${peerName} declined the call` : 'Call declined';
    case 'missed':
      return caller ? 'No answer' : 'Missed call';
    case 'busy':
      return caller ? `${peerName} is on another call` : 'Missed call';
    case 'cancelled':
      return caller ? 'Call cancelled' : 'Missed call';
    case 'failed':
      return 'Call failed: the connection couldn’t be set up';
    case 'connection_lost':
      return 'Call ended: the connection was lost';
    default:
      return 'Call ended';
  }
}

export function formatDuration(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Holds at most one call. The caller always makes the offers (including ICE restarts), so
 * the two sides can never both offer at once.
 */
export class CallManager {
  private view: CallView = IDLE;
  private pc: RTCPeerConnection | null = null;
  private pcReady: Promise<RTCPeerConnection> | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private signals: Promise<void> = Promise.resolve();
  private reportedConnected = false;
  private brokenSince: number | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastInbound = { lost: 0, received: 0 };
  private ring: { stop: () => void } | null = null;
  private lastPeerConn: string | null = null;

  constructor(
    private readonly rt: RealtimeClient,
    private readonly me: string,
    private readonly nameFor: (c: { conversationId: string; peerId: string }) => string,
    private readonly onChange: (v: CallView) => void,
  ) {}

  get state() {
    return this.view;
  }

  private set(patch: Partial<CallView>) {
    this.view = { ...this.view, ...patch };
    this.onChange(this.view);
  }

  private get busy() {
    return this.view.phase !== 'idle' && this.view.phase !== 'ended';
  }

  private isCaller() {
    return this.view.call?.callerId === this.me;
  }

  // ---------------------------------------------------------------- actions

  async start(conversationId: string, peerId: string, media: CallMedia) {
    if (this.busy) return;
    this.reset();
    this.set({ ...IDLE, phase: 'outgoing', media, peerName: this.nameFor({ conversationId, peerId }) });
    let stream: MediaStream;
    try {
      stream = await this.getMedia(media);
    } catch (err) {
      return this.finish(describeMediaError(err, media));
    }
    this.set({ localStream: stream });
    let call: Call;
    try {
      call = await this.rt.request<Call>({ type: 'call.start', conversationId, media });
    } catch (err) {
      return this.finish(err instanceof ChatApiError ? err.message : 'Couldn’t start the call');
    }
    this.set({ call });
    if (call.state === 'ended') return this.ended(call);
    this.ring = ringback();
    // Start gathering early; the offer goes out once the callee answers.
    void this.ensurePc();
  }

  async accept() {
    const call = this.view.call;
    if (!call || this.view.phase !== 'incoming') return;
    this.stopRing();
    this.set({ phase: 'connecting', notice: null });
    let stream: MediaStream;
    try {
      stream = await this.getMedia(call.media);
    } catch (err) {
      // Keep ringing so they can allow access and try again, or decline.
      this.ring = ringtone();
      return this.set({ phase: 'incoming', notice: describeMediaError(err, call.media) });
    }
    this.set({ localStream: stream });
    await this.ensurePc();
    try {
      this.set({ call: await this.rt.request<Call>({ type: 'call.accept', callId: call.id }) });
    } catch (err) {
      this.finish(err instanceof ChatApiError && err.code === 'call_not_ringing' ? 'The call has already ended' : 'Couldn’t answer the call');
    }
  }

  async decline() {
    const call = this.view.call;
    if (!call) return;
    this.stopRing();
    await this.rt.request({ type: 'call.decline', callId: call.id }).catch(() => chatApi('POST', `calls/${call.id}/decline`).catch(() => undefined));
  }

  async hangup(failed = false) {
    const call = this.view.call;
    if (!call || !this.busy) return this.finish(null);
    const ended = await this.rt
      .request<Call>({ type: 'call.hangup', callId: call.id, failed })
      .catch(() => chatApi<Call>('POST', `calls/${call.id}/hangup`, { failed }).catch(() => null));
    if (ended) this.ended(ended);
    else this.finish(null);
  }

  toggleMute() {
    const muted = !this.view.muted;
    this.view.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
  }

  toggleCamera() {
    const cameraOff = !this.view.cameraOff;
    this.view.localStream?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    this.set({ cameraOff });
  }

  dismiss() {
    if (this.view.phase === 'ended') this.set(IDLE);
  }

  dispose() {
    void this.hangup();
    this.reset();
  }

  // ---------------------------------------------------------------- events

  onEvent(f: { type: string; data?: any }) {
    if (f.type === 'call.updated') this.onCallUpdated(f.data as Call);
    else if (f.type === 'call.signal' && f.data?.callId === this.view.call?.id) {
      const s = f.data.signal as SignalFrame;
      this.signals = this.signals.then(() => this.onSignal(s)).catch((err) => console.warn('call signal failed', err));
    }
  }

  /** After every (re)connect of the realtime socket. */
  async onReady() {
    const call = this.view.call;
    if (call && this.busy && this.view.phase !== 'incoming') {
      // This browser's socket changed: take our place in the call again.
      try {
        const resumed = await this.rt.request<Call>({ type: 'call.resume', callId: call.id });
        this.onCallUpdated(resumed);
        if (this.isCaller() && resumed.state !== 'ringing') await this.restartIce();
      } catch (err) {
        if (err instanceof ChatApiError && err.code === 'call_ended') {
          const c = await chatApi<Call>('GET', `calls/${call.id}`).catch(() => null);
          if (c) this.ended(c);
          else this.finish(null);
        }
      }
      return;
    }
    // Opened (or came back) while being rung: show it.
    const { call: live } = await chatApi<{ call: Call | null }>('GET', 'calls/active').catch(() => ({ call: null }));
    if (live) this.onCallUpdated(live);
  }

  private onCallUpdated(c: Call) {
    const current = this.view.call;
    if (!current || current.id !== c.id) {
      if (this.busy || c.state !== 'ringing' || c.calleeId !== this.me) return;
      this.reset();
      this.set({ ...IDLE, phase: 'incoming', call: c, media: c.media, peerName: this.nameFor({ conversationId: c.conversationId, peerId: c.callerId }) });
      this.ring = ringtone();
      return;
    }
    if (c.state === 'ended') return this.ended(c);
    const caller = c.callerId === this.me;
    if (!caller && c.state !== 'ringing' && c.calleeConnectionId !== this.rt.connectionId && this.view.phase === 'incoming') {
      // Answered on another of my devices.
      this.stopRing();
      this.reset();
      return this.set(IDLE);
    }
    const peerConn = caller ? c.calleeConnectionId : c.callerConnectionId;
    const peerMoved = this.lastPeerConn !== null && peerConn !== this.lastPeerConn;
    this.lastPeerConn = peerConn;
    this.set({ call: c });
    if (caller && c.state === 'accepted' && this.view.phase === 'outgoing') {
      this.stopRing();
      this.set({ phase: 'connecting' });
      void this.negotiate(false);
    } else if (caller && peerMoved && c.state !== 'ringing') {
      // The other side reconnected on a new socket: rebuild the media path.
      void this.restartIce();
    }
    const peerReconnecting = caller ? c.calleeReconnecting : c.callerReconnecting;
    if (peerReconnecting && this.view.phase === 'active') this.set({ phase: 'reconnecting' });
    else if (!peerReconnecting && this.view.phase === 'reconnecting' && this.pc?.connectionState === 'connected') this.set({ phase: 'active' });
  }

  private async onSignal(s: SignalFrame) {
    const pc = await this.ensurePc();
    if (s.kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
      await this.flushCandidates(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.signal({ kind: 'answer', sdp: pc.localDescription!.sdp });
    } else if (s.kind === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
      await this.flushCandidates(pc);
    } else if (s.kind === 'candidate' && s.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(s.candidate).catch(() => undefined);
      else this.pendingCandidates.push(s.candidate);
    }
  }

  // ---------------------------------------------------------------- WebRTC

  private async getMedia(media: CallMedia) {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
    });
  }

  private ensurePc(): Promise<RTCPeerConnection> {
    if (!this.pcReady) {
      this.pcReady = (async () => {
        const ice = await chatApi<IceConfig>('GET', 'calls/ice-servers').catch(() => ({ iceServers: [], iceTransportPolicy: 'all' as const, relay: false }));
        const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy });
        this.pc = pc;
        for (const t of this.view.localStream?.getTracks() ?? []) pc.addTrack(t, this.view.localStream!);
        // Receive video even on a side that sends none (camera off, audio-only device).
        if (this.view.media === 'video' && !this.view.localStream?.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
        const remote = new MediaStream();
        pc.ontrack = (e) => {
          remote.addTrack(e.track);
          this.set({ remoteStream: remote });
        };
        pc.onicecandidate = (e) => void this.signal({ kind: 'candidate', candidate: e.candidate ? e.candidate.toJSON() : null }).catch(() => undefined);
        pc.onconnectionstatechange = () => this.onConnectionState(pc);
        return pc;
      })();
    }
    return this.pcReady;
  }

  private async negotiate(iceRestart: boolean) {
    const pc = await this.ensurePc();
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    await this.signal({ kind: 'offer', sdp: pc.localDescription!.sdp });
  }

  private async restartIce() {
    if (!this.pc || !this.isCaller() || this.pc.signalingState === 'closed') return;
    try {
      // A half-finished exchange from before the drop is abandoned first.
      if (this.pc.signalingState === 'have-local-offer') await this.pc.setLocalDescription({ type: 'rollback' });
      await this.negotiate(true);
    } catch (err) {
      console.warn('ICE restart failed', err);
    }
  }

  private async flushCandidates(pc: RTCPeerConnection) {
    const list = this.pendingCandidates.splice(0);
    for (const c of list) await pc.addIceCandidate(c).catch(() => undefined);
  }

  private async signal(signal: SignalFrame) {
    const call = this.view.call;
    if (!call) return;
    // Candidates are fire-and-forget; offers and answers wait for the server's ack.
    if (signal.kind === 'candidate') return this.rt.frame({ type: 'call.signal', callId: call.id, signal });
    await this.rt.request({ type: 'call.signal', callId: call.id, signal });
  }

  private onConnectionState(pc: RTCPeerConnection) {
    if (pc !== this.pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      this.brokenSince = null;
      this.set({ phase: 'active', connectedAt: this.view.connectedAt ?? Date.now(), notice: null });
      if (!this.reportedConnected && this.view.call) {
        this.reportedConnected = true;
        void this.rt.request({ type: 'call.connected', callId: this.view.call.id }).catch(() => undefined);
      }
      this.startStats();
    } else if (s === 'disconnected' || s === 'failed') {
      if (this.view.phase === 'active') this.set({ phase: 'reconnecting' });
      this.brokenSince ??= Date.now();
      // "disconnected" often heals by itself; "failed" needs a new ICE round.
      if (s === 'failed') void this.restartIce();
      else this.later(3000, () => pc.connectionState === 'disconnected' && void this.restartIce());
      this.later(RECOVERY_MS, () => {
        if (this.pc === pc && this.brokenSince && Date.now() - this.brokenSince >= RECOVERY_MS && pc.connectionState !== 'connected') void this.hangup(true);
      });
    }
  }

  /** Watches round-trip time and loss, shows a quality hint, and eases video bitrate on bad networks. */
  private startStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(async () => {
      const pc = this.pc;
      if (!pc || pc.connectionState !== 'connected') return;
      const stats = await pc.getStats();
      let rtt: number | null = null;
      let lost = 0;
      let received = 0;
      let route: CallView['route'] = null;
      const byId = new Map<string, any>();
      stats.forEach((r: any) => byId.set(r.id, r));
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          if (typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime;
          const local = byId.get(r.localCandidateId);
          const remote = byId.get(r.remoteCandidateId);
          route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
        }
        if (r.type === 'inbound-rtp') {
          lost += r.packetsLost ?? 0;
          received += r.packetsReceived ?? 0;
        }
      });
      const dl = lost - this.lastInbound.lost;
      const dr = received - this.lastInbound.received;
      this.lastInbound = { lost, received };
      const loss = dl + dr > 0 ? dl / (dl + dr) : 0;
      const quality: CallQuality = loss > 0.15 || (rtt ?? 0) > 0.8 ? 'bad' : loss > 0.05 || (rtt ?? 0) > 0.4 ? 'poor' : 'good';
      if (quality !== this.view.quality) await this.capVideo(pc, quality);
      if (quality !== this.view.quality || route !== this.view.route) this.set({ quality, route });
    }, 2000);
  }

  private async capVideo(pc: RTCPeerConnection, q: CallQuality) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings?.length) continue;
      p.encodings[0]!.maxBitrate = VIDEO_BITRATE[q];
      await sender.setParameters(p).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- ending

  private ended(c: Call) {
    const peer = this.view.peerName || 'They';
    this.teardown();
    this.set({ phase: 'ended', call: c, notice: endedText(c, this.me, peer), localStream: null, remoteStream: null, quality: null });
    this.later(5000, () => this.dismiss());
  }

  private finish(notice: string | null) {
    this.teardown();
    this.set(notice ? { ...IDLE, phase: 'ended', notice, media: this.view.media, peerName: this.view.peerName } : IDLE);
    if (notice) this.later(6000, () => this.dismiss());
  }

  private teardown() {
    this.stopRing();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.pc?.close();
    this.pc = null;
    this.pcReady = null;
    this.pendingCandidates = [];
    this.view.localStream?.getTracks().forEach((t) => t.stop());
  }

  private reset() {
    this.teardown();
    this.reportedConnected = false;
    this.brokenSince = null;
    this.lastPeerConn = null;
    this.lastInbound = { lost: 0, received: 0 };
    this.signals = Promise.resolve();
  }

  private stopRing() {
    this.ring?.stop();
    this.ring = null;
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }
}

// ---------------------------------------------------------------- tones

/** Ring tones made with Web Audio, so no sound files ship. Browsers may refuse until the page was clicked. */
function tone(pattern: { freq: number[]; on: number; off: number }) {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  try {
    ctx = new AudioContext();
    const beep = () => {
      if (!ctx || ctx.state === 'closed') return;
      const gain = ctx.createGain();
      gain.gain.value = 0.06;
      gain.connect(ctx.destination);
      for (const f of pattern.freq) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(gain);
        o.start();
        o.stop(ctx.currentTime + pattern.on / 1000);
      }
    };
    beep();
    timer = setInterval(beep, pattern.on + pattern.off);
  } catch {
    // No audio: the screen still shows the call.
  }
  return {
    stop() {
      if (timer) clearInterval(timer);
      void ctx?.close().catch(() => undefined);
    },
  };
}

const ringtone = () => tone({ freq: [440, 480], on: 1200, off: 1800 });
const ringback = () => tone({ freq: [425], on: 1000, off: 3000 });
