import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:nexa/media/media.dart';

/// The smallest files that pass the server's signature check.
final jpeg = Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, ...List.filled(60, 1)]);
final png = Uint8List.fromList([0x89, ...'PNG\r\n\x1a\n'.codeUnits, ...List.filled(40, 2)]);
final m4a = Uint8List.fromList([0, 0, 0, 0x18, ...'ftypM4A '.codeUnits, ...List.filled(80, 3)]);

/// The photo library and microphone, with what the person picks set up by the test.
class FakeDevices implements MediaDevices {
  final photos = <List<LocalMedia>>[];
  bool micAllowed = true;
  FakeRecording? recording;

  @override
  Future<List<LocalMedia>> pickPhotos({int limit = 1}) async => photos.isEmpty ? [] : photos.removeAt(0).take(limit).toList();

  @override
  Future<VoiceRecording?> startVoice() async => micAllowed ? recording = FakeRecording() : null;
}

class FakeRecording implements VoiceRecording {
  bool cancelled = false;
  @override
  Future<LocalMedia?> stop() async => LocalMedia(bytes: m4a, fileName: 'voice-note.m4a', contentType: 'audio/mp4', durationMs: 4200);
  @override
  Future<void> cancel() async => cancelled = true;
}

/// Media endpoints and the storage bucket, as the API and S3 behave: create, PUT exactly the
/// declared bytes to the presigned URL, then complete.
class FakeMedia {
  final created = <String, Map<String, dynamic>>{};
  final stored = <String, Uint8List>{};
  int _n = 0;

  /// Answers media and storage requests; null for anything else.
  http.Response? handle(http.Request req) {
    final path = req.url.path;
    if (req.url.host == 'storage.test' && req.method == 'PUT') {
      final id = path.split('/').last;
      if (req.headers['content-type'] != created[id]?['contentType']) return http.Response('bad content type', 403);
      stored[id] = req.bodyBytes;
      return http.Response('', 200);
    }
    if (req.method == 'POST' && path == '/v1/media/uploads') {
      final b = jsonDecode(req.body) as Map<String, dynamic>;
      final id = 'md${_n += 1}';
      created[id] = {'id': id, 'kind': b['kind'], 'contentType': b['contentType'], 'byteSize': b['byteSize'], 'fileName': b['fileName'] ?? '', 'durationMs': b['durationMs'], 'state': 'pending'};
      return _json(201, {
        'media': created[id],
        'upload': {'method': 'PUT', 'url': 'http://storage.test/bucket/$id', 'headers': {'content-type': b['contentType']}, 'expiresIn': 900},
      });
    }
    final complete = RegExp(r'^/v1/media/(md\d+)/complete$').firstMatch(path);
    if (req.method == 'POST' && complete != null) {
      final id = complete.group(1)!;
      if (stored[id] == null) return _json(409, {'error': {'code': 'upload_missing', 'message': 'Nothing was uploaded'}});
      if (stored[id]!.length != created[id]!['byteSize']) return _json(400, {'error': {'code': 'media_rejected', 'message': 'The file didn’t match'}});
      return _json(200, created[id]!..['state'] = 'ready');
    }
    final get = RegExp(r'^/v1/media/(md\d+)$').firstMatch(path);
    if (req.method == 'GET' && get != null) return _json(200, {'media': created[get.group(1)], 'url': 'http://storage.test/bucket/${get.group(1)}?signed', 'expiresIn': 300});
    return null;
  }

  static http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});
}
