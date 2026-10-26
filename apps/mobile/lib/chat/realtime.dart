import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// The bits of a WebSocket the connection needs, so tests can supply an in-memory one.
abstract class RealtimeSocket {
  Stream<dynamic> get stream;
  void add(String data);
  Future<void> close();
}

typedef SocketFactory = Future<RealtimeSocket> Function(Uri uri);

class _ChannelSocket implements RealtimeSocket {
  _ChannelSocket(this._ch);
  final WebSocketChannel _ch;
  @override
  Stream<dynamic> get stream => _ch.stream;
  @override
  void add(String data) => _ch.sink.add(data);
  @override
  Future<void> close() async => _ch.sink.close();
}

Future<RealtimeSocket> connectWebSocket(Uri uri) async {
  final ch = WebSocketChannel.connect(uri);
  await ch.ready;
  return _ChannelSocket(ch);
}

enum ConnectionStatus { connecting, online, offline }

class SendRejected implements Exception {
  SendRejected(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

class _Outgoing {
  _Outgoing(this.conversationId, this.message);
  final String conversationId;
  final Map<String, dynamic> message;
  final completer = Completer<Map<String, dynamic>>();
}

/// One WebSocket to the API, reopened with backoff whenever it drops. Sends sit in an
/// outbox keyed by clientId until acknowledged and are re-sent after each reconnect;
/// the server deduplicates on clientId, so a resend never creates a second message.
class RealtimeConnection extends ChangeNotifier {
  RealtimeConnection({
    required this.wsBase,
    required this.fetchTicket,
    required this.onEvent,
    required this.onReady,
    SocketFactory? connect,
    Random? random,
  })  : _connect = connect ?? connectWebSocket,
        _random = random ?? Random();

  /// e.g. `ws://10.0.2.2:3000`.
  final String wsBase;
  final Future<Map<String, dynamic>> Function() fetchTicket;
  final void Function(String type, Map<String, dynamic> data) onEvent;
  /// Called after every (re)connect so the app can fetch what it missed.
  final void Function() onReady;
  final SocketFactory _connect;
  final Random _random;

  ConnectionStatus status = ConnectionStatus.offline;
  RealtimeSocket? _socket;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry;
  int _attempt = 0;
  bool _stopped = true;
  final _outbox = <String, _Outgoing>{};

  int get pendingCount => _outbox.length;

  void start() {
    if (!_stopped) return;
    _stopped = false;
    unawaited(_open());
  }

  Future<void> stop() async {
    final wasOnline = _teardown();
    if (wasOnline) _setStatus(ConnectionStatus.offline);
  }

  /// Stops everything synchronously; safe to call from dispose().
  bool _teardown() {
    _stopped = true;
    _retry?.cancel();
    unawaited(_sub?.cancel());
    unawaited(_socket?.close());
    _sub = null;
    _socket = null;
    return status != ConnectionStatus.offline;
  }

  /// Reconnect now (e.g. the OS reports connectivity is back).
  void reconnectNow() {
    if (_stopped || status == ConnectionStatus.online) return;
    _retry?.cancel();
    _attempt = 0;
    unawaited(_open());
  }

  Future<void> _open() async {
    if (_stopped) return;
    _setStatus(ConnectionStatus.connecting);
    try {
      final t = await fetchTicket();
      final uri = Uri.parse('$wsBase${t['path']}').replace(queryParameters: {'ticket': t['ticket'] as String});
      final socket = await _connect(uri);
      if (_stopped) {
        await socket.close();
        return;
      }
      _socket = socket;
      _sub = socket.stream.listen(_onFrame, onDone: _onClosed, onError: (_) => _onClosed(), cancelOnError: true);
    } catch (_) {
      _scheduleRetry();
    }
  }

  void _onFrame(dynamic raw) {
    final Map<String, dynamic> f;
    try {
      f = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final type = f['type'] as String?;
    final ref = f['ref'] as String?;
    switch (type) {
      case 'ready':
        _attempt = 0;
        _setStatus(ConnectionStatus.online);
        _outbox.forEach(_transmit);
        onReady();
      case 'ack' when ref != null && _outbox.containsKey(ref):
        _outbox.remove(ref)!.completer.complete(f['data'] as Map<String, dynamic>);
      case 'error' when ref != null && _outbox.containsKey(ref):
        final err = f['error'] as Map<String, dynamic>? ?? const {};
        final code = err['code'] as String? ?? 'error';
        // Worth retrying after the next reconnect; anything else is final.
        if (code == 'rate_limited' || code == 'internal_error') return;
        _outbox.remove(ref)!.completer.completeError(SendRejected(code, err['message'] as String? ?? 'Not sent'));
      case 'pong' || 'ack' || 'error' || null:
        break;
      default:
        onEvent(type, (f['data'] as Map?)?.cast<String, dynamic>() ?? const {});
    }
  }

  void _onClosed() {
    _socket = null;
    _sub = null;
    if (_stopped) return;
    _setStatus(ConnectionStatus.offline);
    _scheduleRetry();
  }

  void _scheduleRetry() {
    if (_stopped) return;
    _setStatus(ConnectionStatus.offline);
    final base = min(15000, 500 * pow(2, _attempt).toInt());
    _attempt += 1;
    _retry = Timer(Duration(milliseconds: (base * (0.75 + _random.nextDouble() / 2)).round()), () => unawaited(_open()));
  }

  void _transmit(String clientId, _Outgoing o) {
    if (status != ConnectionStatus.online) return;
    _socket?.add(jsonEncode({'type': 'send', 'ref': clientId, 'conversationId': o.conversationId, 'message': o.message}));
  }

  /// Resolves with `{message, duplicate}` once the server has stored the message.
  Future<Map<String, dynamic>> send(String conversationId, Map<String, dynamic> message) {
    final clientId = message['clientId'] as String;
    final o = _outbox[clientId] ?? _Outgoing(conversationId, message);
    _outbox[clientId] = o;
    _transmit(clientId, o);
    return o.completer.future;
  }

  /// Fire-and-forget frames (typing, receipts). Dropped while offline; receipts are re-sent on screen.
  void frame(Map<String, dynamic> f) {
    if (status == ConnectionStatus.online) _socket?.add(jsonEncode(f));
  }

  void _setStatus(ConnectionStatus s) {
    if (status == s) return;
    status = s;
    notifyListeners();
  }

  @override
  void dispose() {
    _teardown();
    super.dispose();
  }
}

/// `http(s)://host` → `ws(s)://host`.
String wsBaseFor(String httpBase) => httpBase.replaceFirst(RegExp(r'^http'), 'ws');

String newClientId([Random? r]) {
  final rnd = r ?? Random.secure();
  return List.generate(16, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}
