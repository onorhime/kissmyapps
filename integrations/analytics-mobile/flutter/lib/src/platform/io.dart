import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../client.dart';

/// Keeps each value in its own JSON file in [directory], replaced whole on each write.
KmaStorage? fileStorage(String directory) => FileStorage(directory);

/// Keeps each value in its own JSON file, replaced whole on each write so a crash mid-write
/// leaves the last good copy.
class FileStorage implements KmaStorage {
  /// Storage in [directory], created when first written to.
  FileStorage(this.directory);

  /// Where the files go.
  final String directory;

  // Writes run one at a time, in order.
  Future<void> _last = Future<void>.value();

  File _file(String name) => File('$directory/$name.json');

  @override
  Future<String?> read(String name) async {
    final file = _file(name);
    if (!await file.exists()) return null;
    return file.readAsString();
  }

  @override
  Future<void> write(String name, String value) {
    final next = _last.then((_) => _write(name, value));
    _last = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<void> _write(String name, String value) async {
    await Directory(directory).create(recursive: true);
    final temporary = File('$directory/$name.json.tmp');
    await temporary.writeAsString(value, flush: true);
    await temporary.rename(_file(name).path);
  }
}

final HttpClient _http = HttpClient()
  ..connectionTimeout = const Duration(seconds: 15)
  ..idleTimeout = const Duration(seconds: 30)
  ..userAgent = 'kma-flutter/$sdkVersion';

/// Posts [body] with dart:io; throws when there is no connection.
Future<KmaResponse> httpPost(Uri url, Map<String, String> headers, String body) async {
  final request = await _http.postUrl(url);
  headers.forEach(request.headers.set);
  request.add(utf8.encode(body));
  final response = await request.close().timeout(const Duration(seconds: 30));
  final text = await response
      .transform(const Utf8Decoder(allowMalformed: true))
      .join()
      .timeout(const Duration(seconds: 30));
  return KmaResponse(response.statusCode, text);
}
