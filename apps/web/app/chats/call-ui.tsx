'use client';

import { useEffect, useRef, useState } from 'react';
import type { CallManager, CallView } from '@/lib/call-session';
import { formatDuration } from '@/lib/call-session';
import { CallHistoryItem, CallMedia, chatApi, SystemEvent } from '@/lib/chat-client';

/** One line for a call notice in the chat, from the viewer's side. */
export function describeCall(e: Extract<SystemEvent, { type: 'call' }>, callerId: string, me: string) {
  const kind = e.media === 'video' ? 'video call' : 'voice call';
  const Kind = e.media === 'video' ? 'Video call' : 'Voice call';
  const mine = callerId === me;
  switch (e.outcome) {
    case 'completed':
      return `${mine ? '↗' : '↙'} ${Kind} · ${formatDuration(e.durationSeconds)}`;
    case 'declined':
      return mine ? `${Kind} declined` : `You declined a ${kind}`;
    case 'failed':
      return `${Kind} failed to connect`;
    case 'connection_lost':
      return `${Kind} · ${formatDuration(e.durationSeconds)} (connection lost)`;
    case 'busy':
    case 'missed':
    case 'cancelled':
      return mine ? `${Kind} · ${e.outcome === 'busy' ? 'busy' : e.outcome === 'missed' ? 'no answer' : 'cancelled'}` : `Missed ${kind}`;
  }
}

function Video({ stream, muted, testId, className }: { stream: MediaStream | null; muted?: boolean; testId: string; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} data-testid={testId} autoPlay playsInline muted={muted} />;
}

/** Plays the other person's audio in voice calls (video calls play it through the video element). */
function Audio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay data-testid="remote-audio" />;
}

/** Incoming, outgoing and in-call screens. Renders nothing while there is no call. */
export function CallScreen({ view, calls }: { view: CallView; calls: CallManager }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.connectedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.connectedAt]);

  if (view.phase === 'idle') return null;
  const kind = view.media === 'video' ? 'video call' : 'voice call';

  if (view.phase === 'ended') {
    return (
      <div className="call-toast" role="status" data-testid="call-ended" onClick={() => calls.dismiss()}>
        {view.notice ?? 'Call ended'}
      </div>
    );
  }

  if (view.phase === 'incoming') {
    return (
      <div className="call-overlay" role="dialog" aria-label={`Incoming ${kind}`} data-testid="incoming-call">
        <div className="call-card">
          <div className="call-avatar" aria-hidden>
            {view.peerName.slice(0, 1).toUpperCase()}
          </div>
          <strong>{view.peerName}</strong>
          <span className="muted">Incoming {kind}…</span>
          {view.notice && (
            <p className="error small" role="alert" data-testid="call-notice">
              {view.notice}
            </p>
          )}
          <div className="call-controls">
            <button className="btn call-decline" data-testid="decline-call" onClick={() => void calls.decline()}>
              Decline
            </button>
            <button className="btn call-accept" data-testid="accept-call" onClick={() => void calls.accept()}>
              Accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  const status =
    view.phase === 'outgoing'
      ? 'Ringing…'
      : view.phase === 'connecting'
        ? 'Connecting…'
        : view.phase === 'reconnecting'
          ? 'Reconnecting…'
          : view.connectedAt
            ? formatDuration(Math.max(0, Math.floor((now - view.connectedAt) / 1000)))
            : '';
  const video = view.media === 'video';
  return (
    <div className={`call-overlay in-call ${video ? 'video' : 'audio'}`} role="dialog" aria-label={`${kind} with ${view.peerName}`} data-testid="in-call" data-phase={view.phase}>
      {video ? (
        <>
          <Video stream={view.remoteStream} testId="remote-video" className="remote-video" />
          {view.localStream && !view.cameraOff && <Video stream={view.localStream} muted testId="local-video" className="local-video" />}
        </>
      ) : (
        <>
          <div className="call-avatar big" aria-hidden>
            {view.peerName.slice(0, 1).toUpperCase()}
          </div>
          <Audio stream={view.remoteStream} />
        </>
      )}
      <div className="call-info">
        <strong>{view.peerName}</strong>
        <span data-testid="call-status">{status}</span>
        {view.quality && view.quality !== 'good' && view.phase === 'active' && (
          <span className="call-quality" data-testid="call-quality">
            {view.quality === 'bad' ? 'Very poor connection' : 'Poor connection'}
          </span>
        )}
        {view.route && (
          <span className="muted small" data-testid="call-route" data-route={view.route}>
            {view.route === 'relay' ? 'Relayed' : 'Direct'}
          </span>
        )}
      </div>
      <div className="call-controls">
        <button className={`btn round ${view.muted ? 'on' : ''}`} aria-pressed={view.muted} data-testid="mute" onClick={() => calls.toggleMute()}>
          {view.muted ? 'Unmute' : 'Mute'}
        </button>
        {video && (
          <button className={`btn round ${view.cameraOff ? 'on' : ''}`} aria-pressed={view.cameraOff} data-testid="camera" onClick={() => calls.toggleCamera()}>
            {view.cameraOff ? 'Camera on' : 'Camera off'}
          </button>
        )}
        <button className="btn round call-decline" data-testid="hangup" onClick={() => void calls.hangup()}>
          {view.phase === 'outgoing' ? 'Cancel' : 'End'}
        </button>
      </div>
    </div>
  );
}

/** Recent calls, with a button to call back. */
export function CallHistory({ onCall, refreshKey }: { onCall: (peerId: string, media: CallMedia) => void; refreshKey: number }) {
  const [calls, setCalls] = useState<CallHistoryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    chatApi<{ calls: CallHistoryItem[] }>('GET', 'calls?limit=30')
      .then((r) => setCalls(r.calls))
      .catch((e) => setErr(e.message));
  }, [refreshKey]);
  if (err) return <p className="error small">{err}</p>;
  if (!calls) return <p className="muted small calls-empty">Loading…</p>;
  if (!calls.length) return <p className="muted small calls-empty">No calls yet.</p>;
  return (
    <ul className="conv-items" data-testid="call-history">
      {calls.map((c) => {
        const missed = c.direction === 'incoming' && !c.answeredAt;
        return (
          <li key={c.id} className="call-row" data-testid="call-row" data-outcome={c.endReason ?? c.state}>
            <span className={missed ? 'missed' : ''}>
              {c.direction === 'outgoing' ? '↗' : '↙'} {c.peer.displayName}
            </span>
            <span className="muted small">
              {c.media === 'video' ? 'Video' : 'Voice'} · {missed ? 'Missed' : c.endReason === 'completed' ? formatDuration(c.durationSeconds) : (c.endReason ?? c.state).replace('_', ' ')} ·{' '}
              {new Date(c.createdAt).toLocaleString()}
            </span>
            {c.peer.username && (
              <button className="btn quiet small" aria-label={`Call ${c.peer.displayName} back`} onClick={() => onCall(c.peer.id, c.media)}>
                Call back
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
