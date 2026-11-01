import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';
import 'package:record/record.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';

/// A photo or recording on this phone, ready to upload.
class LocalMedia {
  LocalMedia({required this.bytes, required this.fileName, required this.contentType, this.durationMs});
  final Uint8List bytes;
  final String fileName;
  final String contentType;
  final int? durationMs;
}

/// The content type of a photo from its first bytes, or null if it isn't one the server takes.
/// The server checks the same signatures, so guessing from the file name would only fail later.
String? sniffImageType(Uint8List b) {
  bool ascii(int at, String s) => b.length >= at + s.length && String.fromCharCodes(b.sublist(at, at + s.length)) == s;
  if (b.length >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff) return 'image/jpeg';
  if (ascii(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp') && ['heic', 'heix', 'mif1', 'msf1'].any((brand) => ascii(8, brand))) return 'image/heic';
  return null;
}

/// The phone's photo library and microphone. Tests swap in [MediaDevices.instance].
abstract class MediaDevices {
  static MediaDevices instance = PlatformMediaDevices();

  /// Up to [limit] photos from the library; empty if the person picked none.
  Future<List<LocalMedia>> pickPhotos({int limit = 1});

  Future<VoiceRecording?> startVoice();
}

/// A voice note being recorded.
abstract class VoiceRecording {
  /// Stops and returns the recording, or null if nothing was captured.
  Future<LocalMedia?> stop();
  Future<void> cancel();
}

class PlatformMediaDevices implements MediaDevices {
  final _picker = ImagePicker();

  @override
  Future<List<LocalMedia>> pickPhotos({int limit = 1}) async {
    // Resized and re-encoded on the phone: smaller uploads, and camera metadata such as the
    // location isn't sent.
    final files = limit == 1
        ? [?(await _picker.pickImage(source: ImageSource.gallery, maxWidth: 2048, maxHeight: 2048, imageQuality: 85, requestFullMetadata: false))]
        : await _picker.pickMultiImage(maxWidth: 2048, maxHeight: 2048, imageQuality: 85, limit: limit, requestFullMetadata: false);
    final out = <LocalMedia>[];
    for (final f in files.take(limit)) {
      final bytes = await f.readAsBytes();
      final type = sniffImageType(bytes);
      if (type == null) throw const FormatException('That file isn’t a photo we can share (JPEG, PNG, GIF, WebP or HEIC).');
      out.add(LocalMedia(bytes: bytes, fileName: f.name, contentType: type));
    }
    return out;
  }

  @override
  Future<VoiceRecording?> startVoice() async {
    final rec = AudioRecorder();
    if (!await rec.hasPermission()) {
      await rec.dispose();
      return null;
    }
    final path = '${Directory.systemTemp.path}/voice-${DateTime.now().microsecondsSinceEpoch}.m4a';
    await rec.start(const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 64000, numChannels: 1), path: path);
    return _PlatformRecording(rec, path, DateTime.now());
  }
}

class _PlatformRecording implements VoiceRecording {
  _PlatformRecording(this._rec, this._path, this._started);
  final AudioRecorder _rec;
  final String _path;
  final DateTime _started;

  @override
  Future<LocalMedia?> stop() async {
    final path = await _rec.stop();
    await _rec.dispose();
    final file = File(path ?? _path);
    if (!await file.exists()) return null;
    final bytes = await file.readAsBytes();
    await file.delete();
    if (bytes.isEmpty) return null;
    return LocalMedia(bytes: bytes, fileName: 'voice-note.m4a', contentType: 'audio/mp4', durationMs: DateTime.now().difference(_started).inMilliseconds);
  }

  @override
  Future<void> cancel() async {
    await _rec.cancel();
    await _rec.dispose();
  }
}

/// Uploads straight to storage with the presigned URL from the API, then asks the API to
/// check it. Returns the stored media (its `id` is what gets attached to a message, post or story).
Future<Map<String, dynamic>> uploadMedia(AuthController auth, LocalMedia m, {required String kind}) async {
  final created = (await auth.authed('POST', '/v1/media/uploads', body: {
    'kind': kind,
    'contentType': m.contentType,
    'byteSize': m.bytes.length,
    'fileName': m.fileName,
    if (m.durationMs != null) 'durationMs': m.durationMs,
  }))!;
  final upload = created['upload'] as Map<String, dynamic>;
  await auth.api.putBytes(Uri.parse(upload['url'] as String), m.bytes, headers: (upload['headers'] as Map? ?? const {}).cast<String, String>());
  return (await auth.authed('POST', '/v1/media/${(created['media'] as Map<String, dynamic>)['id']}/complete'))!;
}

/// Why an upload failed, in words; the API's own message when it gave one.
String uploadError(Object e) => e is ApiException ? e.message : e is FormatException ? e.message : 'The upload didn’t go through. Try again.';
